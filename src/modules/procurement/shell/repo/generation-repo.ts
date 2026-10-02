/**
 * Procurement analysis — generation ledger reader.
 *
 * The analytics facts now live in ClickHouse, but the generation ledger stays
 * authoritative in Postgres `procurement.analysis_generations`: build_id,
 * published_at, the per-grain quality verdicts (the spend/time/geo gate), and
 * the informational matrix_hash. The ClickHouse analysis repo delegates its
 * `activeGeneration()` here so buildId + quality stay honest and every read
 * pins to ONE build.
 *
 *  - the active row is resolved ONCE per request via `activeGeneration()`
 *    (micro-cached ~5s), single-flight (a concurrent burst issues ONE
 *    statement); the DB's single active row is authoritative even when it
 *    points back to an older build for rollback;
 *  - the `quality` jsonb is validated grain by grain — a malformed or missing
 *    grain entry is DROPPED so `decideAnswer` abstains for it (the fail-safe);
 *  - the source catalogue receipt of each procurement stage's last succeeded
 *    run before the build started is read beside it, separately: a stage
 *    whose last run carries no valid receipt has none (never an older one),
 *    and a failed read leaves all unknown (null) without failing the
 *    generation;
 *  - errors are never cached.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  type ApiError,
  type Logger,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { ANALYSIS_GRAINS } from '../../core/constants.js';

import type { GenerationQuality, GrainQualityVerdict } from '../../core/gate-v2.js';
import type { PublishedGeneration } from '../../core/ports.js';
import type { SourceCaptureReceipts, SourceCaptureSummary } from '../../core/source-capture.js';

type Db = Kysely<ProdDatabase>;

const GENERATION_TTL_MS = 5_000;

/** The generation-reading slice of the analysis surface (delegated to by the CH repo). */
export interface ProcurementGenerationRepo {
  /** null when no generation is active (package not yet published). */
  activeGeneration(): Promise<Result<PublishedGeneration | null, ApiError>>;
}

// ── quality jsonb validation (safe parsing — never trusted raw) ────────────────

// Spend gained 'allow_disclosed' in the value-model wave (served with a
// coverage-disclosing caveat); time/geo keep the degrade ladder.
const SpendClass = Type.Union([
  Type.Literal('allow'),
  Type.Literal('allow_disclosed'),
  Type.Literal('abstain'),
]);
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
    // Supplier-party geo row coverage (geo/disclosure follow-up): absent on
    // older generations and on grains without a supplier (procedures).
    geo_supplier: Type.Optional(Type.Number()),
  }),
  // Money-weighted date/geo coverage (geo/disclosure wave): additive from
  // generation 8, absent on older generations — optional so both validate.
  coverage_money: Type.Optional(
    Type.Object({
      date: Type.Number(),
      geo: Type.Number(),
      geo_supplier: Type.Optional(Type.Number()),
    })
  ),
  classes: Type.Object({
    spend: SpendClass,
    time: AllowDegradedAbstain,
    geo: AllowDegradedAbstain,
  }),
});

// ── source capture (loader receipts in etl.load_runs notes) ───────────────────

const ListingRouteSchema = Type.Union([
  Type.Object({ status: Type.Literal('unknown') }),
  Type.Object({
    status: Type.Literal('recency_only'),
    latestSucceededWindowEnd: Type.String(),
    latestCompletedAt: Type.Union([Type.String(), Type.Null()]),
    unfinishedWindowsBefore: Type.Integer({ minimum: 0 }),
  }),
]);

const SourceCaptureSchema = Type.Object({
  seap: Type.Record(
    Type.String(),
    Type.Object({ latestYear: Type.Union([Type.Integer(), Type.Null()]) })
  ),
  elicitatie: Type.Record(Type.String(), ListingRouteSchema),
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

export const makeProcurementGenerationRepo = (
  db: Db,
  now: () => number = Date.now,
  logger?: Logger
): ProcurementGenerationRepo => {
  // ── the active generation (micro-cached) ────────────────────────────────────
  //
  // Single-flight: concurrent callers past the TTL await ONE in-flight refresh
  // (no thundering herd on the pointer table). The database's single active row
  // is authoritative even when it points back to an older build for rollback.
  // Errors are never cached.

  // Per stage, the catalogue block of its LAST succeeded run that finished
  // before the build started — that run's receipt or none, never an older
  // one. Read-only, outside the generation statement: a missing grant or a
  // non-JSON note read as unknown (null), never as an error.
  const readSourceCapture = async (
    buildId: string,
    startedAt: string | null
  ): Promise<SourceCaptureReceipts | null> => {
    try {
      const result = await sql<{ target_table: string; source_capture: unknown }>`
        select r.target_table,
               case when r.notes like '{%"sourceCapture"%'
                    then (r.notes::jsonb) -> 'sourceCapture' end as source_capture
        from (
          select distinct on (target_table) target_table, notes
          from etl.load_runs
          where source_id = 'public-contracts' and status = 'succeeded'
            and target_table in ('procurement.procedures', 'procurement.contracts',
                                 'procurement.direct_acquisitions')
            and finished_at <= coalesce(${startedAt}::timestamptz, now())
          order by target_table, finished_at desc
        ) r`.execute(db);
      const receipts: Record<string, SourceCaptureSummary> = {};
      for (const row of result.rows) {
        if (Value.Check(SourceCaptureSchema, row.source_capture)) {
          receipts[row.target_table] = row.source_capture;
        }
      }
      return receipts;
    } catch (error) {
      logger?.warn(
        { buildId, error: error instanceof Error ? error.message : String(error) },
        'procurement source capture unknown: read failed'
      );
      return null;
    }
  };

  let generationCache: { value: PublishedGeneration | null; expiresAt: number } | null = null;
  let generationInFlight: Promise<Result<PublishedGeneration | null, ApiError>> | null = null;

  const refreshGeneration = async (): Promise<Result<PublishedGeneration | null, ApiError>> => {
    const startedAt = now();
    try {
      const row = await db
        .selectFrom('procurement.analysis_generations as g')
        .select([
          sql<string>`g.build_id::text`.as('build_id'),
          sql<string | null>`g.published_at::text`.as('published_at'),
          sql<string | null>`g.started_at::text`.as('started_at'),
          'g.quality',
          'g.matrix_hash',
        ])
        .where(sql<SqlBool>`g.status = 'active'`)
        .orderBy('g.build_id', 'desc')
        .limit(1)
        .executeTakeFirst();
      const fresh: PublishedGeneration | null =
        row === undefined
          ? null
          : {
              buildId: row.build_id,
              publishedAt: row.published_at,
              quality: parseQuality(row.quality),
              matrixHash: row.matrix_hash,
              sourceCapture: await readSourceCapture(row.build_id, row.started_at ?? null),
            };
      generationCache = { value: fresh, expiresAt: now() + GENERATION_TTL_MS };
      return ok(fresh);
    } catch (error) {
      logger?.warn(
        { operation: 'activeGeneration', elapsedMs: Math.max(0, now() - startedAt) },
        'procurement analysis generation read failed'
      );
      return err(databaseError('procurement analysis activeGeneration failed', error));
    }
  };

  const activeGeneration = async (): Promise<Result<PublishedGeneration | null, ApiError>> => {
    if (generationCache !== null && generationCache.expiresAt > now()) {
      return ok(generationCache.value);
    }
    if (generationInFlight !== null) return generationInFlight;
    generationInFlight = refreshGeneration().finally(() => {
      generationInFlight = null;
    });
    return generationInFlight;
  };

  return { activeGeneration };
};
