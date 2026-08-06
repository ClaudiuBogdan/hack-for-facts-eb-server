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

/**
 * A committee's documents page. 44,626 documents are reachable across 190
 * committees (median 54, max 2,469) and 76 committees exceed any single-shot
 * bound — which is why this is a cursor connection rather than a capped list.
 *
 * Measured on Chronos 2026-08-06, re-validate at full scale: 22.6 KB per 50 rows;
 * the keyset read is 0.57 ms on the median committee and 16 ms on the largest,
 * through the existing `parliament_committee_documents_committee_idx`. NO new
 * index is earned by this workload — the measurement is the reason, recorded here
 * instead of an index nobody could later justify removing.
 */
export const COMMITTEE_DOCUMENT_PAGE_LIMIT = 100;

/** Rows served when a caller names no `first`. */
export const COMMITTEE_DOCUMENT_PAGE_DEFAULT = 20;

/**
 * THE DOCUMENT SORT KEY — one definition, because two would break every cursor.
 *
 * `doc_date` is NULL on 1,980 of 2,056 Senate rows, and SQL row comparison is
 * three-valued: `ROW(NULL,'x') < ROW('20240101','y')` is NULL, not true. A naive
 * `(doc_date, key)` keyset therefore drops every undated row the moment a cursor
 * is followed — measured: 3 of 188 rows returned for senate:a3ba8a6b-… . Sorting
 * on a coalesced TEXT ordinal removes the NULL from the comparison entirely.
 *
 * Verified over all 44,626 reachable rows: 0 duplicate (ord, key) pairs within a
 * committee, 0 null ordinals, and 0 real dates colliding with the sentinel (no
 * document is dated year 0000). Undated rows therefore sort last under DESC and
 * still page deterministically on the key tiebreak.
 */
export const COMMITTEE_DOCUMENT_ORD_SENTINEL = '00000000';

/**
 * The TypeScript reading of the SQL ordinal above. The repo builds the ordinal
 * ONCE as `coalesce(to_char(cd.doc_date,'YYYYMMDD'), <sentinel>)` and mints each
 * cursor from the value the DATABASE returned, so this never re-derives a served
 * cursor — it exists so the two readings can be proven equal in a test, and so
 * the sentinel has a single literal.
 */
export const committeeDocumentOrd = (docDate: string | null): string =>
  docDate === null ? COMMITTEE_DOCUMENT_ORD_SENTINEL : docDate.slice(0, 10).replaceAll('-', '');

/** A cursor's ordinal key is well-formed iff it is exactly the 8 digits above. */
export const isCommitteeDocumentOrd = (value: string): boolean => /^[0-9]{8}$/u.test(value);
