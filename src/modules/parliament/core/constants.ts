/**
 * A vote's ballots are parent-bound and small. Chronos held a measured maximum
 * of 447 public ballots per vote on 2026-07-30, so 500 covers the full current
 * corpus in one query while retaining cursor pagination above the bound.
 */
export const PARLIAMENT_BALLOT_PAGE_LIMIT = 500;
