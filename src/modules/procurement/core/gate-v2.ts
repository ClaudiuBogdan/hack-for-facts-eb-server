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

import {
  BASIS_ALLOW_FLOOR,
  BASIS_DISCLOSED_FLOOR,
  COUNT_TIME_DEGRADE_FLOOR,
  type AnalysisGrain,
} from './constants.js';

import type { GateClass, ValueBasis } from './policy.js';

export { COUNT_TIME_DEGRADE_FLOOR };

/**
 * One per-basis coverage row from the data layer's `meta_value_coverage_v2`
 * (value-basis wave): the serving-side gate input for every non-awarded money
 * basis and for the new populations' time/geo verdicts. Published per build;
 * migrates into the generation quality jsonb in the production-flow wave.
 */
export interface BasisCoverageRow {
  readonly grain: string;
  readonly basis: string;
  readonly population: string;
  readonly coverage: number;
}

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
    /**
     * 'allow_disclosed' (value-model wave): accepted-value coverage sits
     * between the disclosed FLOOR and the full-allow gate — money IS served,
     * with a coverage-disclosing caveat (never silently).
     */
    readonly spend: 'allow' | 'allow_disclosed' | 'abstain';
    readonly time: 'allow' | 'degraded' | 'abstain';
    readonly geo: 'allow' | 'degraded' | 'abstain';
  };
}

/** The active generation's `quality` jsonb, keyed by grain. */
export type GenerationQuality = Partial<Record<AnalysisGrain, GrainQualityVerdict>>;

/** Runtime list so transport schemas (SDL enum, client zod) can be parity-tested against it. */
export const ANSWERABILITY_REASONS = [
  'SPEND_COVERAGE_BELOW_GATE',
  'SPEND_SERVED_DISCLOSED',
  'TIME_COVERAGE_BELOW_FLOOR',
  'GEO_COVERAGE_BELOW_FLOOR',
  'MISSING_QUALITY_VERDICT',
  'TIME_COVERAGE_DEGRADED',
  'GEO_COVERAGE_DEGRADED',
  'GENERATION_LACKS_CAPABILITY',
] as const;

export type AnswerabilityReason = (typeof ANSWERABILITY_REASONS)[number];

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
  gateClass: GateClass,
  basisCoverage?: readonly BasisCoverageRow[]
): GateDecision => {
  if (gateClass === 'count') return ALLOW;

  const verdict = quality?.[grain];
  if (verdict === undefined) {
    // Value-basis wave populations have no generation-quality verdict yet —
    // their time/geo verdicts are synthesized from the coverage meta rows
    // (dated / buyer_geo) until the production wave folds them into quality.
    if (gateClass !== 'spend' && basisCoverage !== undefined) {
      const metaBasis = gateClass === 'time' ? 'dated' : 'buyer_geo';
      const population = SYNTH_POPULATION[grain];
      const row = basisCoverage.find(
        (r) => r.grain === grain && r.basis === metaBasis && r.population === population
      );
      if (row !== undefined) {
        // Synthesized verdicts use the serving floors (0.95/0.75), NOT the
        // legacy generation-class 0.50 floor — new populations are held to
        // the stricter disclosure bar (modification dated 0.515 abstains).
        if (row.coverage >= BASIS_ALLOW_FLOOR) return ALLOW;
        if (row.coverage >= BASIS_DISCLOSED_FLOOR) {
          return {
            allow: true,
            degraded: true,
            caveats: [
              `${gateClass} answers are degraded for grain '${grain}': ${metaBasis} coverage ${String(row.coverage)} (floor ${String(BASIS_DISCLOSED_FLOOR)}) — interpret with the undated/unknown context`,
            ],
            reason: gateClass === 'time' ? 'TIME_COVERAGE_DEGRADED' : 'GEO_COVERAGE_DEGRADED',
          };
        }
        return abstain(
          `${gateClass} answers abstain for grain '${grain}': ${metaBasis} coverage ${String(row.coverage)} is below the disclosure floor ${String(BASIS_DISCLOSED_FLOOR)}`,
          gateClass === 'time' ? 'TIME_COVERAGE_BELOW_FLOOR' : 'GEO_COVERAGE_BELOW_FLOOR'
        );
      }
    }
    return abstain(
      `no quality verdict for grain '${grain}' — ${gateClass} answers abstain`,
      'MISSING_QUALITY_VERDICT'
    );
  }

  if (gateClass === 'spend') {
    if (verdict.classes.spend === 'allow') return ALLOW;
    if (verdict.classes.spend === 'allow_disclosed') {
      return {
        allow: true,
        degraded: true,
        caveats: [
          `spend answers are served with DISCLOSED partial coverage for grain '${grain}': accepted-value coverage ${String(verdict.coverage.value)} sits between the disclosure floor and the full-allow gate — totals understate the true spend`,
        ],
        reason: 'SPEND_SERVED_DISCLOSED',
      };
    }
    return abstain(
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

/**
 * Meta-row lookup key per (grain, basis) → {basis, population} — the FULL
 * 3-field match. Matching on (grain, basis) alone is unsafe: build 6 publishes
 * TWO framework/ceiling rows (groups_all 0.927 = the serving verdict;
 * quarantined_mass 0.031 = a diagnostic) and row order is not guaranteed.
 */
const BASIS_META: Partial<
  Record<AnalysisGrain, Partial<Record<ValueBasis, { basis: string; population: string }>>>
> = {
  contract: {
    estimated: { basis: 'estimated', population: 'applicable_canonical' },
    modAdjusted: { basis: 'mod_adjusted', population: 'awarded_valued' },
  },
  direct_acquisition: { estimated: { basis: 'estimated', population: 'applicable_canonical' } },
  procedure: { estimated: { basis: 'estimated', population: 'applicable_canonical' } },
  framework: { ceiling: { basis: 'ceiling', population: 'groups_all' } },
  calloff: { awarded: { basis: 'calloff_value', population: 'all_rows' } },
};

/** Populations of the synthesized time/geo rows per new-population grain. */
const SYNTH_POPULATION: Partial<Record<AnalysisGrain, string>> = {
  framework: 'groups_all',
  calloff: 'all_rows',
  modification: 'all_rows',
};

const BASIS_LABEL: Record<ValueBasis, string> = {
  awarded: 'awarded value',
  estimated: 'estimated value',
  ceiling: 'framework ceiling',
  modAdjusted: 'modification-adjusted value',
};

/**
 * Decide whether MONEY on (grain, basis) is served (value-basis wave). The
 * awarded basis on the three core grains keeps the generation spend verdict
 * (disclosed floor et al.); every other basis gates on its coverage meta row
 * with the shared floors — a missing row abstains (never serve an unvetted
 * basis). Bases are never interchangeable: an abstaining basis nulls its
 * money, it does not fall back to another basis.
 */
export const decideMoney = (
  quality: GenerationQuality | undefined,
  basisCoverage: readonly BasisCoverageRow[] | undefined,
  grain: AnalysisGrain,
  basis: ValueBasis
): GateDecision => {
  const meta = BASIS_META[grain]?.[basis];
  if (meta === undefined) {
    if (basis === 'awarded') return decideAnswer(quality, grain, 'spend');
    return abstain(
      `${BASIS_LABEL[basis]} is not served on grain '${grain}'`,
      'MISSING_QUALITY_VERDICT'
    );
  }
  const row = basisCoverage?.find(
    (r) => r.grain === grain && r.basis === meta.basis && r.population === meta.population
  );
  if (row === undefined) {
    return abstain(
      `no coverage verdict for ${BASIS_LABEL[basis]} on grain '${grain}' — money abstains (never served unvetted)`,
      'MISSING_QUALITY_VERDICT'
    );
  }
  if (row.coverage >= BASIS_ALLOW_FLOOR) return ALLOW;
  if (row.coverage >= BASIS_DISCLOSED_FLOOR) {
    return {
      allow: true,
      degraded: true,
      caveats: [
        `${BASIS_LABEL[basis]} answers are served with DISCLOSED partial coverage for grain '${grain}': coverage ${String(row.coverage)} sits between the disclosure floor ${String(BASIS_DISCLOSED_FLOOR)} and the full-allow gate ${String(BASIS_ALLOW_FLOOR)} — totals understate the ${BASIS_LABEL[basis]} population`,
      ],
      reason: 'SPEND_SERVED_DISCLOSED',
    };
  }
  return abstain(
    `${BASIS_LABEL[basis]} answers abstain for grain '${grain}': coverage ${String(row.coverage)} is below the disclosure floor ${String(BASIS_DISCLOSED_FLOOR)} (money is omitted, not zeroed)`,
    'SPEND_COVERAGE_BELOW_GATE'
  );
};
