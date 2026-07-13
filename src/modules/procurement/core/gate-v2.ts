/**
 * Procurement analysis — capability gate v2 (design §5.4).
 *
 * The gate is a scraper-materialized verdict per (grain × answer class), shipped
 * on the active generation's `quality` jsonb. This module only INTERPRETS it:
 *
 *  - spend: strict — 'allow' or abstain-with-caveat. Money is nulled, never
 *    zeroed, and there is no degrade path for it.
 *  - time:  'allow' | 'degraded' (served with a coverage-disclosing caveat) |
 *    'abstain' (blocked).
 *  - count: always allowed — counts are the rollup rows themselves.
 *  - geo:   per the grain's geo class, same shape as time.
 *
 * Scope-local numbers (this scope's undated count, with-value count) are
 * DESCRIPTIVE envelope metadata from the answering read — they never flip
 * capability (design §5.4, review F4).
 */

import { COUNT_TIME_DEGRADE_FLOOR, type AnalysisGrain } from './constants.js';

import type { GateClass } from './policy.js';

export { COUNT_TIME_DEGRADE_FLOOR };

export interface GrainQualityVerdict {
  /**
   * Coverage RATIOS (4-dp fractions from the generation's jsonb) — never money,
   * so plain JS numbers are acceptable here (§14.1 applies to monetary values).
   * They are used for threshold checks and caveat text only; the CLASSES below
   * are the contract that decides serving, not these numbers.
   */
  readonly coverage: {
    readonly date: number;
    readonly value: number;
    readonly geo: number;
    readonly cpv: number;
  };
  readonly classes: {
    readonly spend: 'allow' | 'abstain';
    readonly time: 'allow' | 'degraded' | 'abstain';
    readonly geo: 'allow' | 'degraded' | 'abstain';
  };
}

/** The active generation's `quality` jsonb, keyed by grain. */
export type GenerationQuality = Partial<Record<AnalysisGrain, GrainQualityVerdict>>;

export type AnswerabilityReason =
  | 'SPEND_COVERAGE_BELOW_GATE'
  | 'TIME_COVERAGE_BELOW_FLOOR'
  | 'GEO_COVERAGE_BELOW_FLOOR'
  | 'MISSING_QUALITY_VERDICT'
  | 'TIME_COVERAGE_DEGRADED'
  | 'GEO_COVERAGE_DEGRADED'
  | 'GENERATION_LACKS_CAPABILITY';

export interface GateDecision {
  readonly allow: boolean;
  readonly degraded: boolean;
  readonly caveats: readonly string[];
  readonly reason?: AnswerabilityReason;
}

const ALLOW: GateDecision = { allow: true, degraded: false, caveats: [] };

const abstain = (caveat: string, reason: AnswerabilityReason): GateDecision => ({
  allow: false,
  degraded: false,
  caveats: [caveat],
  reason,
});

/**
 * Decide whether an answer class is served for a grain. Counts are always
 * allowed; every other class needs a quality verdict — a grain without one (or
 * no active generation quality at all) abstains rather than serving unvetted
 * numbers.
 */
export const decideAnswer = (
  quality: GenerationQuality | undefined,
  grain: AnalysisGrain,
  gateClass: GateClass
): GateDecision => {
  if (gateClass === 'count') return ALLOW;

  const verdict = quality?.[grain];
  if (verdict === undefined) {
    return abstain(
      `no quality verdict for grain '${grain}' — ${gateClass} answers abstain`,
      'MISSING_QUALITY_VERDICT'
    );
  }

  if (gateClass === 'spend') {
    return verdict.classes.spend === 'allow'
      ? ALLOW
      : abstain(
          `spend answers abstain for grain '${grain}': value coverage ${String(verdict.coverage.value)} is below the spend gate (money is omitted, not zeroed)`,
          'SPEND_COVERAGE_BELOW_GATE'
        );
  }

  const cls = gateClass === 'time' ? verdict.classes.time : verdict.classes.geo;
  const coverage = gateClass === 'time' ? verdict.coverage.date : verdict.coverage.geo;
  if (cls === 'allow') return ALLOW;
  if (cls === 'degraded') {
    return {
      allow: true,
      degraded: true,
      caveats: [
        `${gateClass} answers are degraded for grain '${grain}': coverage ${String(coverage)} (floor ${String(COUNT_TIME_DEGRADE_FLOOR)}) — interpret with the undated/unknown context`,
      ],
      reason: gateClass === 'time' ? 'TIME_COVERAGE_DEGRADED' : 'GEO_COVERAGE_DEGRADED',
    };
  }
  return abstain(
    `${gateClass} answers abstain for grain '${grain}': coverage ${String(coverage)} is below the degrade floor ${String(COUNT_TIME_DEGRADE_FLOOR)}`,
    gateClass === 'time' ? 'TIME_COVERAGE_BELOW_FLOOR' : 'GEO_COVERAGE_BELOW_FLOOR'
  );
};
