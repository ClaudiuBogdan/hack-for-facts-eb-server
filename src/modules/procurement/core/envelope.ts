/**
 * Procurement analysis — the answer envelope (design §3.4).
 *
 * Every aggregate block carries a uniform `meta`, deliberately limited to what
 * the answering read already knows: no companion scans, no per-answer coverage
 * computation. `undatedInScope` money follows the spend gate — when spend
 * abstains, the undated bucket's value is nulled too (never zeroed). A
 * gate-BLOCKED block carries `counts: null` / `undatedInScope: null` — nothing
 * was read, so nothing is fabricated.
 */

import type { AnalysisGrain } from './constants.js';
import type { AnswerabilityReason, GateDecision } from './gate-v2.js';
import type { PolicyEntry } from './policy.js';

export interface AnswerEnvelope {
  readonly answerability: 'served' | 'degraded' | 'abstained';
  readonly reason?: AnswerabilityReason;
  readonly policyKey: string;
  readonly grain: AnalysisGrain;
  readonly valueBasis: 'estimated' | 'awarded' | null;
  readonly dateBasis: string;
  readonly population: 'canonical-only';
  /** The immutable serving-generation id (drives dataAsOf + cache keys). */
  readonly buildId: string;
  /** Null when the block is gate-blocked: nothing was read, nothing is fabricated. */
  readonly counts: { readonly rows: string; readonly withValue: string } | null;
  /** Null when the block is gate-blocked (see `counts`). */
  readonly undatedInScope: { readonly count: string; readonly valueRon: string | null } | null;
  /** True where terminality is underivable (all contract-grain money). */
  readonly provisional: boolean;
  readonly caveats: readonly string[];
  /** Stable scope serialization; deliberately not presented as a URL. */
  readonly canonicalScope: string;
}

export interface EnvelopeReads {
  readonly rows: string;
  readonly withValue: string;
  readonly undatedCount: string;
  readonly undatedValueRon: string | null;
}

/**
 * Assemble the envelope from the policy entry + gate decision + answering read.
 * `reads: null` marks a gate-blocked block — counts stay null (not read), never
 * a fabricated zero (which would read as an empty population).
 * `moneyAllowed` is the grain's SPEND verdict — the undated bucket's value is a
 * money number and follows it regardless of which class gated the answer itself.
 */
export const buildEnvelope = (
  policy: PolicyEntry,
  gate: GateDecision,
  buildId: string,
  reads: EnvelopeReads | null,
  canonicalScope: string,
  moneyAllowed: boolean,
  extraCaveats: readonly string[] = []
): AnswerEnvelope => ({
  answerability:
    reads === null ? 'abstained' : gate.allow && !gate.degraded ? 'served' : 'degraded',
  ...(gate.reason === undefined ? {} : { reason: gate.reason }),
  policyKey: policy.policyKey,
  grain: policy.grain,
  valueBasis: policy.valueBasis,
  dateBasis: policy.dateBasis,
  population: policy.population,
  buildId,
  counts: reads !== null ? { rows: reads.rows, withValue: reads.withValue } : null,
  undatedInScope:
    reads !== null
      ? { count: reads.undatedCount, valueRon: moneyAllowed ? reads.undatedValueRon : null }
      : null,
  provisional: policy.terminality === 'none' && policy.valueBasis !== null,
  caveats: [...gate.caveats, ...extraCaveats],
  canonicalScope,
});
