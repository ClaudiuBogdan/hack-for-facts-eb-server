/**
 * Procurement analysis — the shape executors (design §5.2). Pure, deps-first,
 * `Result`-returning; GraphQL and MCP call the SAME executors (tri-surface parity).
 *
 * Invariants enforced here, not in the shell:
 *  - ONE generation per request: every top-level executor resolves the active
 *    generation ONCE and pins every read (and every derived operand — share,
 *    facets) to that buildId, so a cutover mid-request cannot mix builds;
 *  - grains never merge: every answer is an array of LABELED per-grain blocks,
 *    and there is no cross-grain sum field anywhere;
 *  - gate composition (design §5.4): spend gates money; time is consulted when
 *    the scope is time-bounded or the shape is a series; geo when the scope or
 *    dimension involves buyer geography. Degraded classes serve WITH caveats;
 *    an abstaining class blocks the shape for that grain — and a blocked block
 *    never fabricates reads (its envelope counts are null, not zero);
 *  - money is null when unobserved OR gate-abstained (never zero), with caveats
 *    distinguishing the two;
 *  - quarter/year series are derived in core ONLY for additive laws; distinct
 *    counts are bucketed by the repo (COUNT(DISTINCT) per bucket) and never
 *    re-bucketed here;
 *  - breakdowns reconcile by construction: top + other + unknown must sum to the
 *    same read's totals, and a mismatch is an internal error, not an answer;
 *  - shares are validated derivations over two stats reads — an operand failure
 *    IS the answer, never a partial ratio.
 *
 * All ratio/money arithmetic is `decimal.js`; ratios are emitted as decimal
 * STRINGS (§14.1 — no floats on the wire).
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  canonicalScopeEcho,
  isSubsetScope,
  sameWindow,
  scopeDims,
  scopeWindow,
  type AnalysisScope,
} from './analysis-scope.js';
import { ANALYSIS_MATRIX_SHA256, routeAnalysis, type AnalysisRoute } from './combinations.js';
import { buildEnvelope, type AnswerEnvelope, type EnvelopeReads } from './envelope.js';
import { decideAnswer, type AnswerabilityReason, type GateDecision } from './gate-v2.js';
import { anchorPolicy, policyFor, type PolicyEntry } from './policy.js';

import type { AnalysisGrain, BreakdownDimension, MeasureId, SeriesBucket } from './constants.js';
import type { ActiveGeneration, AnalysisRepo, AnalysisStatsRead } from './ports.js';

export interface AnalysisDeps {
  readonly analysisRepo: AnalysisRepo;
}

// ── result shapes ──────────────────────────────────────────────────────────────

/** Count fields are null ONLY when the whole block is gate-blocked (not read). */
export interface AnalysisStatsBlock {
  readonly grain: AnalysisGrain;
  readonly recordCount: string | null;
  readonly withValueCount: string | null;
  readonly withEstimatedCount: string | null;
  readonly valueAwardedSum: string | null;
  readonly valueEstimatedSum: string | null;
  readonly avgValueAwarded: string | null;
  readonly minMonth: string | null;
  readonly maxMonth: string | null;
  readonly meta: AnswerEnvelope;
}

export interface AnalysisStatsResult {
  /** Labeled per-grain blocks, side by side — NEVER a cross-grain sum. */
  readonly blocks: readonly AnalysisStatsBlock[];
}

export interface AnalysisSeriesPoint {
  readonly bucket: string;
  readonly value: string | null;
}

export interface AnalysisSeriesBlock {
  readonly grain: AnalysisGrain;
  readonly measure: MeasureId;
  readonly bucket: SeriesBucket;
  readonly points: readonly AnalysisSeriesPoint[];
  readonly meta: AnswerEnvelope;
}

export interface AnalysisBreakdownBucket {
  readonly key: string | null;
  readonly kind: 'top' | 'other' | 'unknown';
  readonly recordCount: string;
  readonly withValueCount: string;
  readonly valueAwardedSum: string | null;
  /** Share of the scope total on the ranking basis, as a decimal string. */
  readonly shareOfScope: string | null;
}

export interface AnalysisBreakdownBlock {
  readonly grain: AnalysisGrain;
  readonly dimension: BreakdownDimension;
  readonly rankedBy: 'value' | 'count';
  readonly buckets: readonly AnalysisBreakdownBucket[];
  readonly meta: AnswerEnvelope;
}

export interface AnalysisConcentrationBlock {
  readonly grain: AnalysisGrain;
  readonly basis: 'value' | 'count';
  /** Distinct KNOWN suppliers in scope; null when the block is gate-blocked. */
  readonly supplierCount: number | null;
  readonly top1Share: string | null;
  readonly top5Share: string | null;
  readonly hhi: string | null;
  readonly totalRon: string | null;
  readonly meta: AnswerEnvelope;
}

export interface AnalysisShareResult {
  readonly share: string | null;
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason?: AnswerabilityReason;
  readonly numerator: AnalysisStatsBlock;
  readonly denominator: AnalysisStatsBlock;
  readonly caveats: readonly string[];
}

export interface AnalysisFacetsResult {
  readonly blocks: readonly AnalysisBreakdownBlock[];
}

// ── shared helpers ─────────────────────────────────────────────────────────────

export const TOPN_DEFAULT = 10;
export const TOPN_MAX = 50;
export const FACET_DIMENSIONS_MAX = 3;

const RATIO_DP = 4;
const MONEY_DP = 2;

const d = (v: string | null | undefined): Decimal => new Decimal(v ?? '0');

/** Resolve the active generation or fail with the clean not-published error. */
const activeGen = async (repo: AnalysisRepo): Promise<Result<ActiveGeneration, ApiError>> => {
  const r = await repo.activeGeneration();
  if (r.isErr()) return err(r.error);
  if (r.value === null) {
    return err(serviceUnavailable('procurement analysis package not published'));
  }
  if (r.value.matrixHash !== ANALYSIS_MATRIX_SHA256) {
    return err(
      serviceUnavailable(
        `procurement analysis matrix mismatch: active generation ${r.value.matrixHash ?? 'null'}, server ${ANALYSIS_MATRIX_SHA256}`
      )
    );
  }
  return ok(r.value);
};

const PROCEDURE_LIFECYCLE_NOTE =
  'procedures are tender lifecycles (a procedure yields contracts) — never sum this count with contract/direct-acquisition counts';

const NO_AWARDED_VALUES_CAVEAT =
  'no awarded values observed in scope — the sum is null (unobserved), not zero';

const grainNotes = (grain: AnalysisGrain): readonly string[] =>
  grain === 'procedure' ? [PROCEDURE_LIFECYCLE_NOTE] : [];

/** The stats read projected onto the envelope's fields. */
const readsOf = (read: AnalysisStatsRead): EnvelopeReads => ({
  rows: read.rows,
  withValue: read.withValue,
  undatedCount: read.undatedCount,
  undatedValueRon: read.undatedValueRon,
});

// Every grain declares valueAwardedSum; it carries the stats block's value
// basis, date basis and terminality.
const statsPolicy = (grain: AnalysisGrain): PolicyEntry => anchorPolicy(grain, 'valueAwardedSum');

/** AND-compose gate decisions: any abstain blocks; degradations and caveats merge. */
const composeGates = (decisions: readonly GateDecision[]): GateDecision => {
  const reason =
    decisions.find((decision) => !decision.allow && decision.reason !== undefined)?.reason ??
    decisions.find((decision) => decision.degraded && decision.reason !== undefined)?.reason;
  return {
    allow: decisions.every((decision) => decision.allow),
    degraded: decisions.some((decision) => decision.degraded),
    caveats: decisions.flatMap((decision) => decision.caveats),
    ...(reason === undefined ? {} : { reason }),
  };
};

/**
 * The gate classes a SHAPE must pass for a grain (design §5.4, S3): `time`
 * whenever the scope is time-bounded or the shape is a series; `geo` whenever
 * buyer geography is in the scope or is the breakdown dimension. Spend is NOT
 * here — it gates money fields/bases, not the shape.
 */
const shapeGate = (
  gen: ActiveGeneration,
  grain: AnalysisGrain,
  scope: AnalysisScope,
  options: { readonly isSeries?: boolean; readonly dimension?: BreakdownDimension }
): GateDecision => {
  const decisions: GateDecision[] = [];
  if (options.isSeries === true || scopeWindow(scope) !== undefined) {
    decisions.push(decideAnswer(gen.quality, grain, 'time'));
  }
  if (scope.buyerRegion !== undefined || options.dimension === 'buyerRegion') {
    decisions.push(decideAnswer(gen.quality, grain, 'geo'));
  }
  return composeGates(decisions);
};

// ── stats ──────────────────────────────────────────────────────────────────────

const statsBlockFor = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  route: AnalysisRoute,
  scope: AnalysisScope,
  canonicalScope: string
): Promise<Result<AnalysisStatsBlock, ApiError>> => {
  const { grain } = route;
  const spend = decideAnswer(gen.quality, grain, 'spend');
  const blockGate = shapeGate(gen, grain, scope, {});

  // An abstaining time/geo class blocks the whole block for this grain — no read
  // happens and nothing is fabricated (envelope reads are null, not zero).
  if (!blockGate.allow) {
    return ok({
      grain,
      recordCount: null,
      withValueCount: null,
      withEstimatedCount: null,
      valueAwardedSum: null,
      valueEstimatedSum: null,
      avgValueAwarded: null,
      minMonth: null,
      maxMonth: null,
      meta: buildEnvelope(
        statsPolicy(grain),
        composeGates([blockGate, spend]),
        gen.buildId,
        null,
        canonicalScope,
        spend.allow,
        grainNotes(grain)
      ),
    });
  }

  const readR = await deps.analysisRepo.statsFor(route, scope, gen.buildId);
  if (readR.isErr()) return err(readR.error);
  const read = readR.value;

  // Money is null when the gate abstains AND when no valued rows were observed —
  // the caveat distinguishes the two; it is never coalesced to zero (S8).
  const awardedObserved = read.valueAwardedSum !== null;
  const awarded = spend.allow && awardedObserved ? d(read.valueAwardedSum).toFixed(MONEY_DP) : null;
  const estimated =
    spend.allow && read.valueEstimatedSum !== null
      ? d(read.valueEstimatedSum).toFixed(MONEY_DP)
      : null;
  const withValue = d(read.withValue);
  const avg =
    awarded !== null && withValue.greaterThan(0)
      ? d(read.valueAwardedSum).div(withValue).toFixed(MONEY_DP)
      : null;
  const noValueCaveats = spend.allow && !awardedObserved ? [NO_AWARDED_VALUES_CAVEAT] : [];

  return ok({
    grain,
    recordCount: read.rows,
    withValueCount: read.withValue,
    withEstimatedCount: read.withEstimated,
    valueAwardedSum: awarded,
    valueEstimatedSum: estimated,
    avgValueAwarded: avg,
    minMonth: read.minMonth,
    maxMonth: read.maxMonth,
    meta: buildEnvelope(
      statsPolicy(grain),
      composeGates([blockGate, spend]),
      gen.buildId,
      readsOf(read),
      canonicalScope,
      spend.allow,
      [...noValueCaveats, ...grainNotes(grain)]
    ),
  });
};

/** Stats over an ALREADY-RESOLVED generation (share/facets reuse it — S1). */
const statsWithGen = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  scope: AnalysisScope
): Promise<Result<AnalysisStatsResult, ApiError>> => {
  const routesR = routeAnalysis(scope, 'stats');
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = canonicalScopeEcho(scope);

  const blocks: AnalysisStatsBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await statsBlockFor(deps, gen, route, scope, canonicalScope);
    if (blockR.isErr()) return err(blockR.error);
    blocks.push(blockR.value);
  }
  return ok({ blocks });
};

/** `procurementStats` — labeled per-grain blocks; no cross-grain sum exists. */
export const analysisStats = async (
  deps: AnalysisDeps,
  input: { readonly scope: AnalysisScope }
): Promise<Result<AnalysisStatsResult, ApiError>> => {
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  return statsWithGen(deps, genR.value, input.scope);
};

// ── series ─────────────────────────────────────────────────────────────────────

/** 'YYYY-MM' → the requested bucket label ('YYYY-MM' | 'YYYY-Qn' | 'YYYY'). */
const bucketLabel = (month: string, bucket: SeriesBucket): string => {
  if (bucket === 'month') return month;
  const year = month.slice(0, 4);
  if (bucket === 'year') return year;
  const q = Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
  return `${year}-Q${String(q)}`;
};

export const analysisSeries = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly bucket: SeriesBucket;
    readonly measure: MeasureId;
  }
): Promise<Result<readonly AnalysisSeriesBlock[], ApiError>> => {
  const { scope, bucket, measure } = input;

  if (scope.grain !== undefined && policyFor(scope.grain, measure) === undefined) {
    return err(
      invalidInput(
        `measure '${measure}' is not declared for grain '${scope.grain}' (see the policy table)`,
        'measure'
      )
    );
  }

  const routesR = routeAnalysis(scope, 'series', undefined, measure);
  if (routesR.isErr()) return err(routesR.error);
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  const gen = genR.value;
  const canonicalScope = canonicalScopeEcho(scope);

  const blocks: AnalysisSeriesBlock[] = [];
  for (const route of routesR.value) {
    const { grain } = route;
    const policy = policyFor(grain, measure);
    if (policy === undefined) continue; // implicit grain without the measure
    if (!policy.legalShapes.includes('series')) {
      return err(
        invalidInput(
          `measure '${measure}' is not legal for shape 'series' (legal shapes: ${policy.legalShapes.join(', ')})`,
          'measure'
        )
      );
    }

    const spend = decideAnswer(gen.quality, grain, 'spend');
    const blockedBlock = (gated: GateDecision): AnalysisSeriesBlock => ({
      grain,
      measure,
      bucket,
      points: [],
      meta: buildEnvelope(policy, gated, gen.buildId, null, canonicalScope, spend.allow),
    });

    // Structurally blocked time answers (procedure grain until M1).
    if (policy.blocked !== undefined) {
      const caveat = `${policy.policyKey}: time answers are blocked (${policy.blocked.reason}; unblocks at ${policy.blocked.milestone})`;
      blocks.push(
        blockedBlock({
          allow: false,
          degraded: false,
          caveats: [caveat],
          reason: 'GENERATION_LACKS_CAPABILITY',
        })
      );
      continue;
    }

    const gated = composeGates([
      shapeGate(gen, grain, scope, { isSeries: true }),
      ...(policy.gateClass === 'spend' ? [spend] : []),
    ]);
    if (!gated.allow) {
      blocks.push(blockedBlock(gated));
      continue;
    }

    if (policy.law === 'distinct') {
      const key = measure === 'distinctSuppliers' ? 'supplier' : 'authority';
      const rowsR = await deps.analysisRepo.distinctSeriesFor(
        route,
        scope,
        gen.buildId,
        key,
        bucket
      );
      if (rowsR.isErr()) return err(rowsR.error);
      const rows = rowsR.value;
      const undated = rows.find((r) => r.bucket === null);
      const reads: EnvelopeReads = {
        rows: rows.reduce((acc, r) => acc.plus(r.recordCount), new Decimal(0)).toFixed(0),
        withValue: rows.reduce((acc, r) => acc.plus(r.withValue), new Decimal(0)).toFixed(0),
        undatedCount: undated?.recordCount ?? '0',
        undatedValueRon: undated?.valueAwardedSum ?? null,
      };
      blocks.push({
        grain,
        measure,
        bucket,
        points: rows.flatMap((r) =>
          r.bucket === null ? [] : [{ bucket: r.bucket, value: r.value }]
        ),
        meta: buildEnvelope(policy, gated, gen.buildId, reads, canonicalScope, spend.allow, [
          'distinct counts are computed per bucket and must never be summed across buckets',
          ...grainNotes(grain),
        ]),
      });
      continue;
    }

    // Additive law: monthly storage; quarter/year derived here, and ONLY here.
    const rowsR = await deps.analysisRepo.seriesFor(route, scope, gen.buildId, measure);
    if (rowsR.isErr()) return err(rowsR.error);
    const rows = rowsR.value;
    const undated = rows.find((r) => r.month === null);

    // A bucket whose contributing months all report null stays null (unobserved
    // money, S8) — only observed values are summed.
    const byBucket = new Map<string, Decimal | null>();
    for (const row of rows) {
      if (row.month === null) continue;
      const label = bucketLabel(row.month, bucket);
      const previous = byBucket.has(label) ? (byBucket.get(label) ?? null) : null;
      if (row.value === null) {
        if (!byBucket.has(label)) byBucket.set(label, null);
        continue;
      }
      byBucket.set(label, (previous ?? new Decimal(0)).plus(row.value));
    }
    const isMoney = policy.valueBasis !== null;
    const points: AnalysisSeriesPoint[] = [...byBucket.entries()].map(([label, value]) => ({
      bucket: label,
      value: value !== null ? value.toFixed(isMoney ? MONEY_DP : 0) : null,
    }));

    const reads: EnvelopeReads = {
      rows: rows.reduce((acc, r) => acc.plus(r.recordCount), new Decimal(0)).toFixed(0),
      withValue: rows.reduce((acc, r) => acc.plus(r.withValue), new Decimal(0)).toFixed(0),
      undatedCount: undated?.recordCount ?? '0',
      undatedValueRon: undated?.valueAwardedSum ?? null,
    };
    blocks.push({
      grain,
      measure,
      bucket,
      points,
      meta: buildEnvelope(
        policy,
        gated,
        gen.buildId,
        reads,
        canonicalScope,
        spend.allow,
        grainNotes(grain)
      ),
    });
  }
  return ok(blocks);
};

// ── breakdown ──────────────────────────────────────────────────────────────────

const normalizeTopN = (topN: number | undefined): Result<number, ApiError> => {
  if (topN === undefined) return ok(TOPN_DEFAULT);
  if (!Number.isInteger(topN) || topN < 1 || topN > TOPN_MAX) {
    return err(invalidInput(`topN must be an integer from 1 to ${String(TOPN_MAX)}`, 'topN'));
  }
  return ok(topN);
};

const breakdownBlockFor = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  route: AnalysisRoute,
  scope: AnalysisScope,
  dimension: BreakdownDimension,
  topN: number,
  canonicalScope: string
): Promise<Result<AnalysisBreakdownBlock, ApiError>> => {
  const { grain } = route;
  const spend = decideAnswer(gen.quality, grain, 'spend');
  const blockGate = shapeGate(gen, grain, scope, { dimension });

  const rankedBy: 'value' | 'count' = spend.allow ? 'value' : 'count';
  const rankCaveats =
    rankedBy === 'count'
      ? ['ranked by record count (awarded-value ranking is gate-suppressed)']
      : [];
  const policy = anchorPolicy(grain, rankedBy === 'value' ? 'valueAwardedSum' : 'recordCount');

  if (!blockGate.allow) {
    return ok({
      grain,
      dimension,
      rankedBy,
      buckets: [],
      meta: buildEnvelope(
        policy,
        composeGates([blockGate, spend]),
        gen.buildId,
        null,
        canonicalScope,
        spend.allow,
        grainNotes(grain)
      ),
    });
  }

  const readR = await deps.analysisRepo.breakdownFor(
    route,
    scope,
    gen.buildId,
    dimension,
    topN,
    rankedBy
  );
  if (readR.isErr()) return err(readR.error);
  const { buckets, totals } = readR.value;

  // Reconciliation by construction (design §3.3): the three bucket kinds must sum
  // exactly to the same read's totals. A mismatch is an internal fault. Null money
  // sums count as zero for the arithmetic (they carry no observed value).
  const sum = (pick: (b: (typeof buckets)[number]) => string | null): Decimal =>
    buckets.reduce((acc, b) => acc.plus(pick(b) ?? '0'), new Decimal(0));
  const rowsOk = sum((b) => b.recordCount).equals(d(totals.rows));
  const withValueOk = sum((b) => b.withValue).equals(d(totals.withValue));
  const moneyOk = !spend.allow || sum((b) => b.valueAwardedSum).equals(d(totals.valueAwardedSum));
  if (!rowsOk || !withValueOk || !moneyOk) {
    return err(
      databaseError(
        `breakdown(${dimension}) reconciliation failed for grain '${grain}': top+other+unknown do not sum to the scope totals (internal error)`
      )
    );
  }

  const basisTotal = rankedBy === 'value' ? d(totals.valueAwardedSum) : d(totals.rows);
  const outBuckets: AnalysisBreakdownBucket[] = buckets.map((b) => {
    const basisValue = rankedBy === 'value' ? d(b.valueAwardedSum) : d(b.recordCount);
    return {
      key: b.key,
      kind: b.kind,
      recordCount: b.recordCount,
      withValueCount: b.withValue,
      valueAwardedSum:
        spend.allow && b.valueAwardedSum !== null ? d(b.valueAwardedSum).toFixed(MONEY_DP) : null,
      shareOfScope: basisTotal.greaterThan(0) ? basisValue.div(basisTotal).toFixed(RATIO_DP) : null,
    };
  });

  const answerGate = composeGates([blockGate, spend]);
  const gate: GateDecision = {
    ...answerGate,
    caveats: [...answerGate.caveats, ...rankCaveats],
  };
  return ok({
    grain,
    dimension,
    rankedBy,
    buckets: outBuckets,
    meta: buildEnvelope(
      policy,
      gate,
      gen.buildId,
      readsOf(totals),
      canonicalScope,
      spend.allow,
      grainNotes(grain)
    ),
  });
};

export const analysisBreakdown = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly dimension: BreakdownDimension;
    readonly topN?: number;
  }
): Promise<Result<readonly AnalysisBreakdownBlock[], ApiError>> => {
  const topNR = normalizeTopN(input.topN);
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  const routesR = routeAnalysis(input.scope, 'breakdown', input.dimension);
  if (routesR.isErr()) return err(routesR.error);
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await breakdownBlockFor(
      deps,
      genR.value,
      route,
      input.scope,
      input.dimension,
      topN,
      canonicalScope
    );
    if (blockR.isErr()) return err(blockR.error);
    blocks.push(blockR.value);
  }
  return ok(blocks);
};

// ── concentration ──────────────────────────────────────────────────────────────

export const analysisConcentration = async (
  deps: AnalysisDeps,
  input: { readonly scope: AnalysisScope; readonly basis?: 'value' | 'count' }
): Promise<Result<readonly AnalysisConcentrationBlock[], ApiError>> => {
  const routesR = routeAnalysis(input.scope, 'concentration');
  if (routesR.isErr()) return err(routesR.error);
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  const gen = genR.value;
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisConcentrationBlock[] = [];
  for (const route of routesR.value) {
    const { grain } = route;
    const spend = decideAnswer(gen.quality, grain, 'spend');
    const basis: 'value' | 'count' = input.basis ?? 'count';
    const policy = anchorPolicy(grain, basis === 'value' ? 'valueAwardedSum' : 'recordCount');

    const blockGate = shapeGate(gen, grain, input.scope, {});
    const requestedGate = basis === 'value' ? composeGates([blockGate, spend]) : blockGate;
    if (!requestedGate.allow) {
      blocks.push({
        grain,
        basis,
        supplierCount: null,
        top1Share: null,
        top5Share: null,
        hhi: null,
        totalRon: null,
        meta: buildEnvelope(
          policy,
          requestedGate,
          gen.buildId,
          null,
          canonicalScope,
          basis === 'value' && spend.allow,
          grainNotes(grain)
        ),
      });
      continue;
    }

    const readR = await deps.analysisRepo.concentrationRowsFor(
      route,
      input.scope,
      gen.buildId,
      basis
    );
    if (readR.isErr()) return err(readR.error);
    const { rows, totals, unknownSupplierMeasure } = readR.value;

    // supplierCount = distinct KNOWN suppliers in scope; HHI/top shares are
    // computed over the positive-basis subset only — both facts are disclosed.
    const measures = rows.map((r) => new Decimal(r.measure)).filter((v) => v.greaterThan(0));
    const total = measures.reduce((acc, v) => acc.plus(v), new Decimal(0));
    const sorted = [...measures].sort((a, b) => b.comparedTo(a));
    const top1 = sorted[0] ?? new Decimal(0);
    const top5 = sorted.slice(0, 5).reduce((acc, v) => acc.plus(v), new Decimal(0));
    const hhi = total.greaterThan(0)
      ? measures.reduce((acc, v) => acc.plus(v.div(total).pow(2)), new Decimal(0))
      : null;

    const basisLabel = basis === 'value' ? 'awarded value' : 'record count';
    const semanticsCaveats = [
      `HHI/top shares are computed over known suppliers with positive ${basisLabel} (${String(measures.length)} of ${String(rows.length)} known suppliers)`,
      ...(unknownSupplierMeasure !== null && d(unknownSupplierMeasure).greaterThan(0)
        ? [
            `records with an unknown supplier are excluded from concentration and hold ${unknownSupplierMeasure} of ${basisLabel} in scope`,
          ]
        : []),
    ];

    blocks.push({
      grain,
      basis,
      supplierCount: rows.length,
      top1Share: total.greaterThan(0) ? top1.div(total).toFixed(RATIO_DP) : null,
      top5Share: total.greaterThan(0) ? top5.div(total).toFixed(RATIO_DP) : null,
      hhi: hhi !== null ? hhi.toFixed(RATIO_DP) : null,
      // Null (not zero) when no positive-basis supplier was observed (S8).
      totalRon: basis === 'value' && measures.length > 0 ? total.toFixed(MONEY_DP) : null,
      meta: buildEnvelope(
        policy,
        {
          allow: true,
          degraded: blockGate.degraded,
          caveats: blockGate.caveats,
          ...(blockGate.reason === undefined ? {} : { reason: blockGate.reason }),
        },
        gen.buildId,
        readsOf(totals),
        canonicalScope,
        basis === 'value' && spend.allow,
        [...semanticsCaveats, ...grainNotes(grain)]
      ),
    });
  }
  return ok(blocks);
};

// ── share (a validated derivation over two stats reads, design §3.3) ───────────

export const analysisShare = async (
  deps: AnalysisDeps,
  input: { readonly numerator: AnalysisScope; readonly denominator: AnalysisScope }
): Promise<Result<AnalysisShareResult, ApiError>> => {
  const { numerator, denominator } = input;

  if (numerator.grain === undefined || numerator.grain !== denominator.grain) {
    return err(
      invalidInput(
        'share requires the same EXPLICIT grain on both operands (money never mixes across grains)',
        'grain'
      )
    );
  }
  // Periods compare via the NORMALIZED window: year 2024 == from 2024-01 to 2024-12.
  if (!sameWindow(numerator, denominator)) {
    return err(
      invalidInput('share operands must cover an identical period (from/to/year)', 'numerator')
    );
  }
  // STRICT subset: every denominator constraint set identically on the numerator,
  // AND at least one additional numerator constraint — identical scopes are a
  // tautology (share 1), not a derivation.
  if (
    !isSubsetScope(numerator, denominator) ||
    scopeDims(numerator).length <= scopeDims(denominator).length
  ) {
    return err(
      invalidInput(
        'numerator scope must be a STRICT subset of the denominator scope: every denominator constraint set identically on the numerator, plus at least one narrower constraint',
        'numerator'
      )
    );
  }

  // ONE generation pins BOTH operands (S1) — a cutover between the two stats
  // reads cannot produce a cross-build ratio.
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  const gen = genR.value;

  const spend = decideAnswer(gen.quality, numerator.grain, 'spend');
  const [numR, denR] = await Promise.all([
    statsWithGen(deps, gen, numerator),
    statsWithGen(deps, gen, denominator),
  ]);
  if (numR.isErr()) return err(numR.error);
  if (denR.isErr()) return err(denR.error);
  const numBlock = numR.value.blocks[0];
  const denBlock = denR.value.blocks[0];
  if (numBlock === undefined || denBlock === undefined) {
    return err(invalidInput('share operands did not resolve to a servable grain', 'numerator'));
  }
  if (!spend.allow) {
    return ok({
      share: null,
      answerability: 'abstained',
      reason: spend.reason ?? 'SPEND_COVERAGE_BELOW_GATE',
      numerator: numBlock,
      denominator: denBlock,
      caveats: spend.caveats,
    });
  }
  if (numBlock.meta.counts === null || denBlock.meta.counts === null) {
    const blocked = numBlock.meta.counts === null ? numBlock : denBlock;
    return ok({
      share: null,
      answerability: 'abstained',
      reason: blocked.meta.reason ?? 'MISSING_QUALITY_VERDICT',
      numerator: numBlock,
      denominator: denBlock,
      caveats: [
        `the ${blocked === numBlock ? 'numerator' : 'denominator'} stats block abstained`,
        ...blocked.meta.caveats,
      ],
    });
  }

  const degradedOperand = [numBlock, denBlock].find(
    (block) => block.meta.answerability === 'degraded'
  );
  const caveats: string[] = degradedOperand === undefined ? [] : [...degradedOperand.meta.caveats];
  let share: string | null = null;
  if (denBlock.valueAwardedSum === null || numBlock.valueAwardedSum === null) {
    caveats.push(
      `${denBlock.valueAwardedSum === null ? 'denominator' : 'numerator'} has no observed awarded values in scope — no ratio is derivable`
    );
  } else {
    const den = new Decimal(denBlock.valueAwardedSum);
    if (den.greaterThan(0)) {
      share = new Decimal(numBlock.valueAwardedSum).div(den).toFixed(RATIO_DP);
    } else {
      caveats.push('denominator has zero awarded value in scope — no ratio is derivable');
    }
  }
  return ok({
    share,
    answerability: degradedOperand === undefined ? 'served' : 'degraded',
    ...(degradedOperand?.meta.reason === undefined ? {} : { reason: degradedOperand.meta.reason }),
    numerator: numBlock,
    denominator: denBlock,
    caveats,
  });
};

// ── facets (batched breakdowns, one resolver round trip) ──────────────────────

/**
 * Statement budget (design §7.0): one micro-cached generation pointer read +
 * at most `FACET_DIMENSIONS_MAX` breakdown statements — which is why facets
 * require an EXPLICIT grain (an implicit grain would multiply the reads per
 * grain and blow the ≤4-statement budget).
 */
export const analysisFacets = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly dimensions: readonly BreakdownDimension[];
    readonly topN?: number;
  }
): Promise<Result<AnalysisFacetsResult, ApiError>> => {
  if (input.scope.grain === undefined) {
    return err(
      invalidInput(
        `facets require an explicit scope.grain — one grain keeps the request at ≤${String(FACET_DIMENSIONS_MAX)} breakdown reads (per-grain facets would multiply them)`,
        'grain'
      )
    );
  }
  const dimensions = [...new Set(input.dimensions)];
  if (dimensions.length === 0 || dimensions.length > FACET_DIMENSIONS_MAX) {
    return err(
      invalidInput(
        `facets take 1–${String(FACET_DIMENSIONS_MAX)} distinct dimensions`,
        'dimensions'
      )
    );
  }

  const topNR = normalizeTopN(input.topN);
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  // Route every dimension up front — one bad dimension rejects the whole request
  // with the matrix's named capability, before any read runs.
  const routed: { dimension: BreakdownDimension; routes: readonly AnalysisRoute[] }[] = [];
  for (const dimension of dimensions) {
    const routesR = routeAnalysis(input.scope, 'breakdown', dimension);
    if (routesR.isErr()) return err(routesR.error);
    routed.push({ dimension, routes: routesR.value });
  }

  // ONE generation for every facet (S1).
  const genR = await activeGen(deps.analysisRepo);
  if (genR.isErr()) return err(genR.error);
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const { dimension, routes } of routed) {
    for (const route of routes) {
      const blockR = await breakdownBlockFor(
        deps,
        genR.value,
        route,
        input.scope,
        dimension,
        topN,
        canonicalScope
      );
      if (blockR.isErr()) return err(blockR.error);
      blocks.push(blockR.value);
    }
  }
  return ok({ blocks });
};
