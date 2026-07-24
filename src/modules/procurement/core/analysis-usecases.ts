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
  scopeRowFilters,
  scopeWindow,
  type AnalysisScope,
} from './analysis-scope.js';
import { routeAnalysis, type AnalysisRoute } from './combinations.js';
import {
  TOPN_SIRUTA_MAX,
  type AnalysisGrain,
  type BreakdownDimension,
  type MeasureId,
  type SeriesBucket,
} from './constants.js';
import { buildEnvelope, type AnswerEnvelope, type EnvelopeReads } from './envelope.js';
import {
  decideAnswer,
  decideMoney,
  type AnswerabilityReason,
  type BasisCoverageRow,
  type GateDecision,
} from './gate-v2.js';
import {
  anchorPolicy,
  moneyAnchorMeasure,
  policyFor,
  type PolicyEntry,
  type ValueBasis,
} from './policy.js';

import type { ActiveGeneration, AnalysisRepo, AnalysisStatsRead } from './ports.js';

export interface AnalysisDeps {
  readonly analysisRepo: AnalysisRepo;
  /**
   * Route override — the ClickHouse dev backend routes permissively
   * (geography dims the rollup matrix rejects are valid there). Defaults to
   * the rollup-matrix `routeAnalysis`.
   */
  readonly routeAnalysis?: typeof routeAnalysis;
}

// ── result shapes ──────────────────────────────────────────────────────────────

/** Count fields are null ONLY when the whole block is gate-blocked (not read). */
/** Structured per-measure money verdict (review F5): a contract block can
 * simultaneously carry awarded=disclosed, estimated=abstained and
 * mod-adjusted=served — prose caveats alone cannot represent that. */
export interface AnalysisMoneyVerdict {
  readonly measure: MeasureId;
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason: AnswerabilityReason | null;
  readonly caveats: readonly string[];
}

export interface AnalysisStatsBlock {
  readonly grain: AnalysisGrain;
  readonly recordCount: string | null;
  readonly withValueCount: string | null;
  readonly withEstimatedCount: string | null;
  readonly valueAwardedSum: string | null;
  readonly valueEstimatedSum: string | null;
  /** Framework grain only: Σ attributed ceiling — never mixed into awarded. */
  readonly valueCeilingSum: string | null;
  /** Contract grain only: Σ modification-adjusted value (anchored chains). */
  readonly valueModAdjustedSum: string | null;
  readonly avgValueAwarded: string | null;
  readonly minMonth: string | null;
  readonly maxMonth: string | null;
  /** One verdict per declared money measure of this grain. */
  readonly moneyVerdicts: readonly AnalysisMoneyVerdict[];
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
  /** Awarded money only — null on grains whose anchor money is another basis. */
  readonly valueAwardedSum: string | null;
  /** The grain's ANCHOR money (awarded / ceiling / call-off value). */
  readonly valueSum: string | null;
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
export const TOPN_MAX = 100;
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
  // matrixHash is informational passthrough now — the ClickHouse fact tables
  // answer arbitrary conjunctions, so a matrix hash no longer gates serving.
  return ok(r.value);
};

const PROCEDURE_LIFECYCLE_NOTE =
  'procedures are tender lifecycles (a procedure yields contracts) — never sum this count with contract/direct-acquisition counts';

const NO_AWARDED_VALUES_CAVEAT =
  'no awarded values observed in scope — the sum is null (unobserved), not zero';

const CALLOFF_PARTIAL_NOTE =
  'call-offs are the REPORTED subsequent contracts under framework agreements (~63k reported vs ~828k frameworks) — framework execution is mostly unobserved, and call-off totals must never be summed with contract awards (double-counts framework spend)';

const FRAMEWORK_CEILING_NOTE =
  'framework ceilings are maximum committed amounts attributed once per framework identity — an upper bound on possible call-off spend, NOT money spent; mixed-value framework groups are quarantined and excluded from every figure; rankings/sliced ceiling totals are withheld until repeat-cluster disclosure lands (per-slice repeat uncertainty can reach ~22%)';

const MODIFICATION_COUNTS_NOTE =
  'modifications are amendment events, not purchases — this population serves counts only; usable amendment values reach analytics solely through the contract grain’s modification-adjusted measure';

const grainNotes = (grain: AnalysisGrain): readonly string[] =>
  grain === 'procedure'
    ? [PROCEDURE_LIFECYCLE_NOTE]
    : grain === 'calloff'
      ? [CALLOFF_PARTIAL_NOTE]
      : grain === 'framework'
        ? [FRAMEWORK_CEILING_NOTE]
        : grain === 'modification'
          ? [MODIFICATION_COUNTS_NOTE]
          : [];

const Q_TITLE_CAVEAT =
  'q filters on record titles (case-insensitive substring); title coverage is partial per grain, so untitled records are excluded from every figure';

const VALUE_BOUNDS_CAVEAT =
  'value bounds restrict every figure (including counts) to records whose accepted awarded value falls in range';

/** Row-filter caveats — a scope q / value bound reshapes the population of EVERY figure. */
const rowFilterCaveats = (scope: AnalysisScope): readonly string[] => [
  ...(scope.q !== undefined ? [Q_TITLE_CAVEAT] : []),
  ...(scope.valueMin !== undefined || scope.valueMax !== undefined ? [VALUE_BOUNDS_CAVEAT] : []),
];

/** Scope-derived caveats appended to every envelope of a shape. */
const scopeNotes = (grain: AnalysisGrain, scope: AnalysisScope): readonly string[] => [
  ...rowFilterCaveats(scope),
  ...grainNotes(grain),
];

/** The stats read projected onto the envelope's fields. */
const readsOf = (read: AnalysisStatsRead): EnvelopeReads => ({
  rows: read.rows,
  withValue: read.withValue,
  undatedCount: read.undatedCount,
  undatedValueRon: read.undatedValueRon,
});

// Every grain declares a money-anchor entry (recordCount on the counts-only
// modification grain); it carries the stats block's value basis, date basis
// and terminality.
const statsPolicy = (grain: AnalysisGrain): PolicyEntry =>
  anchorPolicy(
    grain,
    moneyAnchorMeasure(grain) as 'recordCount' | 'valueAwardedSum' | 'valueCeilingSum'
  );

/** The basis of a grain's ANCHOR money (design v1.1): frameworks anchor on the ceiling. */
const anchorBasis = (grain: AnalysisGrain): ValueBasis =>
  grain === 'framework' ? 'ceiling' : 'awarded';

/** Generation + per-basis coverage rows, resolved ONCE per request. Coverage
 * failure degrades to undefined: awarded serving is unaffected; every
 * non-awarded basis and new-population verdict then abstains (fail-closed). */
const genWithCoverage = async (
  repo: AnalysisRepo
): Promise<
  Result<{ gen: ActiveGeneration; cov: readonly BasisCoverageRow[] | undefined }, ApiError>
> => {
  const genR = await activeGen(repo);
  if (genR.isErr()) return err(genR.error);
  const covR = await repo.basisCoverage(genR.value.buildId);
  return ok({ gen: genR.value, cov: covR.isOk() ? covR.value : undefined });
};

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
 * region geography is in the scope or is the breakdown dimension (buyer or
 * supplier — county/SIRUTA follow the same coverage class). Spend is NOT
 * here — it gates money fields/bases, not the shape.
 */
const shapeGate = (
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain,
  scope: AnalysisScope,
  options: { readonly isSeries?: boolean; readonly dimension?: BreakdownDimension }
): GateDecision => {
  const decisions: GateDecision[] = [];
  if (options.isSeries === true || scopeWindow(scope) !== undefined) {
    decisions.push(decideAnswer(gen.quality, grain, 'time', cov));
  }
  // Every buyer/supplier geography level consults the geo verdict —
  // county/SIRUTA follow the same coverage class as regions (review F2).
  const geoScopeFields = [
    scope.buyerRegion,
    scope.buyerCounty,
    scope.buyerSiruta,
    scope.supplierRegion,
    scope.supplierCounty,
    scope.supplierSiruta,
  ];
  const GEO_DIMS: readonly BreakdownDimension[] = [
    'buyerRegion',
    'buyerCounty',
    'buyerSiruta',
    'supplierRegion',
    'supplierCounty',
    'supplierSiruta',
  ];
  if (
    geoScopeFields.some((v) => v !== undefined) ||
    (options.dimension !== undefined && GEO_DIMS.includes(options.dimension))
  ) {
    decisions.push(decideAnswer(gen.quality, grain, 'geo', cov));
  }
  return composeGates(decisions);
};

/**
 * The grain's anchor-money gate, or null on counts-only grains (modification):
 * a null gate never joins envelope composition — counts serve cleanly instead
 * of wearing an irrelevant awarded-spend abstention (review F4).
 */
const anchorMoneyGate = (
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain
): GateDecision | null =>
  moneyAnchorMeasure(grain) === 'recordCount'
    ? null
    : decideMoney(gen.quality, cov, grain, anchorBasis(grain));

// ── stats ──────────────────────────────────────────────────────────────────────

const statsBlockFor = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  route: AnalysisRoute,
  scope: AnalysisScope,
  canonicalScope: string
): Promise<Result<AnalysisStatsBlock, ApiError>> => {
  const { grain } = route;
  // Per-basis money gates (design v1.1): each money field follows ITS OWN
  // basis verdict — bases never substitute for one another. The grain's
  // ANCHOR basis (awarded; ceiling on frameworks) also gates undated money;
  // the counts-only modification grain composes NO money gate (review F4).
  const spend = anchorMoneyGate(gen, cov, grain);
  const estGate =
    policyFor(grain, 'valueEstimatedSum') !== undefined
      ? decideMoney(gen.quality, cov, grain, 'estimated')
      : null;
  const modGate =
    policyFor(grain, 'valueModAdjustedSum') !== undefined
      ? decideMoney(gen.quality, cov, grain, 'modAdjusted')
      : null;
  const basisCaveats = [
    ...(estGate !== null && (estGate.degraded || !estGate.allow) ? estGate.caveats : []),
    ...(modGate !== null && (modGate.degraded || !modGate.allow) ? modGate.caveats : []),
  ];
  const verdictOf = (measure: MeasureId, gate: GateDecision): AnalysisMoneyVerdict => ({
    measure,
    answerability: gate.allow ? (gate.degraded ? 'degraded' : 'served') : 'abstained',
    reason: gate.reason ?? null,
    caveats: gate.caveats,
  });
  const moneyVerdicts: AnalysisMoneyVerdict[] = [
    ...(spend !== null
      ? [verdictOf(grain === 'framework' ? 'valueCeilingSum' : 'valueAwardedSum', spend)]
      : []),
    ...(estGate !== null ? [verdictOf('valueEstimatedSum', estGate)] : []),
    ...(modGate !== null ? [verdictOf('valueModAdjustedSum', modGate)] : []),
  ];
  const spendGates = spend !== null ? [spend] : [];
  const moneyAllowed = spend?.allow ?? false;
  const blockGate = shapeGate(gen, cov, grain, scope, {});

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
      valueCeilingSum: null,
      valueModAdjustedSum: null,
      avgValueAwarded: null,
      minMonth: null,
      maxMonth: null,
      moneyVerdicts,
      meta: buildEnvelope(
        statsPolicy(grain),
        composeGates([blockGate, ...spendGates]),
        gen.buildId,
        null,
        canonicalScope,
        moneyAllowed,
        scopeNotes(grain, scope)
      ),
    });
  }

  const readR = await deps.analysisRepo.statsFor(route, scope, gen.buildId);
  if (readR.isErr()) return err(readR.error);
  const read = readR.value;

  // Money is null when its basis gate abstains AND when no valued rows were
  // observed — caveats distinguish the two; never coalesced to zero (S8).
  const awardedObserved = read.valueAwardedSum !== null;
  const awarded =
    moneyAllowed && awardedObserved ? d(read.valueAwardedSum).toFixed(MONEY_DP) : null;
  const estimated =
    estGate !== null && estGate.allow && read.valueEstimatedSum !== null
      ? d(read.valueEstimatedSum).toFixed(MONEY_DP)
      : null;
  const ceiling =
    grain === 'framework' && moneyAllowed && read.valueCeilingSum !== null
      ? d(read.valueCeilingSum).toFixed(MONEY_DP)
      : null;
  const modAdjusted =
    modGate !== null && modGate.allow && read.valueModAdjustedSum !== null
      ? d(read.valueModAdjustedSum).toFixed(MONEY_DP)
      : null;
  const withValue = d(read.withValue);
  const avg =
    awarded !== null && withValue.greaterThan(0)
      ? d(read.valueAwardedSum).div(withValue).toFixed(MONEY_DP)
      : null;
  const noValueCaveats =
    moneyAllowed && !awardedObserved && grain !== 'framework' && grain !== 'modification'
      ? [NO_AWARDED_VALUES_CAVEAT]
      : [];

  return ok({
    grain,
    recordCount: read.rows,
    withValueCount: read.withValue,
    withEstimatedCount: read.withEstimated,
    valueAwardedSum: awarded,
    valueEstimatedSum: estimated,
    valueCeilingSum: ceiling,
    valueModAdjustedSum: modAdjusted,
    avgValueAwarded: avg,
    minMonth: read.minMonth,
    maxMonth: read.maxMonth,
    moneyVerdicts,
    meta: buildEnvelope(
      statsPolicy(grain),
      composeGates([blockGate, ...spendGates]),
      gen.buildId,
      readsOf(read),
      canonicalScope,
      moneyAllowed,
      [...noValueCaveats, ...basisCaveats, ...scopeNotes(grain, scope)]
    ),
  });
};

/** Stats over an ALREADY-RESOLVED generation (share/facets reuse it — S1). */
const statsWithGen = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  scope: AnalysisScope
): Promise<Result<AnalysisStatsResult, ApiError>> => {
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(scope, 'stats');
  if (routesR.isErr()) return err(routesR.error);
  const canonicalScope = canonicalScopeEcho(scope);

  const blocks: AnalysisStatsBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await statsBlockFor(deps, gen, cov, route, scope, canonicalScope);
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
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  return statsWithGen(deps, gcR.value.gen, gcR.value.cov, input.scope);
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

  const routesR = (deps.routeAnalysis ?? routeAnalysis)(scope, 'series', undefined, measure);
  if (routesR.isErr()) return err(routesR.error);
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  const { gen, cov } = gcR.value;
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

    const spend = decideMoney(gen.quality, cov, grain, policy.valueBasis ?? anchorBasis(grain));
    const blockedBlock = (gated: GateDecision): AnalysisSeriesBlock => ({
      grain,
      measure,
      bucket,
      points: [],
      meta: buildEnvelope(
        policy,
        gated,
        gen.buildId,
        null,
        canonicalScope,
        spend.allow,
        scopeNotes(grain, scope)
      ),
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
      shapeGate(gen, cov, grain, scope, { isSeries: true }),
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
          ...scopeNotes(grain, scope),
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
        scopeNotes(grain, scope)
      ),
    });
  }
  return ok(blocks);
};

// ── breakdown ──────────────────────────────────────────────────────────────────

/** SIRUTA breakdowns may request every UAT bucket (full-country map paint). */
const SIRUTA_DIMS: ReadonlySet<BreakdownDimension> = new Set(['buyerSiruta', 'supplierSiruta']);

const topNMaxFor = (dimensions: readonly BreakdownDimension[]): number =>
  dimensions.some((dim) => SIRUTA_DIMS.has(dim)) ? TOPN_SIRUTA_MAX : TOPN_MAX;

const normalizeTopN = (
  topN: number | undefined,
  maxTopN: number = TOPN_MAX
): Result<number, ApiError> => {
  if (topN === undefined) return ok(TOPN_DEFAULT);
  if (!Number.isInteger(topN) || topN < 1 || topN > maxTopN) {
    return err(invalidInput(`topN must be an integer from 1 to ${String(maxTopN)}`, 'topN'));
  }
  return ok(topN);
};

const breakdownBlockFor = async (
  deps: AnalysisDeps,
  gen: ActiveGeneration,
  cov: readonly BasisCoverageRow[] | undefined,
  route: AnalysisRoute,
  scope: AnalysisScope,
  dimension: BreakdownDimension,
  topN: number,
  canonicalScope: string,
  rankByReq?: 'value' | 'count'
): Promise<Result<AnalysisBreakdownBlock, ApiError>> => {
  const { grain } = route;
  // The ranking money is the grain's ANCHOR basis (ceiling on frameworks);
  // the counts-only modification grain has NO money gate (spend = null).
  const spend = anchorMoneyGate(gen, cov, grain);
  const blockGate = shapeGate(gen, cov, grain, scope, { dimension });
  const spendGates = spend !== null ? [spend] : [];
  const moneyAllowed = spend?.allow ?? false;

  // An explicit count request always ranks by count; value (explicit or the
  // default) still yields to the money gate — never rank by suppressed money.
  const rankedBy: 'value' | 'count' =
    rankByReq === 'count' || spend === null ? 'count' : spend.allow ? 'value' : 'count';
  const rankCaveats =
    rankedBy === 'count' && rankByReq !== 'count' && spend !== null
      ? ['ranked by record count (money ranking is gate-suppressed)']
      : [];
  const policy = anchorPolicy(
    grain,
    rankedBy === 'value'
      ? (moneyAnchorMeasure(grain) as 'valueAwardedSum' | 'valueCeilingSum' | 'recordCount')
      : 'recordCount'
  );

  if (!blockGate.allow) {
    return ok({
      grain,
      dimension,
      rankedBy,
      buckets: [],
      meta: buildEnvelope(
        policy,
        composeGates([blockGate, ...spendGates]),
        gen.buildId,
        null,
        canonicalScope,
        moneyAllowed,
        scopeNotes(grain, scope)
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
  // The port-level bucket money field carries the grain's ANCHOR money.
  const anchorTotal = grain === 'framework' ? totals.valueCeilingSum : totals.valueAwardedSum;
  const sum = (pick: (b: (typeof buckets)[number]) => string | null): Decimal =>
    buckets.reduce((acc, b) => acc.plus(pick(b) ?? '0'), new Decimal(0));
  const rowsOk = sum((b) => b.recordCount).equals(d(totals.rows));
  const withValueOk = sum((b) => b.withValue).equals(d(totals.withValue));
  const moneyOk = !moneyAllowed || sum((b) => b.valueAwardedSum).equals(d(anchorTotal));
  if (!rowsOk || !withValueOk || !moneyOk) {
    return err(
      databaseError(
        `breakdown(${dimension}) reconciliation failed for grain '${grain}': top+other+unknown do not sum to the scope totals (internal error)`
      )
    );
  }

  const basisTotal = rankedBy === 'value' ? d(anchorTotal) : d(totals.rows);
  const outBuckets: AnalysisBreakdownBucket[] = buckets.map((b) => {
    const basisValue = rankedBy === 'value' ? d(b.valueAwardedSum) : d(b.recordCount);
    // Null-law (review F7): a bucket with NO valued rows emits null money —
    // the repo's reconciliation zero is internal, never an observed value.
    const money =
      moneyAllowed && b.valueAwardedSum !== null && b.withValue !== '0'
        ? d(b.valueAwardedSum).toFixed(MONEY_DP)
        : null;
    return {
      key: b.key,
      kind: b.kind,
      recordCount: b.recordCount,
      withValueCount: b.withValue,
      // valueAwardedSum stays awarded-only: on grains whose anchor money is a
      // DIFFERENT basis (frameworks → ceiling) it is null, never relabeled.
      valueAwardedSum: anchorBasis(grain) === 'awarded' ? money : null,
      valueSum: money,
      shareOfScope: basisTotal.greaterThan(0) ? basisValue.div(basisTotal).toFixed(RATIO_DP) : null,
    };
  });

  const answerGate = composeGates([blockGate, ...spendGates]);
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
      moneyAllowed,
      scopeNotes(grain, scope)
    ),
  });
};

export const analysisBreakdown = async (
  deps: AnalysisDeps,
  input: {
    readonly scope: AnalysisScope;
    readonly dimension: BreakdownDimension;
    readonly topN?: number;
    readonly rankBy?: 'value' | 'count';
  }
): Promise<Result<readonly AnalysisBreakdownBlock[], ApiError>> => {
  const topNR = normalizeTopN(input.topN, topNMaxFor([input.dimension]));
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(input.scope, 'breakdown', input.dimension);
  if (routesR.isErr()) return err(routesR.error);
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const route of routesR.value) {
    const blockR = await breakdownBlockFor(
      deps,
      gcR.value.gen,
      gcR.value.cov,
      route,
      input.scope,
      input.dimension,
      topN,
      canonicalScope,
      input.rankBy
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
  const routesR = (deps.routeAnalysis ?? routeAnalysis)(input.scope, 'concentration');
  if (routesR.isErr()) return err(routesR.error);
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  const { gen, cov } = gcR.value;
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisConcentrationBlock[] = [];
  for (const route of routesR.value) {
    const { grain } = route;
    const spend = decideMoney(gen.quality, cov, grain, anchorBasis(grain));
    const basis: 'value' | 'count' = input.basis ?? 'count';
    const policy = anchorPolicy(grain, basis === 'value' ? 'valueAwardedSum' : 'recordCount');

    const blockGate = shapeGate(gen, cov, grain, input.scope, {});
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
          scopeNotes(grain, input.scope)
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
        [...semanticsCaveats, ...scopeNotes(grain, input.scope)]
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
  if (numerator.grain === 'modification') {
    return err(
      invalidInput(
        'the modification population is counts-only — no money share is derivable',
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
  // tautology (share 1), not a derivation. Row filters (q/value bounds) count
  // as narrowing constraints exactly like dimensions.
  const constraintCount = (scope: AnalysisScope): number =>
    scopeDims(scope).length + scopeRowFilters(scope).length;
  if (
    !isSubsetScope(numerator, denominator) ||
    constraintCount(numerator) <= constraintCount(denominator)
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
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  const { gen, cov } = gcR.value;

  // The grain's ANCHOR money drives the ratio (ceiling on frameworks).
  const spend = decideMoney(gen.quality, cov, numerator.grain, anchorBasis(numerator.grain));
  const anchorMoneyOf = (block: AnalysisStatsBlock): string | null =>
    numerator.grain === 'framework' ? block.valueCeilingSum : block.valueAwardedSum;
  const [numR, denR] = await Promise.all([
    statsWithGen(deps, gen, cov, numerator),
    statsWithGen(deps, gen, cov, denominator),
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
  const numMoney = anchorMoneyOf(numBlock);
  const denMoney = anchorMoneyOf(denBlock);
  if (denMoney === null || numMoney === null) {
    caveats.push(
      `${denMoney === null ? 'denominator' : 'numerator'} has no observed anchor-money values in scope — no ratio is derivable`
    );
  } else {
    const den = new Decimal(denMoney);
    if (den.greaterThan(0)) {
      share = new Decimal(numMoney).div(den).toFixed(RATIO_DP);
    } else {
      caveats.push('denominator has zero anchor-money value in scope — no ratio is derivable');
    }
  }
  return ok({
    share,
    answerability: degradedOperand === undefined ? 'served' : 'degraded',
    ...(degradedOperand?.meta.reason == null ? {} : { reason: degradedOperand.meta.reason }),
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
    readonly rankBy?: 'value' | 'count';
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

  const topNR = normalizeTopN(input.topN, topNMaxFor(dimensions));
  if (topNR.isErr()) return err(topNR.error);
  const topN = topNR.value;
  // Route every dimension up front — one bad dimension rejects the whole request
  // with the matrix's named capability, before any read runs.
  const routed: { dimension: BreakdownDimension; routes: readonly AnalysisRoute[] }[] = [];
  for (const dimension of dimensions) {
    const routesR = (deps.routeAnalysis ?? routeAnalysis)(input.scope, 'breakdown', dimension);
    if (routesR.isErr()) return err(routesR.error);
    routed.push({ dimension, routes: routesR.value });
  }

  // ONE generation for every facet (S1).
  const gcR = await genWithCoverage(deps.analysisRepo);
  if (gcR.isErr()) return err(gcR.error);
  const canonicalScope = canonicalScopeEcho(input.scope);

  const blocks: AnalysisBreakdownBlock[] = [];
  for (const { dimension, routes } of routed) {
    // A mixed request (SIRUTA + regular dims) validates against the raised
    // ceiling but each NON-SIRUTA dimension still reads at most TOPN_MAX —
    // the extra depth exists only for full-country UAT painting.
    const dimensionTopN = Math.min(topN, topNMaxFor([dimension]));
    for (const route of routes) {
      const blockR = await breakdownBlockFor(
        deps,
        gcR.value.gen,
        gcR.value.cov,
        route,
        input.scope,
        dimension,
        dimensionTopN,
        canonicalScope,
        input.rankBy
      );
      if (blockR.isErr()) return err(blockR.error);
      blocks.push(blockR.value);
    }
  }
  return ok({ blocks });
};
