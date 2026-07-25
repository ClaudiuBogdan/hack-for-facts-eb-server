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
import type { ActiveGeneration } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const GENERATION_TTL_MS = 5_000;

/** The generation-reading slice of the analysis surface (delegated to by the CH repo). */
export interface ProcurementGenerationRepo {
  /** null when no generation is active (package not yet published). */
  activeGeneration(): Promise<Result<ActiveGeneration | null, ApiError>>;
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
      logger?.warn(
        { operation: 'activeGeneration', elapsedMs: Math.max(0, now() - startedAt) },
        'procurement analysis generation read failed'
      );
      return err(databaseError('procurement analysis activeGeneration failed', error));
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

  return { activeGeneration };
};
