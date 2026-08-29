/**
 * W1.3 vote-resolution contract — the domain rule for whether a division may
 * assert a bill at all, and which one.
 *
 * Core, not shell: this is a statement about what the data means, and the read
 * path is not the only consumer that must obey it.
 *
 * Before this rule the API answered from `votes.bill_key`, the legacy
 * single-valued column. Measured on live prod 2026-08-08, that column disagrees
 * with the resolver in BOTH directions:
 *
 *  - 8,341 votes are `unresolved` — the resolver saw no evidence and ABSTAINED.
 *    They carry no legacy key and no link today, so the API asserted nothing;
 *    but nothing told a reader that "no bill shown" meant "we refuse to claim
 *    one" rather than "this division had no bill".
 *  - 18 votes are `conflict`: the evidence points at 2-3 DIFFERENT dossiers
 *    (e.g. cdep:29927 -> case:19844 | case:senat:326-2021 | case:senat:326-2022).
 *    Their links are legitimate observations and stay visible, but presenting
 *    any one of them as THE bill asserts what the resolver explicitly refused.
 *  - 860 votes ARE resolved yet carry a null legacy key, so the scalar field
 *    under-served them.
 */

/** Statuses under which the resolver has actually asserted a bill. */
const ASSERTING_STATUSES: ReadonlySet<string> = new Set(['resolved', 'adjudicated']);

/**
 * The bill key a division may be presented as being about, or null.
 *
 * Deliberately has NO fallback to the legacy `billKey`. Falling back is exactly
 * the false assertion this rule exists to remove: it would resurrect a bill for
 * `conflict` and `unresolved` rows, which is the defect, not a nicety.
 */
export function assertedBillKeyForVote(vote: {
  readonly resolutionStatus: string | null;
  readonly resolvedDisplayBillKey: string | null;
}): string | null {
  if (vote.resolutionStatus === null) return null;
  if (!ASSERTING_STATUSES.has(vote.resolutionStatus)) return null;
  return vote.resolvedDisplayBillKey;
}
