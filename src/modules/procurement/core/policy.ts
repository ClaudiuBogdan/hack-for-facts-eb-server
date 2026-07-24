/**
 * Procurement analysis — the semantic policy table (design §3).
 *
 * One declaration keyed by (grain, measure). Everything the serving layer must
 * know about a number lives here: which value basis it uses, which date column
 * buckets it, how it may be aggregated (the LAW), which answer shapes may carry
 * it, and which gate class decides whether it is served at all. Metric ids and
 * docs are DERIVED from this table; tests assert coverage against it.
 *
 * Hard rules encoded here (design §3.1–§3.3, D2):
 *  - spend answers are AWARDED values only; `estimated` is a separate labeled
 *    metric that never enters totals or rankings;
 *  - the contracts grain has no terminality signal → its money is always
 *    `provisional: true`;
 *  - procedures have no supplier → there are NO procedure-grain distinct-supplier
 *    or distinct-authority entries (a unit test asserts the absence);
 *  - procedure-grain time answers are blocked (`missing-date-basis`, unblocks at
 *    M1 when the scraper backfills a real date basis).
 */

import type { AnalysisGrain, MeasureId } from './constants.js';

export type AggregationLaw = 'additive' | 'distinct' | 'ratio';
export type GateClass = 'count' | 'time' | 'spend' | 'geo';
export type AnalysisShape = 'stats' | 'series' | 'breakdown' | 'concentration';
/**
 * The money bases (value-basis wave, design v1.1): each measure's money comes
 * from exactly ONE basis with its own acceptance predicate and coverage gate —
 * bases are never interchangeable and never summed together. 'ceiling' exists
 * only on the framework parent grain; 'modAdjusted' only on contracts.
 */
export type ValueBasis = 'estimated' | 'awarded' | 'ceiling' | 'modAdjusted';

export interface PolicyEntry {
  /** `<grain>.<measure>`, e.g. `direct_acquisition.valueAwardedSum`. */
  readonly policyKey: string;
  readonly grain: AnalysisGrain;
  readonly measure: MeasureId;
  /** null for pure counts/distincts (no money involved). */
  readonly valueBasis: ValueBasis | null;
  /** The date expression that buckets this grain (design §3.2). */
  readonly dateBasis: string;
  readonly population: 'canonical-only';
  /** 'none' (contracts) → every money answer ships `provisional: true`. */
  readonly terminality: 'derivable' | 'none';
  readonly law: AggregationLaw;
  /** For law='ratio': the two measures the ratio is recomputed from. */
  readonly ratioOf?: { readonly numerator: MeasureId; readonly denominator: MeasureId };
  readonly legalShapes: readonly AnalysisShape[];
  readonly gateClass: GateClass;
  /** Time answers structurally blocked for this entry (named milestone unblocks). */
  readonly blocked?: { readonly reason: string; readonly milestone: string };
  readonly doc: string;
}

const DATE_BASIS: Readonly<Record<AnalysisGrain, string>> = {
  procedure: 'publication_date',
  contract: 'contract_date',
  direct_acquisition: 'coalesce(finalization_date, publication_date)',
  framework: 'min(member contract_date)',
  calloff: 'contract_date',
  modification: 'modification_date',
};

const TERMINALITY: Readonly<Record<AnalysisGrain, 'derivable' | 'none'>> = {
  procedure: 'derivable',
  contract: 'none', // status is constantly 'awarded' — no lifecycle signal
  direct_acquisition: 'derivable',
  framework: 'none', // a ceiling is a commitment bound, never a settled amount
  calloff: 'derivable', // reported executed purchases
  modification: 'derivable', // amendment events (counts-only)
};

/** Procedure-grain time answers are unservable until the M1 date backfill. */
const PROCEDURE_TIME_BLOCK = {
  reason: 'missing-date-basis',
  milestone: 'M1',
} as const;

const entry = (
  grain: AnalysisGrain,
  measure: MeasureId,
  over: Partial<PolicyEntry> & Pick<PolicyEntry, 'law' | 'legalShapes' | 'gateClass' | 'doc'>
): PolicyEntry => ({
  policyKey: `${grain}.${measure}`,
  grain,
  measure,
  valueBasis: null,
  dateBasis: DATE_BASIS[grain],
  population: 'canonical-only',
  terminality: TERMINALITY[grain],
  ...(grain === 'procedure' &&
    over.legalShapes.includes('series') && { blocked: PROCEDURE_TIME_BLOCK }),
  ...over,
});

const countEntries = (grain: AnalysisGrain): PolicyEntry[] => [
  entry(grain, 'recordCount', {
    law: 'additive',
    legalShapes: ['stats', 'series', 'breakdown'],
    gateClass: 'count',
    doc: 'Canonical record count. Never presented as unique purchases across grains.',
  }),
  entry(grain, 'withValueCount', {
    law: 'additive',
    legalShapes: ['stats', 'series'],
    gateClass: 'count',
    doc: 'Canonical records carrying an awarded value (the avg denominator).',
  }),
];

const moneyEntries = (grain: AnalysisGrain): PolicyEntry[] => [
  entry(grain, 'valueAwardedSum', {
    valueBasis: 'awarded',
    law: 'additive',
    legalShapes:
      grain === 'procedure'
        ? ['stats', 'series', 'breakdown']
        : ['stats', 'series', 'breakdown', 'concentration'],
    gateClass: 'spend',
    doc: 'Σ awarded value (RON). The default spend measure; never mixed with estimated.',
  }),
  entry(grain, 'valueEstimatedSum', {
    valueBasis: 'estimated',
    law: 'additive',
    legalShapes: ['stats', 'series'],
    gateClass: 'spend',
    doc: 'Σ estimated value (RON). A separate, labeled metric — never in totals or rankings (D2).',
  }),
  entry(grain, 'avgValueAwarded', {
    valueBasis: 'awarded',
    law: 'ratio',
    ratioOf: { numerator: 'valueAwardedSum', denominator: 'withValueCount' },
    legalShapes: ['stats'],
    gateClass: 'spend',
    doc: 'valueAwardedSum / withValueCount (same grain, same population) — never a row-count denominator.',
  }),
];

/** Only the supplier-carrying grains — procedures and frameworks have no supplier column. */
const distinctEntries = (grain: 'contract' | 'direct_acquisition' | 'calloff'): PolicyEntry[] => [
  entry(grain, 'distinctSuppliers', {
    law: 'distinct',
    legalShapes: ['series'],
    gateClass: 'count',
    doc: 'COUNT(DISTINCT supplier) per bucket from the key-retaining edge rollup; never summed across buckets.',
  }),
  entry(grain, 'distinctAuthorities', {
    law: 'distinct',
    legalShapes: ['series'],
    gateClass: 'count',
    doc: 'COUNT(DISTINCT authority) per bucket from the key-retaining edge rollup; never summed across buckets.',
  }),
];

/**
 * Value-basis wave populations (design v1.1). Each value logic is a
 * (grain, measure) pair — no orthogonal basis parameter exists:
 *  - framework parent grain: the ceiling is its ONLY money (attributed once
 *    per framework identity; quarantined mass disclosed, never served);
 *  - calloff grain: reported call-off values are its awarded money — its own
 *    population, NEVER summed with contract awards (double-counts frameworks);
 *  - modification grain: counts-only (no money entries — the defective raw
 *    deltas are relabeled in the data layer, and the usable deltas serve only
 *    through contract.valueModAdjustedSum).
 */
const CEILING_DOC =
  'Σ framework ceiling (RON), attributed once per framework identity — the maximum committed under the umbrellas, NOT money spent; mixed-value groups are quarantined and disclosed, never served.';

const valueBasisEntries: readonly PolicyEntry[] = [
  entry('contract', 'valueModAdjustedSum', {
    valueBasis: 'modAdjusted',
    law: 'additive',
    legalShapes: ['stats', 'series'],
    gateClass: 'spend',
    doc: 'Σ modification-adjusted value (RON): awarded + verified anchored amendment chains (final value_after). Contracts with unusable amendment chains are excluded (sequence_unresolved), never silently served as awarded.',
  }),
  entry('framework', 'recordCount', {
    law: 'additive',
    // Breakdowns (rankings/sliced totals) are WITHHELD until the Phase-2
    // repeat-cluster keys land: exact-repeat exposure is 0.3% globally but
    // reaches ~22% inside single-buyer slices (review F3) — a sliced ceiling
    // ranking could materially mislead. Stats/series serve with disclosure.
    legalShapes: ['stats', 'series'],
    gateClass: 'count',
    doc: 'Framework identities (parent grain: one row per framework, not per member row). Breakdowns withheld until Phase-2 repeat-cluster keys.',
  }),
  entry('framework', 'withValueCount', {
    law: 'additive',
    legalShapes: ['stats', 'series'],
    gateClass: 'count',
    doc: 'Framework identities with an attributed ceiling.',
  }),
  entry('framework', 'valueCeilingSum', {
    valueBasis: 'ceiling',
    law: 'additive',
    legalShapes: ['stats', 'series'], // breakdowns withheld — see recordCount note
    gateClass: 'spend',
    doc: CEILING_DOC,
  }),
  entry('framework', 'distinctAuthorities', {
    law: 'distinct',
    legalShapes: ['series'],
    gateClass: 'count',
    doc: 'COUNT(DISTINCT authority) per bucket; the framework grain has NO supplier dimension (ceilings are never attributable to a single supplier).',
  }),
  ...countEntries('calloff'),
  entry('calloff', 'valueAwardedSum', {
    valueBasis: 'awarded',
    law: 'additive',
    legalShapes: ['stats', 'series', 'breakdown', 'concentration'],
    gateClass: 'spend',
    doc: 'Σ reported call-off value (RON) — execution under frameworks. Partial by construction (~63k reported call-offs vs ~828k frameworks); NEVER summed with contract awards.',
  }),
  entry('calloff', 'avgValueAwarded', {
    valueBasis: 'awarded',
    law: 'ratio',
    ratioOf: { numerator: 'valueAwardedSum', denominator: 'withValueCount' },
    legalShapes: ['stats'],
    gateClass: 'spend',
    doc: 'valueAwardedSum / withValueCount over call-offs.',
  }),
  ...distinctEntries('calloff'),
  entry('modification', 'recordCount', {
    law: 'additive',
    legalShapes: ['stats', 'series', 'breakdown'],
    gateClass: 'count',
    doc: 'Contract amendment events. COUNTS-ONLY: ~48.5% are undated (time answers degrade) and raw deltas are quality-relabeled — no money measure is declared on this grain.',
  }),
];

export const POLICY_TABLE: readonly PolicyEntry[] = [
  ...countEntries('procedure'),
  ...countEntries('contract'),
  ...countEntries('direct_acquisition'),
  ...moneyEntries('procedure'),
  ...moneyEntries('contract'),
  ...moneyEntries('direct_acquisition'),
  ...distinctEntries('contract'),
  ...distinctEntries('direct_acquisition'),
  ...valueBasisEntries,
];

const byKey = new Map(POLICY_TABLE.map((e) => [e.policyKey, e]));

/** The entry for (grain, measure), or undefined when the combination is not declared. */
export const policyFor = (grain: AnalysisGrain, measure: MeasureId): PolicyEntry | undefined =>
  byKey.get(`${grain}.${measure}`);

/**
 * The grain's MONEY-anchor measure: the measure whose policy entry carries the
 * grain's value basis for stats/breakdown envelopes. Frameworks anchor on the
 * ceiling; the counts-only modification grain anchors on recordCount.
 */
export const moneyAnchorMeasure = (grain: AnalysisGrain): MeasureId =>
  grain === 'framework'
    ? 'valueCeilingSum'
    : grain === 'modification'
      ? 'recordCount'
      : 'valueAwardedSum';

/**
 * Total lookup for the anchor entries the table structurally guarantees on
 * every grain (recordCount + the grain's money anchor) — they anchor envelopes
 * for shapes that span several measures. The synthesized fallback is
 * unreachable; it exists so callers stay assertion-free.
 */
export const anchorPolicy = (
  grain: AnalysisGrain,
  measure: 'recordCount' | 'valueAwardedSum' | 'valueCeilingSum'
): PolicyEntry =>
  byKey.get(`${grain}.${measure}`) ??
  byKey.get(`${grain}.${moneyAnchorMeasure(grain)}`) ??
  entry(grain, measure, {
    law: 'additive',
    legalShapes: ['stats'],
    gateClass: measure === 'recordCount' ? 'count' : 'spend',
    doc: 'synthesized fallback (unreachable — every grain declares an anchor entry)',
  });

/** Derived: every measure id that has at least one declaration. */
export const DECLARED_MEASURES: readonly MeasureId[] = [
  ...new Set(POLICY_TABLE.map((e) => e.measure)),
];
