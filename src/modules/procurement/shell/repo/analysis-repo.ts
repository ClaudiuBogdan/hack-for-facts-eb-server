/**
 * Procurement module — analysis rollup repository (design §6.2). Reads the
 * scraper-built `procurement.analysis_*` package:
 *
 *  - the generation ledger is resolved ONCE per request via `activeGeneration()`
 *    (micro-cached ~5s in process), and EVERY rollup statement pins
 *    `build_id = <that generation>` — a cutover mid-request can never mix builds;
 *  - the undated bucket (`month_start IS NULL`) is aggregated in the SAME
 *    statement via `FILTER` clauses (design §3.2 — no companion scans);
 *  - breakdowns are one window-ranked statement returning top-N + `other` +
 *    `unknown` + the scope totals, so reconciliation holds by construction;
 *  - numerics are selected as text (§14.1 — money never becomes a JS float);
 *  - non-entity scopes are cached through `shell/scope-cache.ts`, keyed on
 *    (shape, rollup, grain, scope fhash, params, buildId) — a new generation
 *    invalidates everything implicitly.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  fhashFor,
  timeoutError,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  ANALYSIS_SCOPE_SPEC,
  isCacheableAnalysisScope,
  scopeToFilterInput,
  scopeWindow,
  type AnalysisScope,
  type ScopeDimField,
} from '../../core/analysis-scope.js';
import { ANALYSIS_GRAINS, type MeasureId, type SeriesBucket } from '../../core/constants.js';
import { makeScopeCache, type ScopeCache } from '../scope-cache.js';

import type { AnalysisRoute } from '../../core/combinations.js';
import type { GenerationQuality, GrainQualityVerdict } from '../../core/gate-v2.js';
import type {
  ActiveGeneration,
  AnalysisBreakdownBucketRow,
  AnalysisBreakdownRead,
  AnalysisDistinctRow,
  AnalysisRepo,
  AnalysisSeriesRow,
  AnalysisStatsRead,
  ConcentrationRead,
} from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const GENERATION_TTL_MS = 5_000;

// ── quality jsonb validation (safe parsing — never trusted raw) ────────────────

const AllowAbstain = Type.Union([Type.Literal('allow'), Type.Literal('abstain')]);
const AllowDegradedAbstain = Type.Union([
  Type.Literal('allow'),
  Type.Literal('degraded'),
  Type.Literal('abstain'),
]);

const QualityVerdictSchema = Type.Object({
  coverage: Type.Object({
    date: Type.Number(),
    value: Type.Number(),
    geo: Type.Number(),
    cpv: Type.Number(),
  }),
  classes: Type.Object({
    spend: AllowAbstain,
    time: AllowDegradedAbstain,
    geo: AllowDegradedAbstain,
  }),
});

/**
 * Validate the generation's `quality` jsonb grain by grain. A malformed or
 * missing grain entry is DROPPED — `decideAnswer` then abstains for that grain
 * ("no quality verdict"), which is the fail-safe direction.
 */
const parseQuality = (raw: unknown): GenerationQuality => {
  const quality: Partial<Record<(typeof ANALYSIS_GRAINS)[number], GrainQualityVerdict>> = {};
  if (typeof raw !== 'object' || raw === null) return quality;
  const record = raw as Record<string, unknown>;
  for (const grain of ANALYSIS_GRAINS) {
    const verdict = record[grain];
    if (verdict !== undefined && Value.Check(QualityVerdictSchema, verdict)) {
      quality[grain] = verdict;
    }
  }
  return quality;
};

// ── scope → SQL ────────────────────────────────────────────────────────────────

/** Scope dim field → rollup column. cpvDivision on the cpv_code rollup is special. */
const DIM_COLUMNS: Partial<Record<ScopeDimField, string>> = {
  authorityCui: 'authority_cui',
  supplierCui: 'supplier_cui',
  cpvDivision: 'cpv_division',
  cpvCode: 'cpv_code',
  status: 'status',
  procedureType: 'procedure_type',
  buyerRegion: 'buyer_region',
};

const BREAKDOWN_COLUMNS: Record<string, string> = {
  authority: 'authority_cui',
  supplier: 'supplier_cui',
  cpvDivision: 'cpv_division',
  cpvCode: 'cpv_code',
  status: 'status',
  procedureType: 'procedure_type',
  buyerRegion: 'buyer_region',
};

const MEASURE_COLUMNS: Partial<Record<MeasureId, string>> = {
  recordCount: 'record_count',
  withValueCount: 'with_value_count',
  valueAwardedSum: 'value_awarded_sum',
  valueEstimatedSum: 'value_estimated_sum',
};

interface CompiledScope {
  /** Row-selection predicate (dims + build + grain + window-or-undated pruning). */
  readonly where: RawBuilder<SqlBool>;
  /**
   * True for rows that belong to the answer's DATED population. For a bounded
   * window: in-window months only; unbounded: every row including undated
   * (full-population answers, design §3.2).
   */
  readonly datedPred: RawBuilder<SqlBool>;
}

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const compileScope = (
  route: AnalysisRoute,
  scope: AnalysisScope,
  buildId: string
): CompiledScope => {
  const conds: RawBuilder<unknown>[] = [sql`build_id = ${buildId}`, sql`grain = ${route.grain}`];
  for (const field of route.rollup.scopeDims) {
    const value = scope[field];
    if (value === undefined) continue;
    if (field === 'cpvDivision' && route.rollup.rollup === 'cpvCode') {
      // The cpv_code rollup has no division column; the division is the code's
      // 2-digit prefix. The rollup is small (codes × months) — no index concern.
      conds.push(sql`substring(cpv_code, 1, 2) = ${value}`);
      continue;
    }
    const column = DIM_COLUMNS[field];
    if (column === undefined) continue; // county/region fields rejected upstream
    conds.push(sql`${sql.ref(column)} = ${value}`);
  }

  const window = scopeWindow(scope);
  if (window === undefined) {
    return { where: composeAnd(conds), datedPred: sql<SqlBool>`true` };
  }
  const bounds: RawBuilder<unknown>[] = [];
  if (window.from !== undefined) bounds.push(sql`month_start >= ${`${window.from}-01`}::date`);
  if (window.to !== undefined) bounds.push(sql`month_start <= ${`${window.to}-01`}::date`);
  const datedPred = composeAnd(bounds);
  // Keep the undated bucket selectable in the same statement (FILTER splits it out).
  conds.push(sql`((${datedPred}) or month_start is null)`);
  return { where: composeAnd(conds), datedPred };
};

/**
 * Carries an `ApiError` out of the cache loader as a real `Error` so a failed
 * load is never memoized (the cache stores only what a loader resolves).
 */
class UncacheableError extends Error {
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
    this.name = 'UncacheableError';
  }
}

export const makeProcurementAnalysisRepo = (
  db: Db,
  cache: ScopeCache = makeScopeCache(),
  now: () => number = Date.now,
  logger?: Logger
): AnalysisRepo => {
  const queryFailure = (
    operation: string,
    error: unknown,
    startedAt: number,
    context?: { readonly route: AnalysisRoute; readonly buildId: string }
  ): ApiError => {
    const postgresCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined;
    logger?.warn(
      {
        operation,
        ...(context === undefined
          ? {}
          : {
              shape: operation,
              grain: context.route.grain,
              rollup: context.route.rollup.rollup,
              buildId: context.buildId,
            }),
        elapsedMs: Math.max(0, now() - startedAt),
        ...(postgresCode === undefined ? {} : { postgresCode }),
      },
      'procurement analysis query failed'
    );
    return postgresCode === '57014'
      ? timeoutError(`procurement analysis ${operation} timed out`)
      : databaseError(`procurement analysis ${operation} failed`, error);
  };
  // ── the active generation (micro-cached; every read pins its buildId) ───────
  //
  // Single-flight: concurrent callers past the TTL await ONE in-flight refresh
  // (no thundering herd on the pointer table). The database's single active row
  // is authoritative even when it points back to an older build for rollback.
  // Errors are never cached.

  let generationCache: { value: ActiveGeneration | null; expiresAt: number } | null = null;
  let generationInFlight: Promise<Result<ActiveGeneration | null, ApiError>> | null = null;

  const refreshGeneration = async (): Promise<Result<ActiveGeneration | null, ApiError>> => {
    const startedAt = now();
    try {
      const row = await db
        .selectFrom('procurement.analysis_generations as g')
        .select([
          sql<string>`g.build_id::text`.as('build_id'),
          sql<string | null>`g.published_at::text`.as('published_at'),
          'g.quality',
          'g.matrix_hash',
        ])
        .where(sql<SqlBool>`g.status = 'active'`)
        .orderBy('g.build_id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const fresh: ActiveGeneration | null =
        row === undefined
          ? null
          : {
              buildId: row.build_id,
              publishedAt: row.published_at,
              quality: parseQuality(row.quality),
              matrixHash: row.matrix_hash,
            };
      generationCache = { value: fresh, expiresAt: now() + GENERATION_TTL_MS };
      return ok(fresh);
    } catch (error) {
      return err(queryFailure('activeGeneration', error, startedAt));
    }
  };

  const activeGeneration = async (): Promise<Result<ActiveGeneration | null, ApiError>> => {
    if (generationCache !== null && generationCache.expiresAt > now()) {
      return ok(generationCache.value);
    }
    if (generationInFlight !== null) return generationInFlight;
    generationInFlight = refreshGeneration().finally(() => {
      generationInFlight = null;
    });
    return generationInFlight;
  };

  // ── cache wrapper (non-entity scopes only; keyed on buildId) ────────────────

  const cached = async <T>(
    shape: string,
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    params: readonly unknown[],
    load: () => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>> => {
    if (!isCacheableAnalysisScope(scope)) return load();
    const key = JSON.stringify([
      shape,
      route.rollup.rollup,
      route.grain,
      fhashFor(ANALYSIS_SCOPE_SPEC, scopeToFilterInput(scope)),
      params,
      buildId,
    ]);
    try {
      const value = await cache.through(key, async () => {
        const result = await load();
        if (result.isErr()) throw new UncacheableError(result.error);
        return result.value;
      });
      return ok(value);
    } catch (error) {
      if (error instanceof UncacheableError) return err(error.apiError);
      return err(databaseError(`${shape} failed`, error));
    }
  };

  // ── stats (one statement; undated bucket via FILTER) ────────────────────────

  const statsFor = (
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string
  ): Promise<Result<AnalysisStatsRead, ApiError>> =>
    cached('stats', route, scope, buildId, [], async () => {
      const startedAt = now();
      const { where, datedPred } = compileScope(route, scope, buildId);
      const table = sql.table(route.rollup.table);
      try {
        const result = await sql<{
          rows: string;
          with_value: string;
          with_estimated: string;
          value_awarded_sum: string | null;
          value_estimated_sum: string | null;
          min_month: string | null;
          max_month: string | null;
          undated_count: string;
          undated_value_ron: string | null;
        }>`
          select
            coalesce(sum(record_count) filter (where ${datedPred}), 0)::text as rows,
            coalesce(sum(with_value_count) filter (where ${datedPred}), 0)::text as with_value,
            coalesce(sum(with_estimated_count) filter (where ${datedPred}), 0)::text as with_estimated,
            (sum(value_awarded_sum) filter (where ${datedPred}))::text as value_awarded_sum,
            (sum(value_estimated_sum) filter (where ${datedPred}))::text as value_estimated_sum,
            to_char(min(month_start) filter (where ${datedPred}), 'YYYY-MM') as min_month,
            to_char(max(month_start) filter (where ${datedPred}), 'YYYY-MM') as max_month,
            coalesce(sum(record_count) filter (where month_start is null), 0)::text as undated_count,
            (sum(value_awarded_sum) filter (where month_start is null))::text as undated_value_ron
          from ${table}
          where ${where}
        `.execute(db);
        const row = result.rows[0];
        return ok({
          rows: row?.rows ?? '0',
          withValue: row?.with_value ?? '0',
          withEstimated: row?.with_estimated ?? '0',
          valueAwardedSum: row?.value_awarded_sum ?? null,
          valueEstimatedSum: row?.value_estimated_sum ?? null,
          minMonth: row?.min_month ?? null,
          maxMonth: row?.max_month ?? null,
          undatedCount: row?.undated_count ?? '0',
          undatedValueRon: row?.undated_value_ron ?? null,
        });
      } catch (error) {
        return err(queryFailure('stats', error, startedAt, { route, buildId }));
      }
    });

  // ── monthly series (NULL-month row rides along, tagged) ─────────────────────

  const seriesFor = (
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    measure: MeasureId
  ): Promise<Result<readonly AnalysisSeriesRow[], ApiError>> =>
    cached('series', route, scope, buildId, [measure], async () => {
      const startedAt = now();
      const column = MEASURE_COLUMNS[measure];
      if (column === undefined) {
        return err(databaseError(`series measure '${measure}' has no rollup column`));
      }
      const { where } = compileScope(route, scope, buildId);
      const table = sql.table(route.rollup.table);
      try {
        const result = await sql<{
          month: string | null;
          value: string | null;
          record_count: string;
          with_value: string;
          value_awarded_sum: string | null;
        }>`
          select
            to_char(month_start, 'YYYY-MM') as month,
            sum(${sql.ref(column)})::text as value,
            coalesce(sum(record_count), 0)::text as record_count,
            coalesce(sum(with_value_count), 0)::text as with_value,
            (sum(value_awarded_sum))::text as value_awarded_sum
          from ${table}
          where ${where}
          group by month_start
          order by month_start asc nulls last
        `.execute(db);
        return ok(
          result.rows.map((r) => ({
            month: r.month,
            value: r.value,
            recordCount: r.record_count,
            withValue: r.with_value,
            valueAwardedSum: r.value_awarded_sum,
          }))
        );
      } catch (error) {
        return err(queryFailure('series', error, startedAt, { route, buildId }));
      }
    });

  // ── distinct series (COUNT(DISTINCT) per bucket, bucketed HERE) ─────────────

  const distinctSeriesFor = (
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    key: 'supplier' | 'authority',
    bucket: SeriesBucket
  ): Promise<Result<readonly AnalysisDistinctRow[], ApiError>> =>
    cached('distinct-series', route, scope, buildId, [key, bucket], async () => {
      const startedAt = now();
      const keyColumn = key === 'supplier' ? 'supplier_cui' : 'authority_cui';
      const format = bucket === 'month' ? 'YYYY-MM' : bucket === 'quarter' ? 'YYYY-"Q"Q' : 'YYYY';
      const { where } = compileScope(route, scope, buildId);
      const table = sql.table(route.rollup.table);
      try {
        const result = await sql<{
          bucket_start: string | null;
          bucket: string | null;
          value: string;
          record_count: string;
          with_value: string;
          value_awarded_sum: string | null;
        }>`
          select
            date_trunc(${bucket}, month_start)::date::text as bucket_start,
            to_char(date_trunc(${bucket}, month_start), ${format}) as bucket,
            count(distinct ${sql.ref(keyColumn)})::text as value,
            coalesce(sum(record_count), 0)::text as record_count,
            coalesce(sum(with_value_count), 0)::text as with_value,
            (sum(value_awarded_sum))::text as value_awarded_sum
          from ${table}
          where ${where}
          group by 1, 2
          order by 1 asc nulls last
        `.execute(db);
        return ok(
          result.rows.map((r) => ({
            bucket: r.bucket,
            value: r.value,
            recordCount: r.record_count,
            withValue: r.with_value,
            valueAwardedSum: r.value_awarded_sum,
          }))
        );
      } catch (error) {
        return err(queryFailure('distinct-series', error, startedAt, { route, buildId }));
      }
    });

  // ── breakdown (ONE window-ranked statement: top-N + other + unknown + total) ─

  const breakdownFor = (
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    dimension: string,
    topN: number,
    rankBy: 'value' | 'count'
  ): Promise<Result<AnalysisBreakdownRead, ApiError>> =>
    cached('breakdown', route, scope, buildId, [dimension, topN, rankBy], async () => {
      const startedAt = now();
      const dimColumn = BREAKDOWN_COLUMNS[dimension];
      if (dimColumn === undefined) {
        return err(databaseError(`breakdown dimension '${dimension}' has no rollup column`));
      }
      const { where, datedPred } = compileScope(route, scope, buildId);
      const table = sql.table(route.rollup.table);
      const basis = rankBy === 'value' ? sql.ref('va') : sql.ref('rc');
      try {
        const result = await sql<{
          kind: 'top' | 'other' | 'unknown' | 'total';
          key: string | null;
          rc: string;
          wv: string;
          va: string;
          we: string | null;
          ve: string | null;
          min_month: string | null;
          max_month: string | null;
          undated_rc: string | null;
          undated_va: string | null;
        }>`
          with base as (
            select ${sql.ref(dimColumn)} as key, month_start, record_count, with_value_count,
                   value_awarded_sum, with_estimated_count, value_estimated_sum
              from ${table}
             where ${where}
          ),
          per_key as (
            select key,
                   coalesce(sum(record_count) filter (where ${datedPred}), 0) as rc,
                   coalesce(sum(with_value_count) filter (where ${datedPred}), 0) as wv,
                   -- raw (nullable) money sum: null = no valued rows observed (S8)
                   sum(value_awarded_sum) filter (where ${datedPred}) as va
              from base
             group by key
          ),
          ranked as (
            -- keys with NO dated contribution (undated-only under a bounded
            -- window) are excluded from top/other; their dated totals are 0 so
            -- reconciliation is unaffected and undatedInScope still counts them.
            select pk.*, row_number() over (order by ${basis} desc nulls last, key asc) as rn
              from per_key as pk
             where key is not null and (rc > 0 or coalesce(va, 0) <> 0)
          )
          select 'top' as kind, key, rc::text as rc, wv::text as wv, va::text as va,
                 null as we, null as ve, null as min_month, null as max_month,
                 null as undated_rc, null as undated_va
            from ranked where rn <= ${topN}
          union all
          select 'other', null, coalesce(sum(rc), 0)::text, coalesce(sum(wv), 0)::text,
                 (sum(va))::text, null, null, null, null, null, null
            from ranked where rn > ${topN}
          union all
          select 'unknown', null, coalesce(sum(rc), 0)::text, coalesce(sum(wv), 0)::text,
                 (sum(va))::text, null, null, null, null, null, null
            from per_key where key is null
          union all
          select 'total', null,
                 coalesce(sum(record_count) filter (where ${datedPred}), 0)::text,
                 coalesce(sum(with_value_count) filter (where ${datedPred}), 0)::text,
                 (sum(value_awarded_sum) filter (where ${datedPred}))::text,
                 coalesce(sum(with_estimated_count) filter (where ${datedPred}), 0)::text,
                 (sum(value_estimated_sum) filter (where ${datedPred}))::text,
                 to_char(min(month_start) filter (where ${datedPred}), 'YYYY-MM'),
                 to_char(max(month_start) filter (where ${datedPred}), 'YYYY-MM'),
                 coalesce(sum(record_count) filter (where month_start is null), 0)::text,
                 (sum(value_awarded_sum) filter (where month_start is null))::text
            from base
        `.execute(db);

        const totalRow = result.rows.find((r) => r.kind === 'total');
        if (totalRow === undefined) {
          return err(databaseError('analysis breakdownFor returned no totals row'));
        }
        const buckets: AnalysisBreakdownBucketRow[] = result.rows
          .filter((r): r is typeof r & { kind: 'top' | 'other' | 'unknown' } => r.kind !== 'total')
          .map((r) => ({
            kind: r.kind,
            key: r.key,
            recordCount: r.rc,
            withValue: r.wv,
            valueAwardedSum: r.va,
          }));
        const totals: AnalysisStatsRead = {
          rows: totalRow.rc,
          withValue: totalRow.wv,
          valueAwardedSum: totalRow.va,
          withEstimated: totalRow.we ?? '0',
          valueEstimatedSum: totalRow.ve,
          minMonth: totalRow.min_month,
          maxMonth: totalRow.max_month,
          undatedCount: totalRow.undated_rc ?? '0',
          undatedValueRon: totalRow.undated_va,
        };
        return ok({ buckets, totals });
      } catch (error) {
        return err(queryFailure('breakdown', error, startedAt, { route, buildId }));
      }
    });

  // ── concentration rows (per-supplier basis measures + totals, one statement) ─

  const concentrationRowsFor = (
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    basis: 'value' | 'count'
  ): Promise<Result<ConcentrationRead, ApiError>> =>
    cached('concentration', route, scope, buildId, [basis], async () => {
      const startedAt = now();
      const measureColumn = basis === 'value' ? 'value_awarded_sum' : 'record_count';
      const { where, datedPred } = compileScope(route, scope, buildId);
      const table = sql.table(route.rollup.table);
      try {
        const result = await sql<{
          kind: 'supplier' | 'total';
          key: string | null;
          measure: string | null;
          rc: string | null;
          wv: string | null;
          va: string | null;
          we: string | null;
          ve: string | null;
          min_month: string | null;
          max_month: string | null;
          undated_rc: string | null;
          undated_va: string | null;
          unknown_measure: string | null;
        }>`
          with base as (
            select supplier_cui, month_start, record_count, with_value_count,
                   value_awarded_sum, with_estimated_count, value_estimated_sum
              from ${table}
             where ${where}
          )
          select 'supplier' as kind, supplier_cui as key,
                 coalesce(sum(${sql.ref(measureColumn)}) filter (where ${datedPred}), 0)::text as measure,
                 null as rc, null as wv, null as va, null as we, null as ve,
                 null as min_month, null as max_month, null as undated_rc, null as undated_va,
                 null as unknown_measure
            from base
           where supplier_cui is not null
           group by supplier_cui
          union all
          select 'total', null, null,
                 coalesce(sum(record_count) filter (where ${datedPred}), 0)::text,
                 coalesce(sum(with_value_count) filter (where ${datedPred}), 0)::text,
                 (sum(value_awarded_sum) filter (where ${datedPred}))::text,
                 coalesce(sum(with_estimated_count) filter (where ${datedPred}), 0)::text,
                 (sum(value_estimated_sum) filter (where ${datedPred}))::text,
                 to_char(min(month_start) filter (where ${datedPred}), 'YYYY-MM'),
                 to_char(max(month_start) filter (where ${datedPred}), 'YYYY-MM'),
                 coalesce(sum(record_count) filter (where month_start is null), 0)::text,
                 (sum(value_awarded_sum) filter (where month_start is null))::text,
                 (sum(${sql.ref(measureColumn)}) filter (where (${datedPred}) and supplier_cui is null))::text
            from base
        `.execute(db);

        const totalRow = result.rows.find((r) => r.kind === 'total');
        if (totalRow === undefined) {
          return err(databaseError('analysis concentrationRowsFor returned no totals row'));
        }
        return ok({
          rows: result.rows.flatMap((r) =>
            r.kind === 'supplier' && r.key !== null
              ? [{ supplierKey: r.key, measure: r.measure ?? '0' }]
              : []
          ),
          unknownSupplierMeasure: totalRow.unknown_measure,
          totals: {
            rows: totalRow.rc ?? '0',
            withValue: totalRow.wv ?? '0',
            valueAwardedSum: totalRow.va,
            withEstimated: totalRow.we ?? '0',
            valueEstimatedSum: totalRow.ve,
            minMonth: totalRow.min_month,
            maxMonth: totalRow.max_month,
            undatedCount: totalRow.undated_rc ?? '0',
            undatedValueRon: totalRow.undated_va,
          },
        });
      } catch (error) {
        return err(queryFailure('concentration', error, startedAt, { route, buildId }));
      }
    });

  return {
    activeGeneration,
    statsFor,
    seriesFor,
    distinctSeriesFor,
    breakdownFor,
    concentrationRowsFor,
  };
};
