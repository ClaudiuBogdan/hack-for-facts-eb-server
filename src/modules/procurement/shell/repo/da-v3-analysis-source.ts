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
 * code is disclosed (a public party row, with supplier_disclosure readable).
 * Every withheld supplier is ONE key, `natural_person`; a purchase without a
 * supplier is the unknown bucket. A supplierCui scope that is not public
 * matches nothing. Supplier names come from party_public_names, by code.
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
  withoutLeadingZeros,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  DA_PARTIES_PUBLIC,
  DA_RELEASE_SCHEMA,
  daV3Table,
  namedSupplierSql,
  probeSupplierDisclosure,
  purchaseParties,
  SUPPLIER_DISCLOSURE,
  SUPPLIER_DISCLOSURE_NAME,
  supplierNamesByCode,
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
const PARTIES = DA_PARTIES_PUBLIC;
const RELEASE = daV3Table('da_release');
const PRIVACY_TABLE = SUPPLIER_DISCLOSURE;

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
  // Insufficient privilege (e.g. the geography fallback's kernel tables, outside the API's
  // grant, read only when da_buyer_geography is not readable): not served.
  if (code === '42501')
    return serviceUnavailable('Direct acquisitions data is not readable by this API.');
  if (code === '57014') return timeoutError('Direct acquisitions analysis read timed out.');
  return databaseError('Direct acquisitions analysis read failed', error);
};

const REPUBLISHED = (): ApiError =>
  serviceUnavailable(
    'direct-acquisition data was republished during this request; repeat the request'
  );

interface Ctx {
  readonly trx: Db;
  /** supplier_disclosure is readable in this snapshot (else every supplier is withheld). */
  readonly privacy: boolean;
  /** The rollup tables this login can read in this snapshot (absent: read live). */
  readonly rollups: ReadonlySet<string>;
}

/** Which rollups exist and are readable: absent ones are read live, so nothing depends on them. */
/**
 * The readable rollups. A supplier-keyed rollup counts only on the supplier_ref
 * schema: it must carry `supplier_ref` and supplier_disclosure its `supplier_id`.
 * A table still on an earlier shape is skipped, so those reads stay live.
 */
const probeRollups = async (trx: Db): Promise<ReadonlySet<string>> => {
  const names = [...DA_V3_ROLLUPS.map((r) => r.table), 'da_rollup_distinct', BUYER_GEOGRAPHY];
  const supplierKeyed = DA_V3_ROLLUPS.filter((r) => r.keys.includes('supplier')).map(
    (r) => r.table
  );
  const schema = `${DA_RELEASE_SCHEMA}.`;
  const hasColumn = (table: Sql, column: string) => sql`exists (
      select 1 from pg_attribute a
      where a.attrelid = ${table} and a.attname = ${column} and a.attnum > 0 and not a.attisdropped)`;
  const result = await sql<{ name: string }>`
    select n as name from unnest(${names}::text[]) n
    where coalesce(has_table_privilege(to_regclass(${schema} || n), 'SELECT'), false)
      and (not (n = any(${supplierKeyed}::text[]))
           or (${hasColumn(sql`to_regclass(${schema} || n)`, 'supplier_ref')}
               and ${hasColumn(sql`to_regclass(${SUPPLIER_DISCLOSURE_NAME})`, 'supplier_id')}))`.execute(
    trx
  );
  return new Set(result.rows.map((row) => row.name));
};

/** `data_as_of` in epoch microseconds: digits, so a client can pin it as a build. */
const BUILD_ID_SQL = sql`(extract(epoch from max(data_as_of)) * 1000000)::bigint::text`;
const AS_OF_SQL = sql`to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Filled by a read's snapshot: whether supplier_disclosure was readable (names possible). */
interface ReadSeen {
  privacy: boolean;
}

const snapshot = async <T>(
  db: Db,
  timeoutMs: number,
  expectBuild: string | null,
  read: (ctx: Ctx) => Promise<Result<T, ApiError>>,
  seen?: ReadSeen
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
        const privacy = await probeSupplierDisclosure(trx);
        if (seen !== undefined) seen.privacy = privacy;
        const rollups = await probeRollups(trx);
        return read({ trx, privacy, rollups });
      });
  } catch (error) {
    return err(readError(error));
  }
};

// ── facts: live rows or a publish-time rollup ───────────────────────────────

/** The buyer's attributed SIRUTA: administrative tier first, ONRC registered office second. */
const BUYER_SIRUTA = sql`coalesce(pe.territorial_siruta_code, areg.selected_uat_siruta_code)`;

/**
 * The buyer's place pinned to the DA publication (procurement_v3.da_buyer_geography,
 * built from GEO_JOIN in the publish transaction, like the rollups). When it is
 * readable the live reads join it, so live and rollup answers place a buyer the
 * same way; otherwise they join today's kernel geography.
 */
const BUYER_GEOGRAPHY = 'da_buyer_geography';
const PINNED_GEO_JOIN = sql`
  left join ${daV3Table(BUYER_GEOGRAPHY)} t
    on t.authority_cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'`;
const geoJoin = (ctx: Ctx): Sql => (ctx.rollups.has(BUYER_GEOGRAPHY) ? PINNED_GEO_JOIN : GEO_JOIN);

const GEO_JOIN = sql`
  left join core.public_entities pe
    on pe.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
  left join companies_v2.registrations areg
    on areg.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
   and pe.territorial_siruta_code is null
  left join core.territories t
    on t.territorial_siruta_code = ${BUYER_SIRUTA} and t.privacy_class = 'public'`;

/** The key columns a rollup carries (beyond month). */
type RollupKey = 'authority' | 'supplier' | 'cpv' | 'county';

/**
 * The publish-time rollups (procurement_v3, built by the data platform in the
 * data_as_of transaction, so one snapshot sees facts and rollups of one
 * publication). Each row holds purchases, counted_purchases, counted_value and
 * symbolic_purchases for its keys and month; a supplier is an opaque
 * supplier_ref (supplier_privacy.supplier_id, 0 = withheld), never a code (NULL month = undated); every
 * purchase lands in exactly one row of each table, so every table sums to the
 * whole release. Smallest first: a read uses the first that covers it.
 */
export const DA_V3_ROLLUPS: readonly {
  readonly table: string;
  readonly keys: readonly RollupKey[];
}[] = [
  { table: 'da_rollup_county_month', keys: ['county'] },
  { table: 'da_rollup_cpv_month', keys: ['cpv'] },
  { table: 'da_rollup_authority_month', keys: ['authority'] },
  { table: 'da_rollup_county_cpv_month', keys: ['county', 'cpv'] },
  { table: 'da_rollup_supplier_month', keys: ['supplier'] },
  { table: 'da_rollup_supplier_cpv_month', keys: ['supplier', 'cpv'] },
  { table: 'da_rollup_authority_supplier_month', keys: ['authority', 'supplier', 'county'] },
];
const DISTINCT_ROLLUP = 'da_rollup_distinct';

/**
 * One way of reading the facts. The live form counts purchase rows; a rollup
 * form sums the measures of pre-aggregated rows. Every aggregate a read emits
 * goes through these, so one compiler serves both and they cannot drift.
 */
interface Facts {
  /** The rollup table, or null for the live purchase rows. */
  readonly rollup: string | null;
  readonly from: Sql;
  /** The date column windows and buckets read (finalization_day, or the rollup month). */
  readonly day: Sql;
  /** Rows of the facts that exist (a rollup's zeroed rows never count). */
  readonly base: Sql | null;
  /** Purchases matching `pred`. */
  rows(pred: Sql): Sql;
  /** Counted purchases matching `pred`. */
  counted(pred: Sql): Sql;
  /** Σ counted value of counted purchases matching `pred` (NULL when none summed). */
  money(pred: Sql): Sql;
  readonly authority: Sql;
  /** Rows of one buyer code. */
  authorityScope(code: string): Sql;
  /** The supplier's key: public code, natural_person, or NULL (no supplier). */
  readonly supplierKey: Sql;
  /** True when the supplier is named under D6 (it has a public party row). */
  readonly supplierNamed: Sql;
  /** Rows of one supplier code, only while it is public. */
  supplierScope(code: string): Sql;
  /** The category code the CPV levels are cut from. */
  readonly cpv: Sql;
  readonly county: Sql;
  readonly region: Sql;
}

/** The purchases of one valid party code, as (source_name, party id) pairs. */
const partyIds = (kind: 'buyer' | 'supplier', column: Sql, code: string): Sql =>
  sql`(p.source_name, ${column}) in (select pp.source_name, pp.portal_party_id from ${PARTIES} pp
      where pp.party_kind = ${kind} and pp.fiscal_code_status = 'valid' and pp.fiscal_code_clean = ${code})`;

/**
 * The live rows. `pointReads` (a records page: a few rows by an index order) probes each row's
 * parties through fenced lateral subqueries; aggregates join the view plainly (see
 * `publicPartyLateral`).
 */
const liveFacts = (ctx: Ctx, geo: boolean, pointReads = false): Facts => {
  const named = namedSupplierSql(ctx.privacy);
  return {
    rollup: null,
    from: sql`
  from ${PURCHASES} p
  ${purchaseParties(pointReads)}
  ${geo ? geoJoin(ctx) : sql``}`,
    day: sql`p.finalization_day`,
    base: null,
    rows: (pred) => sql`count(*) filter (where ${pred})`,
    counted: (pred) => sql`count(*) filter (where ${pred} and p.counted)`,
    money: (pred) => sql`sum(p.counted_value) filter (where ${pred} and p.counted)`,
    authority: sql`case when b.fiscal_code_status = 'valid' then b.fiscal_code_clean end`,
    authorityScope: (code) => partyIds('buyer', sql`p.buyer_party_id`, code),
    // A withheld supplier has no public row: "no supplier" is the purchase's own null id.
    supplierKey: sql`case when p.supplier_party_id is null then null
        when ${named} then s.fiscal_code_clean
        else ${DA_V3_WITHHELD_SUPPLIER_KEY} end`,
    supplierNamed: named,
    // By party ids, so the planner reaches the purchases through the party index instead of
    // reading a year of purchases and filtering on the joined party row (measured 18 Nov). A
    // supplier's public party row exists only when D6 names it, so the match IS the D6 test
    // (no per-row probe of `s`); with supplier_disclosure unreadable nothing matches.
    supplierScope: (code) =>
      ctx.privacy ? partyIds('supplier', sql`p.supplier_party_id`, code) : sql`false`,
    cpv: sql`p.category_code`,
    county: sql`t.county_code`,
    region: sql`t.region`,
  };
};

const rollupFacts = (ctx: Ctx, table: string, keys: readonly RollupKey[]): Facts => {
  const withSupplier = keys.includes('supplier') && ctx.privacy;
  // The rollups hold no fiscal code: supplier_ref is supplier_privacy.supplier_id (0 =
  // withheld, NULL = no supplier). The code comes from supplier_disclosure in this
  // snapshot, and only while the supplier is disclosed there (D6 again on read).
  const named = withSupplier
    ? sql`(r.supplier_ref > 0 and sv.fiscal_code_clean is not null)`
    : sql`false`;
  return {
    rollup: table,
    from: sql`
  from ${daV3Table(table)} r
  ${
    withSupplier
      ? // A fenced lateral probe: a plain join into the barrier view merge-joins over an index
        // scan of the whole rollup (prod, 22 Nov: year 2025 3.1 s vs 0.9 s; all years 4.1 s vs 3.7 s).
        sql`left join lateral (select x.fiscal_code_clean from ${PRIVACY_TABLE} x
            where x.supplier_id = r.supplier_ref offset 0) sv on true`
      : sql``
  }`,
    day: sql`r.month`,
    base: sql`r.purchases > 0`,
    rows: (pred) => sql`coalesce(sum(r.purchases) filter (where ${pred}), 0)`,
    counted: (pred) => sql`coalesce(sum(r.counted_purchases) filter (where ${pred}), 0)`,
    money: (pred) => sql`sum(r.counted_value) filter (where ${pred} and r.counted_purchases > 0)`,
    authority: sql`r.authority_cui`,
    authorityScope: (code) => sql`r.authority_cui = ${code}`,
    supplierKey: sql`case when r.supplier_ref is null then null
        when ${named} then sv.fiscal_code_clean
        else ${DA_V3_WITHHELD_SUPPLIER_KEY} end`,
    supplierNamed: named,
    // A public code's id, looked up once, so the scope uses the rollup's supplier_ref index.
    supplierScope: (code) =>
      withSupplier
        ? sql`r.supplier_ref = (select sp.supplier_id from ${PRIVACY_TABLE} sp
            where sp.fiscal_code_clean = ${code}) and ${named}`
        : sql`false`,
    cpv: sql`r.cpv8`,
    county: sql`r.county_code`,
    region: sql`r.region`,
  };
};

/** Breakdown/facet key per dimension; null = the unknown bucket. */
const dimensionKey = (f: Facts, dimension: string): Result<Sql, ApiError> => {
  const cpv8 = sql`${f.cpv} ~ '^[0-9]{8}'`;
  const level = (digit: number, keep: number) =>
    sql`case when ${cpv8} and substr(${f.cpv}, ${sql.lit(digit)}, 1) <> '0' then left(${f.cpv}, ${sql.lit(keep)}) || ${'0'.repeat(8 - keep)} end`;
  switch (dimension) {
    case 'authority':
      return ok(f.authority);
    case 'supplier':
      return ok(f.supplierKey);
    case 'cpvDivision':
      return ok(sql`case when ${f.cpv} ~ '^[0-9]{2}' then left(${f.cpv}, 2) end`);
    case 'cpvGroup':
      return ok(level(3, 3));
    case 'cpvClass':
      return ok(level(4, 4));
    case 'cpvCategory':
      return ok(level(5, 5));
    case 'cpvCode':
      return ok(sql`case when ${cpv8} then left(${f.cpv}, 8) end`);
    case 'buyerRegion':
      return ok(f.region);
    case 'buyerCounty':
      return ok(f.county);
    case 'buyerSiruta':
      return f.rollup === null
        ? ok(sql`t.territorial_siruta_code`)
        : err(databaseError('buyerSiruta has no rollup'));
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

/** The rollup key a breakdown or distinct dimension needs (undefined: none can answer it). */
const DIMENSION_KEY: Readonly<Record<string, RollupKey | null>> = {
  authority: 'authority',
  supplier: 'supplier',
  cpvDivision: 'cpv',
  cpvGroup: 'cpv',
  cpvClass: 'cpv',
  cpvCategory: 'cpv',
  cpvCode: 'cpv',
  buyerRegion: 'county',
  buyerCounty: 'county',
  buyerSiruta: null,
};

/**
 * The smallest rollup in this snapshot that covers the scope and the dimension,
 * or null (read live): SIRUTA scopes and value bounds have no rollup.
 */
const chooseRollup = (
  ctx: Ctx,
  scope: AnalysisScope,
  dimension: string | undefined
): { readonly table: string; readonly keys: readonly RollupKey[] } | null => {
  if (
    scope.buyerSiruta !== undefined ||
    scope.valueMin !== undefined ||
    scope.valueMax !== undefined
  )
    return null;
  const needs = new Set<RollupKey>();
  if (scope.authorityCui !== undefined) needs.add('authority');
  if (scope.supplierCui !== undefined) needs.add('supplier');
  if (
    scope.cpvDivision !== undefined ||
    scope.cpvGroup !== undefined ||
    scope.cpvClass !== undefined ||
    scope.cpvCategory !== undefined ||
    scope.cpvCode !== undefined
  )
    needs.add('cpv');
  if (scope.buyerRegion !== undefined || scope.buyerCounty !== undefined) needs.add('county');
  if (dimension !== undefined) {
    const key = DIMENSION_KEY[dimension];
    if (key === undefined || key === null) return null;
    needs.add(key);
  }
  return (
    DA_V3_ROLLUPS.find(
      (rollup) =>
        ctx.rollups.has(rollup.table) && [...needs].every((key) => rollup.keys.includes(key))
    ) ?? null
  );
};

interface Compiled {
  readonly facts: Facts;
  /** Rows of the scope: dims AND (dated window OR undated). */
  readonly where: Sql;
  /** Rows that feed the dated (period) aggregates. */
  readonly dated: Sql;
  readonly bounded: boolean;
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

/** The scope's window over a date column (both bounds month-aligned). */
const windowOn = (day: Sql, scope: AnalysisScope): { dated: Sql; bounded: boolean } => {
  const bounds: Sql[] = [];
  if (scope.year !== undefined) {
    bounds.push(sql`${day} >= ${`${String(scope.year)}-01-01`}::date`);
    bounds.push(sql`${day} < ${`${String(scope.year + 1)}-01-01`}::date`);
  } else {
    if (scope.from !== undefined) bounds.push(sql`${day} >= ${`${scope.from}-01`}::date`);
    if (scope.to !== undefined)
      bounds.push(sql`${day} < (${`${scope.to}-01`}::date + interval '1 month')`);
  }
  return bounds.length > 0
    ? { dated: sql`(${day} is not null and ${sql.join(bounds, sql` and `)})`, bounded: true }
    : { dated: sql`true`, bounded: false };
};

/**
 * Compile a scope over the facts that answer it: the smallest covering rollup,
 * or the live rows (`live` forces them: records list purchases).
 */
const compile = (
  ctx: Ctx,
  scope: AnalysisScope,
  dimension?: string,
  live = false,
  pointReads = false
): Result<Compiled, ApiError> => {
  for (const [field, message] of REFUSED_SCOPE)
    if (scope[field] !== undefined) return err(invalidInput(message, field));
  const rollup = live ? null : chooseRollup(ctx, scope, dimension);
  const geo =
    (dimension !== undefined && GEO_DIMENSIONS.has(dimension)) ||
    scope.buyerRegion !== undefined ||
    scope.buyerCounty !== undefined ||
    scope.buyerSiruta !== undefined;
  const f =
    rollup === null ? liveFacts(ctx, geo, pointReads) : rollupFacts(ctx, rollup.table, rollup.keys);
  const conds: Sql[] = f.base === null ? [] : [f.base];
  // Codes compare in the platform's form (no leading zeros); a legacy code still matches.
  if (scope.authorityCui !== undefined)
    conds.push(f.authorityScope(withoutLeadingZeros(scope.authorityCui)));
  if (scope.supplierCui !== undefined)
    conds.push(f.supplierScope(withoutLeadingZeros(scope.supplierCui)));
  if (scope.cpvDivision !== undefined) conds.push(sql`left(${f.cpv}, 2) = ${scope.cpvDivision}`);
  for (const [field, length] of CPV_PREFIXES) {
    const value = scope[field];
    if (value !== undefined) conds.push(sql`left(${f.cpv}, ${length}) = ${value.slice(0, length)}`);
  }
  if (scope.cpvCode !== undefined) conds.push(sql`left(${f.cpv}, 8) = ${scope.cpvCode}`);
  if (scope.buyerRegion !== undefined) conds.push(sql`${f.region} = ${scope.buyerRegion}`);
  if (scope.buyerCounty !== undefined) conds.push(sql`${f.county} = ${scope.buyerCounty}`);
  if (scope.buyerSiruta !== undefined) {
    // SIRUTA codes are digits; anything else can never match.
    conds.push(
      /^\d{1,7}$/u.test(scope.buyerSiruta)
        ? sql`t.territorial_siruta_code = ${String(Number(scope.buyerSiruta))}`
        : sql`false`
    );
  }
  // Value bounds restrict the rows to counted purchases whose counted value is in range (live only).
  if (scope.valueMin !== undefined || scope.valueMax !== undefined) {
    conds.push(sql`p.counted`);
    if (scope.valueMin !== undefined)
      conds.push(sql`p.counted_value >= ${String(scope.valueMin)}::numeric`);
    if (scope.valueMax !== undefined)
      conds.push(sql`p.counted_value <= ${String(scope.valueMax)}::numeric`);
  }
  const { dated, bounded } = windowOn(f.day, scope);
  conds.push(sql`(${dated} or ${f.day} is null)`);
  return ok({ facts: f, where: sql.join(conds, sql` and `), dated, bounded });
};

// ── shared aggregates ────────────────────────────────────────────────────────

/**
 * Σ counted value over `pred`, NULL when no counted row matches (the null law).
 * Exact: no rounding before anything is summed or compared.
 */
const countedSum = (f: Facts, pred: Sql): Sql =>
  sql`case when ${f.counted(pred)} = 0 then null else (${f.money(pred)})::text end`;

interface StatsRow {
  rows: string;
  with_value: string;
  awarded: string | null;
  min_month: string | null;
  max_month: string | null;
  undated_count: string;
  undated_value: string | null;
}

const statsSelect = (c: Compiled): Sql => {
  const f = c.facts;
  const dayKnown = sql`${c.dated} and ${f.day} is not null`;
  const undated = sql`${f.day} is null`;
  return sql`
  (${f.rows(c.dated)})::text as rows,
  (${f.counted(c.dated)})::text as with_value,
  ${countedSum(f, c.dated)} as awarded,
  to_char(min(${f.day}) filter (where ${dayKnown}), 'YYYY-MM') as min_month,
  to_char(max(${f.day}) filter (where ${dayKnown}), 'YYYY-MM') as max_month,
  (${f.rows(undated)})::text as undated_count,
  ${countedSum(f, undated)} as undated_value`;
};

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
    select ${statsSelect(c)} ${c.facts.from} where ${c.where}`.execute(ctx.trx);
  return toStats(result.rows[0]);
};

const bucketOf = (day: Sql, bucket: SeriesBucket): Sql =>
  ({
    month: sql`to_char(${day}, 'YYYY-MM')`,
    quarter: sql`to_char(${day}, 'YYYY') || '-Q' || extract(quarter from ${day})::int::text`,
    year: sql`to_char(${day}, 'YYYY')`,
  })[bucket];

const datedHaving = (c: Compiled): Sql =>
  c.bounded ? sql`having ${c.facts.rows(c.dated)} > 0` : sql``;

/** A bucket's counted money, exact; '0.00' when none (the ClickHouse bucket convention). */
const bucketSum = (f: Facts, pred: Sql): Sql => sql`coalesce((${f.money(pred)})::text, '0.00')`;

/** Exact decimal text for the breakdown's `other` remainder: totals − top − unknown. */
const minus = (total: string | null, parts: readonly string[]): string =>
  parts.reduce((acc, part) => acc.minus(part), new Decimal(total ?? '0')).toFixed();

const UNFILTERED = (scope: AnalysisScope): boolean =>
  scope.authorityCui === undefined && scope.supplierCui === undefined;

/** The scope selects nothing but a window: the whole release. */
const windowOnly = (scope: AnalysisScope): boolean =>
  scope.authorityCui === undefined &&
  scope.supplierCui === undefined &&
  scope.cpvDivision === undefined &&
  scope.cpvGroup === undefined &&
  scope.cpvClass === undefined &&
  scope.cpvCategory === undefined &&
  scope.cpvCode === undefined &&
  scope.buyerRegion === undefined &&
  scope.buyerCounty === undefined &&
  scope.buyerSiruta === undefined &&
  scope.valueMin === undefined &&
  scope.valueMax === undefined;

/** The window lines up with whole buckets (a month window cannot use a year's distinct count). */
const windowAligned = (scope: AnalysisScope, bucket: SeriesBucket): boolean => {
  if (bucket === 'month' || scope.year !== undefined) return true;
  if (bucket !== 'year') return false;
  return (
    (scope.from === undefined || scope.from.endsWith('-01')) &&
    (scope.to === undefined || scope.to.endsWith('-12'))
  );
};

/** The quality columns the data platform computes into da_release at publish. */
interface QualityRow {
  total: string;
  dated: string;
  counted: string;
  accepted: string;
  with_cpv: string;
  with_geo: string;
  money: string | null;
  money_dated: string | null;
  money_geo: string | null;
}

const QUALITY_COLUMNS = [
  'rows',
  'dated',
  'counted',
  'accepted',
  'with_cpv',
  'with_geo',
  'money',
  'money_dated',
  'money_geo',
] as const;

/**
 * The publication's quality figures from da_release when the platform computes
 * them at publish (all nine columns readable); null: measure them live.
 */
const readPublishedQuality = async (ctx: Ctx): Promise<{ rows: QualityRow[] } | null> => {
  const present = await sql<{ n: string }>`
    select count(*)::text as n from pg_attribute
    where attrelid = to_regclass(${`${DA_RELEASE_SCHEMA}.da_release`})
      and attname = any(${[...QUALITY_COLUMNS]}::text[]) and not attisdropped
      and has_column_privilege(attrelid, attname, 'SELECT')`.execute(ctx.trx);
  if (Number(present.rows[0]?.n ?? '0') !== QUALITY_COLUMNS.length) return null;
  const result = await sql<QualityRow>`
    select r.rows::text as total, r.dated::text as dated, r.counted::text as counted,
           r.accepted::text as accepted, r.with_cpv::text as with_cpv, r.with_geo::text as with_geo,
           r.money::text as money, r.money_dated::text as money_dated, r.money_geo::text as money_geo
    from ${RELEASE} r
    where r.data_as_of = (select max(data_as_of) from ${RELEASE})`.execute(ctx.trx);
  const row = result.rows[0];
  // A partial payload (any figure NULL) is not a measurement: measure live instead.
  if (result.rows.length !== 1 || row === undefined) return null;
  return Object.values(row).every((value) => value !== null) ? { rows: result.rows } : null;
};

interface RecordRow {
  id: string;
  date: string | null;
  authority_cui: string | null;
  authority_name: string | null;
  supplier_cui: string | null;
  supplier_display_kind: 'company' | 'natural_person' | null;
  value_ron: string | null;
  status: string | null;
  cpv_code: string | null;
  cpv_label: string | null;
}

// ── the source ───────────────────────────────────────────────────────────────

export const makeDaV3AnalysisSource = (db: Db, logger?: Logger): DaV3AnalysisSource => {
  const qualityByBuild = new Map<string, Promise<Result<GrainQualityVerdict, ApiError>>>();
  let cacheBuild: string | null = null;
  const cache = new Map<string, Result<unknown, ApiError>>();

  /** Unfiltered (no authority/supplier) answers are cached per publication; others run live. */
  /**
   * The publication and privacy state RIGHT NOW, in ONE statement (a publish
   * cannot fall between the two): whether `build` is still the current build,
   * and whether supplier_disclosure is readable. Unreadable on error.
   */
  const probeNow = async (build: string): Promise<{ current: boolean; privacy: boolean }> => {
    try {
      const probe = await sql<{ build_id: string | null; privacy: boolean | null }>`
        select ${BUILD_ID_SQL} as build_id,
               coalesce(
                 has_table_privilege(to_regclass(${SUPPLIER_DISCLOSURE_NAME}), 'SELECT'),
                 false
               ) as privacy
        from ${RELEASE}`.execute(db);
      const row = probe.rows[0];
      return { current: row?.build_id === build, privacy: row?.privacy === true };
    } catch {
      return { current: false, privacy: false };
    }
  };

  /**
   * An entry is reused, and stored, only while the build is current and
   * supplier_disclosure is readable, checked before the lookup AND after the fill.
   */
  const cacheable = async (build: string): Promise<boolean> => {
    const now = await probeNow(build);
    return now.current && now.privacy;
  };

  /**
   * A read not served from the cache is answered only if, after it, its build is
   * STILL current and, when it could name suppliers, supplier_disclosure is still
   * readable (a revoked grant withholds everyone). Otherwise the caller repeats
   * the request: rows and a disclosureKey the server already knows are stale are
   * never returned.
   */
  const settled = async <T>(
    build: string,
    result: Result<T, ApiError>,
    seen: ReadSeen
  ): Promise<Result<T, ApiError>> => {
    if (result.isErr()) return result;
    const now = await probeNow(build);
    return now.current && (now.privacy || !seen.privacy) ? result : err(REPUBLISHED());
  };

  /** Fills in flight, keyed like the cache: identical concurrent misses share one read. */
  const filling = new Map<string, Promise<Result<unknown, ApiError>>>();

  const cached = async <T>(
    build: string,
    scope: AnalysisScope,
    key: unknown,
    load: (seen: ReadSeen) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>> => {
    const seen: ReadSeen = { privacy: false };
    if (!UNFILTERED(scope)) return settled(build, await load(seen), seen);
    if (!(await cacheable(build))) return settled(build, await load(seen), seen);
    if (cacheBuild !== build) {
      cache.clear();
      filling.clear();
      cacheBuild = build;
    }
    // The build is part of the key: an entry can only answer its own publication.
    const cacheKey = JSON.stringify([build, key, scope]);
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit as Result<T, ApiError>;
    const joined = filling.get(cacheKey);
    if (joined !== undefined) return (await joined) as Result<T, ApiError>;
    const fill = (async (): Promise<Result<unknown, ApiError>> => {
      const result = await load(seen);
      if (result.isErr()) return result;
      // Kept AND returned only if this build is still the cache's and still current and
      // readable. A fill that a publish overtook is neither kept nor served: its rows
      // and its disclosureKey belong to a publication the server now knows is stale
      // (another request may already have served the newer one), so the caller is
      // told to repeat the request. A re-read here cannot help: the request's build
      // and disclosureKey were fixed before this read.
      if (cacheBuild !== build || !(await cacheable(build))) return err(REPUBLISHED());
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(cacheKey, result);
      return result;
    })();
    filling.set(cacheKey, fill);
    try {
      return (await fill) as Result<T, ApiError>;
    } finally {
      if (filling.get(cacheKey) === fill) filling.delete(cacheKey);
    }
  };

  /** Coverage measured from procurement_v3 once per publication (row share and counted-money share). */
  const measureQuality = (build: string): Promise<Result<GrainQualityVerdict, ApiError>> => {
    const known = qualityByBuild.get(build);
    if (known !== undefined) return known;
    const promise = snapshot(db, QUALITY_TIMEOUT_MS, build, async (ctx) => {
      const precomputed = await readPublishedQuality(ctx);
      const result =
        precomputed ??
        (await sql<{
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
        ${geoJoin(ctx)}`.execute(ctx.trx));
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
      const row = result.rows[0];
      return ok(row === undefined ? null : { ...row, privacy: ctx.privacy });
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
      // supplier_disclosure publishes in the same transaction as the facts (one data_as_of).
      disclosureKey: release.value.privacy ? release.value.as_of : 'unavailable',
      notes: [DA_V3_VALUE_NOTE],
    });
  };

  const statsFor: DaV3AnalysisSource['statsFor'] = (_route, scope, gen) =>
    cached(gen.buildId, scope, ['stats'], (seen) =>
      snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          const c = compile(ctx, scope);
          if (c.isErr()) return err(c.error);
          return ok(await readStats(ctx, c.value));
        },
        seen
      )
    );

  const seriesFor: DaV3AnalysisSource['seriesFor'] = (_route, scope, gen, measure) =>
    cached(gen.buildId, scope, ['series', measure], (seen) =>
      snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          const c = compile(ctx, scope);
          if (c.isErr()) return err(c.error);
          const f = c.value.facts;
          const dated = sql`${f.day} is not null`;
          const valueOf: Partial<Record<MeasureId, Sql>> = {
            recordCount: sql`(${f.rows(dated)})::text`,
            withValueCount: sql`(${f.counted(dated)})::text`,
            valueAwardedSum: countedSum(f, dated),
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
          select ${bucketOf(f.day, 'month')} as month,
                 ${value} as value,
                 (${f.rows(sql`true`)})::text as record_count,
                 (${f.counted(sql`true`)})::text as with_value,
                 ${countedSum(f, sql`true`)} as awarded
          ${f.from}
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
        },
        seen
      )
    );

  /**
   * The whole release's distinct counts per month or year, from the publish-time
   * distinct rollup: every withheld supplier is one supplier (as live), so the
   * supplier count is the public suppliers plus one when any is withheld. The
   * per-bucket counts and money come from the smallest rollup.
   */
  const distinctFromRollup = async (
    ctx: Ctx,
    c: Compiled,
    scope: AnalysisScope,
    key: 'authority' | 'supplier',
    bucket: 'month' | 'year'
  ) => {
    const day = sql`d.bucket`;
    const value =
      key === 'authority'
        ? sql`d.distinct_authorities`
        : ctx.privacy
          ? sql`d.distinct_public_suppliers + case when d.has_withheld then 1 else 0 end`
          : // Unreadable privacy: every supplier is withheld, so at most one.
            sql`case when d.distinct_public_suppliers > 0 or d.has_withheld then 1 else 0 end`;
    const counts = await sql<{
      bucket: string | null;
      record_count: string;
      with_value: string;
      awarded: string | null;
    }>`
      select ${bucketOf(c.facts.day, bucket)} as bucket,
             (${c.facts.rows(sql`true`)})::text as record_count,
             (${c.facts.counted(sql`true`)})::text as with_value,
             ${countedSum(c.facts, sql`true`)} as awarded
      ${c.facts.from}
      where ${c.where}
      group by 1`.execute(ctx.trx);
    const distinct = await sql<{ bucket: string; value: string }>`
      select ${bucketOf(day, bucket)} as bucket, (${value})::text as value
      from ${daV3Table(DISTINCT_ROLLUP)} d
      where d.bucket_kind = ${bucket} and ${windowOn(day, scope).dated}`.execute(ctx.trx);
    const byBucket = new Map(distinct.rows.map((row) => [row.bucket, row.value]));
    return counts.rows
      .map((row) => ({
        bucket: row.bucket,
        // The undated bucket's distinct count is never served (only its counts are).
        value: row.bucket === null ? '0' : (byBucket.get(row.bucket) ?? '0'),
        recordCount: row.record_count,
        withValue: row.with_value,
        valueAwardedSum: row.awarded,
      }))
      .sort((a, b) =>
        a.bucket === null ? 1 : b.bucket === null ? -1 : a.bucket.localeCompare(b.bucket)
      );
  };

  const distinctSeriesFor: DaV3AnalysisSource['distinctSeriesFor'] = (
    _route,
    scope,
    gen,
    key,
    bucket
  ) =>
    cached(gen.buildId, scope, ['distinct', key, bucket], (seen) =>
      snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          const dimension = key === 'supplier' ? 'supplier' : 'authority';
          if (
            bucket !== 'quarter' &&
            windowOnly(scope) &&
            windowAligned(scope, bucket) &&
            ctx.rollups.has(DISTINCT_ROLLUP)
          ) {
            const whole = compile(ctx, scope);
            if (whole.isErr()) return err(whole.error);
            if (whole.value.facts.rollup !== null)
              return ok(await distinctFromRollup(ctx, whole.value, scope, dimension, bucket));
          }
          const c = compile(ctx, scope, dimension);
          if (c.isErr()) return err(c.error);
          const f = c.value.facts;
          const keyExpr = dimensionKey(f, dimension);
          if (keyExpr.isErr()) return err(keyExpr.error);
          const result = await sql<{
            bucket: string | null;
            value: string;
            record_count: string;
            with_value: string;
            awarded: string | null;
          }>`
          select ${bucketOf(f.day, bucket)} as bucket,
                 count(distinct ${keyExpr.value})::text as value,
                 (${f.rows(sql`true`)})::text as record_count,
                 (${f.counted(sql`true`)})::text as with_value,
                 ${countedSum(f, sql`true`)} as awarded
          ${f.from}
          where ${c.value.where}
          group by 1
          order by 1 asc nulls last`.execute(ctx.trx);
          return ok(
            result.rows.map((row) => ({
              bucket: row.bucket,
              // The undated bucket's distinct count is never served; one placeholder on both paths.
              value: row.bucket === null ? '0' : row.value,
              recordCount: row.record_count,
              withValue: row.with_value,
              valueAwardedSum: row.awarded,
            }))
          );
        },
        seen
      )
    );

  const breakdownFor: DaV3AnalysisSource['breakdownFor'] = (
    _route,
    scope,
    gen,
    dimension,
    topN,
    rankBy
  ) =>
    cached(gen.buildId, scope, ['breakdown', dimension, topN, rankBy], (seen) =>
      snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          const c = compile(ctx, scope, dimension);
          if (c.isErr()) return err(c.error);
          const f = c.value.facts;
          const keyR = dimensionKey(f, dimension);
          if (keyR.isErr()) return err(keyR.error);
          const key = keyR.value;
          const totals = await readStats(ctx, c.value);
          const { dated, where } = c.value;
          const unknownR = await sql<{ cnt: string; wv: string; awarded: string }>`
          select (${f.rows(dated)})::text as cnt,
                 (${f.counted(dated)})::text as wv,
                 ${bucketSum(f, dated)} as awarded
          ${f.from}
          where ${where} and (${key}) is null`.execute(ctx.trx);
          const unknown = unknownR.rows[0] ?? { cnt: '0', wv: '0', awarded: '0.00' };
          const valueBearing = BigInt(totals.withValue) - BigInt(unknown.wv);
          const rankedBy: 'value' | 'count' =
            rankBy === 'value' && valueBearing > 0n ? 'value' : 'count';
          const rank = rankedBy === 'value' ? sql`coalesce(${f.money(dated)}, 0)` : f.rows(dated);
          const top = await sql<{ key: string; cnt: string; wv: string; awarded: string }>`
          select ${key} as key,
                 (${f.rows(dated)})::text as cnt,
                 (${f.counted(dated)})::text as wv,
                 ${bucketSum(f, dated)} as awarded
          ${f.from}
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
        },
        seen
      )
    );

  const concentrationFor: DaV3AnalysisSource['concentrationFor'] = (_route, scope, gen, basis) =>
    cached(gen.buildId, scope, ['concentration', basis], (seen) =>
      snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          const c = compile(ctx, scope, 'supplier');
          if (c.isErr()) return err(c.error);
          const f = c.value.facts;
          const keyR = dimensionKey(f, 'supplier');
          if (keyR.isErr()) return err(keyR.error);
          const totals = await readStats(ctx, c.value);
          const { dated, where } = c.value;
          const measure = basis === 'value' ? sql`coalesce(${f.money(dated)}, 0)` : f.rows(dated);
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
            ${f.from}
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
        },
        seen
      )
    );

  // Never cached (a page), so settled directly: a page a publish overtook is not served.
  const recordsFor: DaV3AnalysisSource['recordsFor'] = async (_route, scope, gen, page) => {
    const seen: ReadSeen = { privacy: false };
    return settled(
      gen.buildId,
      await snapshot(
        db,
        STATEMENT_TIMEOUT_MS,
        gen.buildId,
        async (ctx) => {
          // The page lists purchases (live rows, parties probed per row); its total is a count
          // (a rollup when one covers it, else the live rows joined plainly).
          const c = compile(ctx, scope, undefined, true, true);
          if (c.isErr()) return err(c.error);
          // Without pinned geography a geography scope's total stays live like its rows: the
          // rollups place the buyer as of the DA publish, the kernel join as of today, and a page
          // must agree with itself. With it, both place the buyer the same way.
          const geoScoped =
            scope.buyerRegion !== undefined ||
            scope.buyerCounty !== undefined ||
            scope.buyerSiruta !== undefined;
          const counting =
            geoScoped && !ctx.rollups.has(BUYER_GEOGRAPHY)
              ? compile(ctx, scope, undefined, true)
              : compile(ctx, scope);
          if (counting.isErr()) return err(counting.error);
          const money = sql`case when p.counted then p.counted_value end`;
          const where = sql`${c.value.where} and ${c.value.dated}`;
          const from = c.value.facts.from;
          const isNamed = c.value.facts.supplierNamed;
          // Without a geography scope the filter reads only the purchase row (party scopes go by
          // party ids), so the page is chosen from da_purchases alone and only its rows probe their
          // parties: probing first would run a lateral probe per candidate row before the sort
          // (prod, 22 Nov: a supplier with 514k purchases timed out at 15 s).
          const rowsFrom = (extra: Sql, order: Sql, limit: number, offset: number): Sql =>
            geoScoped
              ? sql`${from}
        where ${where} and ${extra}`
              : sql`from (
          select p.purchase_id, p.source_name, p.buyer_party_id, p.supplier_party_id,
                 p.finalization_day, p.counted, p.counted_value, p.outcome,
                 p.category_code, p.category_as_written
          from ${PURCHASES} p
          where ${where} and ${extra}
          order by ${order}
          limit ${limit} offset ${offset}) p
        ${purchaseParties(true)}`;
          const pageOf = (extra: Sql, order: Sql, limit: number, offset: number) =>
            sql<RecordRow>`
        select p.purchase_id as id,
               p.finalization_day::text as date,
               case when b.fiscal_code_status = 'valid' then b.fiscal_code_clean end as authority_cui,
               b.name_as_written as authority_name,
               case when ${isNamed} then s.fiscal_code_clean end as supplier_cui,
               case when p.supplier_party_id is null then null
                    when ${isNamed} then 'company' else 'natural_person' end as supplier_display_kind,
               (${money})::text as value_ron,
               p.outcome as status,
               case when p.category_code ~ '^[0-9]{8}' then left(p.category_code, 8) end as cpv_code,
               p.category_as_written as cpv_label
        ${rowsFrom(extra, order, limit, offset)}
        order by ${order}
        ${geoScoped ? sql`limit ${limit} offset ${offset}` : sql``}`.execute(ctx.trx);
          let rows: RecordRow[];
          if (page.sort === 'date_desc' || page.sort === 'date_asc') {
            const order =
              page.sort === 'date_desc'
                ? sql`p.finalization_day is null asc, p.finalization_day desc, p.purchase_id desc`
                : sql`p.finalization_day is null asc, p.finalization_day asc, p.purchase_id asc`;
            rows = (await pageOf(sql`true`, order, page.limit, page.offset)).rows;
          } else {
            // Same order as `money desc|asc nulls last, purchase_id desc|asc`, in two phases so
            // the (counted_value, purchase_id) where-counted index serves the valued rows: the
            // valued rows by value, then the rest by id, the offset carried across.
            const desc = page.sort === 'value_desc';
            const valued = sql`p.counted and p.counted_value is not null`;
            const first = (
              await pageOf(
                valued,
                desc
                  ? sql`p.counted_value desc, p.purchase_id desc`
                  : sql`p.counted_value asc, p.purchase_id asc`,
                page.limit,
                page.offset
              )
            ).rows;
            rows = first;
            if (first.length < page.limit) {
              let valuedCount = page.offset + first.length;
              if (first.length === 0 && page.offset > 0) {
                // A count over every valued row: the live rows joined plainly, not probed per row.
                const plain = compile(ctx, scope, undefined, true);
                if (plain.isErr()) return err(plain.error);
                const n = await sql<{ n: string }>`
              select count(*)::text as n ${plain.value.facts.from}
              where ${plain.value.where} and ${plain.value.dated} and ${valued}`.execute(ctx.trx);
                valuedCount = Number(n.rows[0]?.n ?? '0');
              }
              const rest = (
                await pageOf(
                  sql`not (${valued})`,
                  desc ? sql`p.purchase_id desc` : sql`p.purchase_id asc`,
                  page.limit - first.length,
                  Math.max(0, page.offset - valuedCount)
                )
              ).rows;
              rows = [...first, ...rest];
            }
          }
          const t = counting.value;
          const total = await sql<{ total: string }>`
        select (${t.facts.rows(t.dated)})::text as total ${t.facts.from} where ${t.where}`.execute(
            ctx.trx
          );
          // Named suppliers' public registry names, by this page's codes only.
          const names = await supplierNamesByCode(
            ctx.trx,
            rows.flatMap((row) => row.supplier_cui ?? [])
          );
          return ok({
            total: total.rows[0]?.total ?? '0',
            rows: rows.map((row): AnalysisRecordRow => ({
              id: row.id,
              date: row.date,
              // Free text is withheld until reviewed: the CPV label stands in the title's place.
              title: null,
              authorityCui: row.authority_cui,
              authorityName: row.authority_name,
              supplierCui: row.supplier_cui,
              supplierName:
                row.supplier_cui === null ? null : (names.get(row.supplier_cui) ?? null),
              supplierDisplayKind: row.supplier_display_kind,
              valueRon: row.value_ron,
              status: row.status,
              recordKind: null,
              cpvCode: row.cpv_code,
              cpvLabel: row.cpv_label,
            })),
          });
        },
        seen
      ),
      seen
    );
  };

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
