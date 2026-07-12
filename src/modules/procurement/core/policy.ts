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
export type ValueBasis = 'estimated' | 'awarded';

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
};

const TERMINALITY: Readonly<Record<AnalysisGrain, 'derivable' | 'none'>> = {
  procedure: 'derivable',
  contract: 'none', // status is constantly 'awarded' — no lifecycle signal
  direct_acquisition: 'derivable',
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

/** Only the supplier-carrying grains — procedures have no supplier column. */
const distinctEntries = (grain: 'contract' | 'direct_acquisition'): PolicyEntry[] => [
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

export const POLICY_TABLE: readonly PolicyEntry[] = [
  ...countEntries('procedure'),
  ...countEntries('contract'),
  ...countEntries('direct_acquisition'),
  ...moneyEntries('procedure'),
  ...moneyEntries('contract'),
  ...moneyEntries('direct_acquisition'),
  ...distinctEntries('contract'),
  ...distinctEntries('direct_acquisition'),
];

const byKey = new Map(POLICY_TABLE.map((e) => [e.policyKey, e]));

/** The entry for (grain, measure), or undefined when the combination is not declared. */
export const policyFor = (grain: AnalysisGrain, measure: MeasureId): PolicyEntry | undefined =>
  byKey.get(`${grain}.${measure}`);

/**
 * Total lookup for the two entries the table structurally guarantees on every
 * grain (recordCount, valueAwardedSum) — they anchor envelopes for shapes that
 * span several measures. The synthesized fallback is unreachable; it exists so
 * callers stay assertion-free.
 */
export const anchorPolicy = (
  grain: AnalysisGrain,
  measure: 'recordCount' | 'valueAwardedSum'
): PolicyEntry =>
  byKey.get(`${grain}.${measure}`) ??
  entry(grain, measure, {
    law: 'additive',
    legalShapes: ['stats'],
    gateClass: measure === 'valueAwardedSum' ? 'spend' : 'count',
    doc: 'synthesized fallback (unreachable — every grain declares this entry)',
  });

/** Derived: every measure id that has at least one declaration. */
export const DECLARED_MEASURES: readonly MeasureId[] = [
  ...new Set(POLICY_TABLE.map((e) => e.measure)),
];
