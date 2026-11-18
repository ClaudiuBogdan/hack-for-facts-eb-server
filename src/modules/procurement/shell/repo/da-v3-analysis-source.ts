/**
 * Direct acquisitions release 1 — the analysis API's direct_acquisition grain
 * answered from procurement_v3 over Postgres (root's release-1 fallback until a
 * ClickHouse projection of procurement_v3 is published behind the same
 * interface; see `da-routing-analysis-repo.ts`).
 *
 * Population and money:
 * - recordCount: every purchase in scope (refused, expired and not-yet-
 *   qualified years included); withValue: the counted ones.
 * - valueAwardedSum: Σ counted_value of counted purchases (SQL numeric) — the
 *   data platform's counted value, lei excluding VAT. The reported value never
 *   enters a figure. No estimated, ceiling or modification money exists here.
 * - date basis: finalization_day; a purchase without one is undated.
 *
 * Dimensions: authority (valid buyer code), supplier (D6 below), CPV division,
 * group, class, category and code from category_code, buyer region, county and
 * SIRUTA through the same join shape the data platform uses for the legacy
 * facts (buyer code → core.public_entities, ONRC registered office fallback →
 * core.territories, public rows only). Supplier geography, status, procedure
 * type, record kind, framework role and title search are refused upstream
 * (routing) and again here.
 *
 * D6 (one rule, `da-v3-sql.ts`): a supplier is keyed and named only when its
 * code is public in supplier_privacy. Every withheld supplier is ONE key,
 * `natural_person`; a purchase without a supplier is the unknown bucket. A
 * supplierCui scope that is not public matches nothing.
 *
 * Consistency: every read is one read-only REPEATABLE READ snapshot that
 * re-reads da_release and refuses if the publication moved since the request
 * resolved its generation, so one answer never mixes two nightly publishes.
 * The generation's buildId is data_as_of in epoch microseconds; its quality
 * verdict is measured from procurement_v3 once per publication. Answers for
 * scopes with no authority or supplier are cached per publication.
 */

import { Decimal } from 'decimal.js';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  daV3Table,
  namedSupplierSql,
  probeSupplierPrivacy,
  supplierPrivacyJoin,
} from './da-v3-sql.js';
import {
  DA_NATURAL_PERSON_BUCKET,
  BASIS_ALLOW_FLOOR,
  COUNT_TIME_DEGRADE_FLOOR,
  TOPN_SIRUTA_MAX,
  type GenerationCapabilities,
  type MeasureId,
  type SeriesBucket,
} from '../../core/constants.js';

import type { AnalysisScope } from '../../core/analysis-scope.js';
import type { GrainQualityVerdict } from '../../core/gate-v2.js';
import type {
  ActiveGeneration,
  AnalysisBreakdownBucketRow,
  AnalysisRecordRow,
  AnalysisRepo,
  AnalysisStatsRead,
  ConcentrationRead,
} from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;
type Sql = RawBuilder<unknown>;

const PURCHASES = daV3Table('da_purchases');
const PARTIES = daV3Table('da_parties');
const RELEASE = daV3Table('da_release');

const STATEMENT_TIMEOUT_MS = 15_000;
/** The once-per-publication quality measurement scans the whole table. */
const QUALITY_TIMEOUT_MS = 120_000;
const CACHE_MAX_ENTRIES = 1000;

/** The key every withheld supplier shares (never a fiscal code: codes are digits). */
export const DA_V3_WITHHELD_SUPPLIER_KEY = DA_NATURAL_PERSON_BUCKET;

/** Attached to every direct-acquisition envelope this source answers. */
export const DA_V3_VALUE_NOTE =
  'direct acquisitions (release 1): money is the counted value, lei excluding VAT — a corrected value where an approved correction applies; purchases the data platform does not count (refused or expired, years not yet qualified, reviewed entry errors) are in recordCount and add no money; every withheld (natural-person) supplier is one supplier, key natural_person';

export const DA_V3_CAPABILITIES: GenerationCapabilities = {
  frameworkRole: false,
  supplierGeography: false,
  directAcquisitionV3: true,
};

/** The procurement_v3 direct-acquisition source: the DA reads of AnalysisRepo plus its own generation. */
export interface DaV3AnalysisSource {
  /** The DA grain's generation; null when the release holds no data yet. */
  generation(): Promise<Result<ActiveGeneration | null, ApiError>>;
  statsFor: AnalysisRepo['statsFor'];
  seriesFor: AnalysisRepo['seriesFor'];
  distinctSeriesFor: AnalysisRepo['distinctSeriesFor'];
  breakdownFor: AnalysisRepo['breakdownFor'];
  concentrationFor: AnalysisRepo['concentrationFor'];
  recordsFor: AnalysisRepo['recordsFor'];
}

// ── errors and snapshots ─────────────────────────────────────────────────────

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Direct acquisitions release 1 tables are not deployed.');
  if (code === '57014') return timeoutError('Direct acquisitions analysis read timed out.');
  return databaseError('Direct acquisitions analysis read failed', error);
};

const REPUBLISHED = (): ApiError =>
  serviceUnavailable(
    'direct-acquisition data was republished during this request; repeat the request'
  );

interface Ctx {
  readonly trx: Db;
  /** supplier_privacy exists in this snapshot (else every supplier is withheld). */
  readonly privacy: boolean;
}

/** `data_as_of` in epoch microseconds: digits, so a client can pin it as a build. */
const BUILD_ID_SQL = sql`(extract(epoch from max(data_as_of)) * 1000000)::bigint::text`;
const AS_OF_SQL = sql`to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const snapshot = async <T>(
  db: Db,
  timeoutMs: number,
  expectBuild: string | null,
  read: (ctx: Ctx) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  try {
    return await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        await sql`set local statement_timeout = ${sql.lit(timeoutMs)}`.execute(trx);
        if (expectBuild !== null) {
          const current = await sql<{ build_id: string | null }>`
            select ${BUILD_ID_SQL} as build_id from ${RELEASE}`.execute(trx);
          if (current.rows[0]?.build_id !== expectBuild) return err(REPUBLISHED());
        }
        const privacy = await probeSupplierPrivacy(trx);
        return read({ trx, privacy });
      });
  } catch (error) {
    return err(readError(error));
  }
};

// ── scope compilation ────────────────────────────────────────────────────────

const named = (ctx: Ctx): Sql => namedSupplierSql(ctx.privacy);

/** The buyer's attributed SIRUTA: administrative tier first, ONRC registered office second. */
const BUYER_SIRUTA = sql`coalesce(pe.territorial_siruta_code, areg.selected_uat_siruta_code)`;

const GEO_JOIN = sql`
  left join core.public_entities pe
    on pe.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
  left join companies_v2.registrations areg
    on areg.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
   and pe.territorial_siruta_code is null
  left join core.territories t
    on t.territorial_siruta_code = ${BUYER_SIRUTA} and t.privacy_class = 'public'`;

const fromSql = (ctx: Ctx, geo: boolean): Sql => sql`
  from ${PURCHASES} p
  left join ${PARTIES} b
    on b.source_name = p.source_name and b.party_kind = 'buyer'
   and b.portal_party_id = p.buyer_party_id
  left join ${PARTIES} s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id
  ${supplierPrivacyJoin(ctx.privacy)}
  ${geo ? GEO_JOIN : sql``}`;

/** Breakdown/facet key per dimension; null = the unknown bucket. */
const dimensionKey = (ctx: Ctx, dimension: string): Result<Sql, ApiError> => {
  const cpv8 = sql`p.category_code ~ '^[0-9]{8}'`;
  switch (dimension) {
    case 'authority':
      return ok(sql`case when b.fiscal_code_status = 'valid' then b.fiscal_code_clean end`);
    case 'supplier':
      return ok(sql`case when s.portal_party_id is null then null
        when ${named(ctx)} then s.fiscal_code_clean
        else ${DA_V3_WITHHELD_SUPPLIER_KEY} end`);
    case 'cpvDivision':
      return ok(sql`case when p.category_code ~ '^[0-9]{2}' then left(p.category_code, 2) end`);
    case 'cpvGroup':
      return ok(
        sql`case when ${cpv8} and substr(p.category_code, 3, 1) <> '0' then left(p.category_code, 3) || '00000' end`
      );
    case 'cpvClass':
      return ok(
        sql`case when ${cpv8} and substr(p.category_code, 4, 1) <> '0' then left(p.category_code, 4) || '0000' end`
      );
    case 'cpvCategory':
      return ok(
        sql`case when ${cpv8} and substr(p.category_code, 5, 1) <> '0' then left(p.category_code, 5) || '000' end`
      );
    case 'cpvCode':
      return ok(sql`case when ${cpv8} then left(p.category_code, 8) end`);
    case 'buyerRegion':
      return ok(sql`t.region`);
    case 'buyerCounty':
      return ok(sql`t.county_code`);
    case 'buyerSiruta':
      return ok(sql`t.territorial_siruta_code`);
    default:
      return err(
        invalidInput(
          `breakdown(${dimension}) is not available for direct acquisitions in release 1`,
          'dimension'
        )
      );
  }
};

const GEO_DIMENSIONS = new Set(['buyerRegion', 'buyerCounty', 'buyerSiruta']);

interface Compiled {
  /** Rows of the scope: dims AND (dated window OR undated). */
  readonly where: Sql;
  /** Rows that feed the dated (period) aggregates. */
  readonly dated: Sql;
  readonly bounded: boolean;
  readonly geo: boolean;
}

/** Scope fields this source refuses outright (routing refuses them first). */
const REFUSED_SCOPE: readonly (readonly [keyof AnalysisScope, string])[] = [
  ['q', 'title search is not available for direct acquisitions: free text is withheld'],
  ['supplierRegion', 'supplier geography is not available for direct acquisitions'],
  ['supplierCounty', 'supplier geography is not available for direct acquisitions'],
  ['supplierSiruta', 'supplier geography is not available for direct acquisitions'],
  ['status', 'status is not available for direct acquisitions in release 1'],
  ['procedureType', 'direct acquisitions have no procedure type'],
  ['recordKind', 'record kind exists only on contracts'],
  ['frameworkRole', 'framework role exists only on contracts'],
];

const CPV_PREFIXES = [
  ['cpvGroup', 3],
  ['cpvClass', 4],
  ['cpvCategory', 5],
] as const;

const compile = (
  ctx: Ctx,
  scope: AnalysisScope,
  dimension?: string
): Result<Compiled, ApiError> => {
  for (const [field, message] of REFUSED_SCOPE)
    if (scope[field] !== undefined) return err(invalidInput(message, field));
  const conds: Sql[] = [];
  if (scope.authorityCui !== undefined)
    conds.push(sql`b.fiscal_code_clean = ${scope.authorityCui} and b.fiscal_code_status = 'valid'`);
  if (scope.supplierCui !== undefined)
    conds.push(sql`s.fiscal_code_clean = ${scope.supplierCui} and ${named(ctx)}`);
  if (scope.cpvDivision !== undefined)
    conds.push(sql`left(p.category_code, 2) = ${scope.cpvDivision}`);
  for (const [field, length] of CPV_PREFIXES) {
    const value = scope[field];
    if (value !== undefined)
      conds.push(sql`left(p.category_code, ${length}) = ${value.slice(0, length)}`);
  }
  if (scope.cpvCode !== undefined) conds.push(sql`left(p.category_code, 8) = ${scope.cpvCode}`);
  let geo = dimension !== undefined && GEO_DIMENSIONS.has(dimension);
  if (scope.buyerRegion !== undefined) {
    geo = true;
    conds.push(sql`t.region = ${scope.buyerRegion}`);
  }
  if (scope.buyerCounty !== undefined) {
    geo = true;
    conds.push(sql`t.county_code = ${scope.buyerCounty}`);
  }
  if (scope.buyerSiruta !== undefined) {
    geo = true;
    // SIRUTA codes are digits; anything else can never match.
    conds.push(
      /^\d{1,7}$/u.test(scope.buyerSiruta)
        ? sql`t.territorial_siruta_code = ${String(Number(scope.buyerSiruta))}`
        : sql`false`
    );
  }
  // Value bounds restrict the rows to counted purchases whose counted value is in range.
  if (scope.valueMin !== undefined || scope.valueMax !== undefined) {
    conds.push(sql`p.counted`);
    if (scope.valueMin !== undefined)
      conds.push(sql`p.counted_value >= ${String(scope.valueMin)}::numeric`);
    if (scope.valueMax !== undefined)
      conds.push(sql`p.counted_value <= ${String(scope.valueMax)}::numeric`);
  }
  const bounds: Sql[] = [];
  if (scope.year !== undefined) {
    bounds.push(sql`p.finalization_day >= ${`${String(scope.year)}-01-01`}::date`);
    bounds.push(sql`p.finalization_day < ${`${String(scope.year + 1)}-01-01`}::date`);
  } else {
    if (scope.from !== undefined)
      bounds.push(sql`p.finalization_day >= ${`${scope.from}-01`}::date`);
    if (scope.to !== undefined)
      bounds.push(sql`p.finalization_day < (${`${scope.to}-01`}::date + interval '1 month')`);
  }
  const bounded = bounds.length > 0;
  const dated = bounded
    ? sql`(p.finalization_day is not null and ${sql.join(bounds, sql` and `)})`
    : sql`true`;
  conds.push(sql`(${dated} or p.finalization_day is null)`);
  return ok({ where: sql.join(conds, sql` and `), dated, bounded, geo });
};

// ── shared aggregates ────────────────────────────────────────────────────────

/**
 * Σ counted value over `pred`, NULL when no counted row matches (the null law).
 * Exact: counted_value is unconstrained numeric, so nothing is rounded before it is
 * summed or compared (rounding per bucket made series, stats and remainders disagree).
 */
const countedSum = (pred: Sql): Sql =>
  sql`case when count(*) filter (where ${pred} and p.counted) = 0 then null
    else (sum(p.counted_value) filter (where ${pred} and p.counted))::text end`;

interface StatsRow {
  rows: string;
  with_value: string;
  awarded: string | null;
  min_month: string | null;
  max_month: string | null;
  undated_count: string;
  undated_value: string | null;
}

const statsSelect = (c: Compiled): Sql => sql`
  count(*) filter (where ${c.dated})::text as rows,
  count(*) filter (where ${c.dated} and p.counted)::text as with_value,
  ${countedSum(c.dated)} as awarded,
  to_char(min(p.finalization_day) filter (where ${c.dated} and p.finalization_day is not null), 'YYYY-MM') as min_month,
  to_char(max(p.finalization_day) filter (where ${c.dated} and p.finalization_day is not null), 'YYYY-MM') as max_month,
  count(*) filter (where p.finalization_day is null)::text as undated_count,
  ${countedSum(sql`p.finalization_day is null`)} as undated_value`;

const toStats = (row: StatsRow | undefined): AnalysisStatsRead => ({
  rows: row?.rows ?? '0',
  withValue: row?.with_value ?? '0',
  withEstimated: '0',
  valueAwardedSum: row?.awarded ?? null,
  valueEstimatedSum: null,
  valueCeilingSum: null,
  valueModAdjustedSum: null,
  valueAwardedMatchedSum: null,
  minMonth: row?.min_month ?? null,
  maxMonth: row?.max_month ?? null,
  undatedCount: row?.undated_count ?? '0',
  undatedValueRon: row?.undated_value ?? null,
  valueWithheldAssociationSum: null,
});

const readStats = async (ctx: Ctx, c: Compiled): Promise<AnalysisStatsRead> => {
  const result = await sql<StatsRow>`
    select ${statsSelect(c)} ${fromSql(ctx, c.geo)} where ${c.where}`.execute(ctx.trx);
  return toStats(result.rows[0]);
};

const BUCKET_SQL: Record<SeriesBucket, Sql> = {
  month: sql`to_char(p.finalization_day, 'YYYY-MM')`,
  quarter: sql`to_char(p.finalization_day, 'YYYY') || '-Q' || extract(quarter from p.finalization_day)::int::text`,
  year: sql`to_char(p.finalization_day, 'YYYY')`,
};

const datedHaving = (c: Compiled): Sql =>
  c.bounded ? sql`having count(*) filter (where ${c.dated}) > 0` : sql``;

/** A bucket's counted money, exact; '0.00' when none (the ClickHouse bucket convention). */
const bucketSum = (pred: Sql): Sql =>
  sql`coalesce((sum(p.counted_value) filter (where ${pred} and p.counted))::text, '0.00')`;

/** Exact decimal text for the breakdown's `other` remainder: totals − top − unknown. */
const minus = (total: string | null, parts: readonly string[]): string =>
  parts.reduce((acc, part) => acc.minus(part), new Decimal(total ?? '0')).toFixed();

const UNFILTERED = (scope: AnalysisScope): boolean =>
  scope.authorityCui === undefined && scope.supplierCui === undefined;

// ── the source ───────────────────────────────────────────────────────────────

export const makeDaV3AnalysisSource = (db: Db, logger?: Logger): DaV3AnalysisSource => {
  const qualityByBuild = new Map<string, Promise<Result<GrainQualityVerdict, ApiError>>>();
  let cacheBuild: string | null = null;
  const cache = new Map<string, Result<unknown, ApiError>>();

  /** Unfiltered (no authority/supplier) answers are cached per publication; others run live. */
  /**
   * The publication and privacy state RIGHT NOW (one statement): an entry is
   * reused, and stored, only while the build is current and supplier_privacy is
   * readable, checked before the lookup AND after the fill. A race can only make
   * an answer more withheld than needed, never leak a name.
   */
  const cacheable = async (build: string): Promise<boolean> => {
    try {
      const probe = await sql<{ build_id: string | null }>`
        select ${BUILD_ID_SQL} as build_id from ${RELEASE}`.execute(db);
      return probe.rows[0]?.build_id === build && (await probeSupplierPrivacy(db));
    } catch {
      return false;
    }
  };

  const cached = async <T>(
    build: string,
    scope: AnalysisScope,
    key: unknown,
    load: () => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>> => {
    if (!UNFILTERED(scope)) return load();
    if (!(await cacheable(build))) return load();
    if (cacheBuild !== build) {
      cache.clear();
      cacheBuild = build;
    }
    const cacheKey = JSON.stringify([key, scope]);
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit as Result<T, ApiError>;
    const result = await load();
    if (result.isOk() && (await cacheable(build))) {
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(cacheKey, result);
    }
    return result;
  };

  /** Coverage measured from procurement_v3 once per publication (row share and counted-money share). */
  const measureQuality = (build: string): Promise<Result<GrainQualityVerdict, ApiError>> => {
    const known = qualityByBuild.get(build);
    if (known !== undefined) return known;
    const promise = snapshot(db, QUALITY_TIMEOUT_MS, build, async (ctx) => {
      const result = await sql<{
        total: string;
        dated: string;
        counted: string;
        accepted: string;
        with_cpv: string;
        with_geo: string;
        money: string | null;
        money_dated: string | null;
        money_geo: string | null;
      }>`
        with per_buyer as (
          select p.source_name, p.buyer_party_id,
                 count(*) as n,
                 count(*) filter (where p.finalization_day is not null) as dated,
                 count(*) filter (where p.counted) as counted,
                 count(*) filter (where p.outcome = 'accepted') as accepted,
                 count(*) filter (where p.category_code ~ '^[0-9]{2}') as with_cpv,
                 coalesce(sum(p.counted_value) filter (where p.counted), 0) as money,
                 coalesce(sum(p.counted_value) filter (where p.counted and p.finalization_day is not null), 0) as money_dated
          from ${PURCHASES} p
          group by p.source_name, p.buyer_party_id
        )
        select sum(pb.n)::text as total, sum(pb.dated)::text as dated,
               sum(pb.counted)::text as counted, sum(pb.accepted)::text as accepted,
               sum(pb.with_cpv)::text as with_cpv,
               coalesce(sum(pb.n) filter (where t.territorial_siruta_code is not null), 0)::text as with_geo,
               sum(pb.money)::text as money, sum(pb.money_dated)::text as money_dated,
               coalesce(sum(pb.money) filter (where t.territorial_siruta_code is not null), 0)::text as money_geo
        from per_buyer pb
        left join ${PARTIES} b
          on b.source_name = pb.source_name and b.party_kind = 'buyer'
         and b.portal_party_id = pb.buyer_party_id
        ${GEO_JOIN}`.execute(ctx.trx);
      const row = result.rows[0];
      const total = new Decimal(row?.total ?? '0');
      const ratio = (part: string | null | undefined, whole: Decimal): number =>
        whole.isZero() ? 0 : new Decimal(part ?? '0').div(whole).toDecimalPlaces(4).toNumber();
      const money = new Decimal(row?.money ?? '0');
      const date = ratio(row?.dated, total);
      const geo = ratio(row?.with_geo, total);
      const cls = (coverage: number): 'allow' | 'degraded' | 'abstain' =>
        coverage >= BASIS_ALLOW_FLOOR
          ? 'allow'
          : coverage >= COUNT_TIME_DEGRADE_FLOOR
            ? 'degraded'
            : 'abstain';
      return ok({
        coverage: {
          date,
          // Informational: counted share of accepted purchases (pre-2025 years are not yet qualified).
          value: ratio(row?.counted, new Decimal(row?.accepted ?? '0')),
          geo,
          cpv: ratio(row?.with_cpv, total),
        },
        coverage_money: {
          date: ratio(row?.money_dated, money),
          geo: ratio(row?.money_geo, money),
        },
        // Money is the data platform's counted value: which purchases count is the
        // platform's reviewed rule, so the counted sum is served, never gated on coverage.
        classes: { spend: 'allow', time: cls(date), geo: cls(geo) },
      } satisfies GrainQualityVerdict);
    }).then((result) => {
      if (result.isErr()) {
        qualityByBuild.delete(build);
        logger?.warn(
          { build, error: result.error.message },
          'direct-acquisition quality read failed'
        );
      }
      return result;
    });
    qualityByBuild.set(build, promise);
    return promise;
  };

  const generation: DaV3AnalysisSource['generation'] = async () => {
    const release = await snapshot(db, STATEMENT_TIMEOUT_MS, null, async (ctx) => {
      const result = await sql<{ build_id: string | null; as_of: string | null }>`
        select ${BUILD_ID_SQL} as build_id, ${AS_OF_SQL} as as_of from ${RELEASE}`.execute(ctx.trx);
      return ok(result.rows[0] ?? null);
    });
    if (release.isErr()) return err(release.error);
    const build = release.value?.build_id ?? null;
    if (build === null || release.value?.as_of == null) return ok(null);
    const quality = await measureQuality(build);
    return ok({
      buildId: build,
      publishedAt: release.value.as_of,
      matrixHash: null,
      // No verdict when coverage could not be measured: time/geo/money then abstain (fail closed).
      quality: quality.isOk() ? { direct_acquisition: quality.value } : {},
      capabilities: DA_V3_CAPABILITIES,
      notes: [DA_V3_VALUE_NOTE],
    });
  };

  const statsFor: DaV3AnalysisSource['statsFor'] = (_route, scope, gen) =>
    cached(gen.buildId, scope, ['stats'], () =>
      snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
        const c = compile(ctx, scope);
        if (c.isErr()) return err(c.error);
        return ok(await readStats(ctx, c.value));
      })
    );

  const seriesFor: DaV3AnalysisSource['seriesFor'] = (_route, scope, gen, measure) =>
    cached(gen.buildId, scope, ['series', measure], () =>
      snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
        const c = compile(ctx, scope);
        if (c.isErr()) return err(c.error);
        const dated = sql`p.finalization_day is not null`;
        const valueOf: Partial<Record<MeasureId, Sql>> = {
          recordCount: sql`count(*) filter (where ${dated})::text`,
          withValueCount: sql`count(*) filter (where ${dated} and p.counted)::text`,
          valueAwardedSum: countedSum(dated),
        };
        const value = valueOf[measure];
        if (value === undefined)
          return err(
            invalidInput(
              `series measure '${measure}' is not served for direct acquisitions`,
              'measure'
            )
          );
        const result = await sql<{
          month: string | null;
          value: string | null;
          record_count: string;
          with_value: string;
          awarded: string | null;
        }>`
          select to_char(p.finalization_day, 'YYYY-MM') as month,
                 ${value} as value,
                 count(*)::text as record_count,
                 count(*) filter (where p.counted)::text as with_value,
                 ${countedSum(sql`true`)} as awarded
          ${fromSql(ctx, c.value.geo)}
          where ${c.value.where}
          group by 1
          order by 1 asc nulls last`.execute(ctx.trx);
        return ok(
          result.rows.map((row) => ({
            month: row.month,
            value: row.value,
            recordCount: row.record_count,
            withValue: row.with_value,
            valueAwardedSum: row.awarded,
          }))
        );
      })
    );

  const distinctSeriesFor: DaV3AnalysisSource['distinctSeriesFor'] = (
    _route,
    scope,
    gen,
    key,
    bucket
  ) =>
    cached(gen.buildId, scope, ['distinct', key, bucket], () =>
      snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
        const c = compile(ctx, scope);
        if (c.isErr()) return err(c.error);
        const keyExpr = dimensionKey(ctx, key === 'supplier' ? 'supplier' : 'authority');
        if (keyExpr.isErr()) return err(keyExpr.error);
        const result = await sql<{
          bucket: string | null;
          value: string;
          record_count: string;
          with_value: string;
          awarded: string | null;
        }>`
          select ${BUCKET_SQL[bucket]} as bucket,
                 count(distinct ${keyExpr.value})::text as value,
                 count(*)::text as record_count,
                 count(*) filter (where p.counted)::text as with_value,
                 ${countedSum(sql`true`)} as awarded
          ${fromSql(ctx, c.value.geo)}
          where ${c.value.where}
          group by 1
          order by 1 asc nulls last`.execute(ctx.trx);
        return ok(
          result.rows.map((row) => ({
            bucket: row.bucket,
            value: row.value,
            recordCount: row.record_count,
            withValue: row.with_value,
            valueAwardedSum: row.awarded,
          }))
        );
      })
    );

  const breakdownFor: DaV3AnalysisSource['breakdownFor'] = (
    _route,
    scope,
    gen,
    dimension,
    topN,
    rankBy
  ) =>
    cached(gen.buildId, scope, ['breakdown', dimension, topN, rankBy], () =>
      snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
        const c = compile(ctx, scope, dimension);
        if (c.isErr()) return err(c.error);
        const keyR = dimensionKey(ctx, dimension);
        if (keyR.isErr()) return err(keyR.error);
        const key = keyR.value;
        const totals = await readStats(ctx, c.value);
        const from = fromSql(ctx, c.value.geo);
        const { dated, where } = c.value;
        const unknownR = await sql<{ cnt: string; wv: string; awarded: string }>`
          select count(*) filter (where ${dated})::text as cnt,
                 count(*) filter (where ${dated} and p.counted)::text as wv,
                 ${bucketSum(dated)} as awarded
          ${from}
          where ${where} and (${key}) is null`.execute(ctx.trx);
        const unknown = unknownR.rows[0] ?? { cnt: '0', wv: '0', awarded: '0.00' };
        const valueBearing = BigInt(totals.withValue) - BigInt(unknown.wv);
        const rankedBy: 'value' | 'count' =
          rankBy === 'value' && valueBearing > 0n ? 'value' : 'count';
        const rank =
          rankedBy === 'value'
            ? sql`coalesce(sum(p.counted_value) filter (where ${dated} and p.counted), 0)`
            : sql`count(*) filter (where ${dated})`;
        const top = await sql<{ key: string; cnt: string; wv: string; awarded: string }>`
          select ${key} as key,
                 count(*) filter (where ${dated})::text as cnt,
                 count(*) filter (where ${dated} and p.counted)::text as wv,
                 ${bucketSum(dated)} as awarded
          ${from}
          where ${where} and (${key}) is not null
          group by 1
          ${datedHaving(c.value)}
          order by ${rank} desc, 1 asc
          limit ${Math.max(1, Math.min(topN, TOPN_SIRUTA_MAX))}`.execute(ctx.trx);
        let otherCnt = BigInt(totals.rows) - BigInt(unknown.cnt);
        let otherWv = BigInt(totals.withValue) - BigInt(unknown.wv);
        const buckets: AnalysisBreakdownBucketRow[] = [];
        for (const row of top.rows) {
          buckets.push({
            kind: 'top',
            key: row.key,
            recordCount: row.cnt,
            withValue: row.wv,
            valueAwardedSum: row.awarded,
          });
          otherCnt -= BigInt(row.cnt);
          otherWv -= BigInt(row.wv);
        }
        buckets.push({
          kind: 'other',
          key: null,
          recordCount: otherCnt.toString(),
          withValue: otherWv.toString(),
          valueAwardedSum: minus(totals.valueAwardedSum, [
            unknown.awarded,
            ...top.rows.map((row) => row.awarded),
          ]),
        });
        buckets.push({
          kind: 'unknown',
          key: null,
          recordCount: unknown.cnt,
          withValue: unknown.wv,
          valueAwardedSum: unknown.awarded,
        });
        return ok({ buckets, totals, rankedBy });
      })
    );

  const concentrationFor: DaV3AnalysisSource['concentrationFor'] = (_route, scope, gen, basis) =>
    cached(gen.buildId, scope, ['concentration', basis], () =>
      snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
        const c = compile(ctx, scope, 'supplier');
        if (c.isErr()) return err(c.error);
        const keyR = dimensionKey(ctx, 'supplier');
        if (keyR.isErr()) return err(keyR.error);
        const totals = await readStats(ctx, c.value);
        const { dated, where } = c.value;
        const measure =
          basis === 'value'
            ? sql`coalesce(sum(p.counted_value) filter (where ${dated} and p.counted), 0)`
            : sql`count(*) filter (where ${dated})`;
        // Exact: no rounding before core computes shares and HHI.
        const fmt = (x: Sql) => sql`coalesce(${x}, 0)::text`;
        const result = await sql<{
          supplier_count: string;
          positive: string;
          total: string;
          top1: string;
          top5: string;
          squares: string;
          unknown: string | null;
        }>`
          with g as (
            select ${keyR.value} as key, ${measure} as m
            ${fromSql(ctx, c.value.geo)}
            where ${where}
            group by 1
            ${datedHaving(c.value)}
          ), pos as (select m from g where key is not null and m > 0)
          select (select count(*) from g where key is not null)::text as supplier_count,
                 (select count(*) from pos)::text as positive,
                 ${fmt(sql`(select sum(m) from pos)`)} as total,
                 ${fmt(sql`(select max(m) from pos)`)} as top1,
                 ${fmt(sql`(select sum(m) from (select m from pos order by m desc limit 5) x)`)} as top5,
                 ${fmt(sql`(select sum(m * m) from pos)`)} as squares,
                 (select sum(m)::text from g where key is null) as unknown`.execute(ctx.trx);
        const row = result.rows[0];
        if (row === undefined) return err(databaseError('concentration returned no row'));
        const count = Number(row.supplier_count);
        const positive = Number(row.positive);
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(positive))
          return err(databaseError('concentration supplier count is not an exact integer'));
        const unknownIsZero = row.unknown === null || new Decimal(row.unknown).isZero();
        return ok({
          supplierCount: count,
          positiveSupplierCount: positive,
          measureTotal: row.total,
          top1Measure: row.top1,
          top5Measure: row.top5,
          measureSquaredSum: row.squares,
          totals,
          unknownSupplierMeasure: unknownIsZero ? null : row.unknown,
        } satisfies ConcentrationRead);
      })
    );

  const recordsFor: DaV3AnalysisSource['recordsFor'] = (_route, scope, gen, page) =>
    snapshot(db, STATEMENT_TIMEOUT_MS, gen.buildId, async (ctx) => {
      const c = compile(ctx, scope);
      if (c.isErr()) return err(c.error);
      const money = sql`case when p.counted then p.counted_value end`;
      const order: Record<typeof page.sort, Sql> = {
        date_desc: sql`p.finalization_day is null asc, p.finalization_day desc, p.purchase_id desc`,
        date_asc: sql`p.finalization_day is null asc, p.finalization_day asc, p.purchase_id asc`,
        value_desc: sql`${money} desc nulls last, p.purchase_id desc`,
        value_asc: sql`${money} asc nulls last, p.purchase_id asc`,
      };
      const where = sql`${c.value.where} and ${c.value.dated}`;
      const from = fromSql(ctx, c.value.geo);
      const isNamed = named(ctx);
      const rows = await sql<{
        id: string;
        date: string | null;
        authority_cui: string | null;
        authority_name: string | null;
        supplier_cui: string | null;
        supplier_name: string | null;
        supplier_display_kind: 'company' | 'natural_person' | null;
        value_ron: string | null;
        status: string | null;
        cpv_code: string | null;
        cpv_label: string | null;
      }>`
        select p.purchase_id as id,
               p.finalization_day::text as date,
               case when b.fiscal_code_status = 'valid' then b.fiscal_code_clean end as authority_cui,
               b.name_as_written as authority_name,
               case when ${isNamed} then s.fiscal_code_clean end as supplier_cui,
               case when ${isNamed} then s.name_as_written end as supplier_name,
               case when s.portal_party_id is null then null
                    when ${isNamed} then 'company' else 'natural_person' end as supplier_display_kind,
               (${money})::text as value_ron,
               p.outcome as status,
               case when p.category_code ~ '^[0-9]{8}' then left(p.category_code, 8) end as cpv_code,
               p.category_as_written as cpv_label
        ${from}
        where ${where}
        order by ${order[page.sort]}
        limit ${page.limit} offset ${page.offset}`.execute(ctx.trx);
      const total = await sql<{ total: string }>`
        select count(*)::text as total ${from} where ${where}`.execute(ctx.trx);
      return ok({
        total: total.rows[0]?.total ?? '0',
        rows: rows.rows.map((row): AnalysisRecordRow => ({
          id: row.id,
          date: row.date,
          // Free text is withheld until reviewed: the CPV label stands in the title's place.
          title: null,
          authorityCui: row.authority_cui,
          authorityName: row.authority_name,
          supplierCui: row.supplier_cui,
          supplierName: row.supplier_name,
          supplierDisplayKind: row.supplier_display_kind,
          valueRon: row.value_ron,
          status: row.status,
          recordKind: null,
          cpvCode: row.cpv_code,
          cpvLabel: row.cpv_label,
        })),
      });
    });

  return {
    generation,
    statsFor,
    seriesFor,
    distinctSeriesFor,
    breakdownFor,
    concentrationFor,
    recordsFor,
  };
};
