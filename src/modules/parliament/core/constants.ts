/**
 * A vote's ballots are parent-bound and small. Chronos held a measured maximum
 * of 447 public ballots per vote on 2026-07-30, so 500 covers the full current
 * corpus in one query while retaining cursor pagination above the bound.
 */
export const PARLIAMENT_BALLOT_PAGE_LIMIT = 500;

/**
 * Cap on rows a SINGLE dossier view contributes to a capped child family
 * (initiators, relatedVotes). It predates the 2026-08-05 batching change, which
 * only had to keep it PER VIEW rather than let one accepted navetă pair share
 * one budget — a shared budget silently changes WHICH rows a paired dossier
 * serves.
 *
 * Measured on Chronos 2026-08-05, re-validate at full scale: votes per bill max
 * 425 across 9,589 bills, initiators per bill max 268 across 11,541 bills —
 * NEITHER family reaches the cap today, so it is a guard rather than live
 * truncation. (A first pass read the initiator maximum as 12,356; that group is
 * the 12,356 `member_initiatives` rows carrying a NULL bill_key, which
 * `getBillInitiators` cannot return at all since it filters on bill_key. The
 * largest real bill is 268.)
 */
export const BILL_CHILD_PER_VIEW_LIMIT = 500;
