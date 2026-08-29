/**
 * The one definition of "which `search.documents` rows may be served, and which
 * identifiers may ride out on them".
 *
 * WHY THIS IS A SHARED MODULE AND NOT THREE COPIES. The containment predicate
 * already existed, correct and carefully reasoned, inside `searchEntities` —
 * and sibling read paths over the SAME table had no filter at all:
 * `countByCui`, the whole of `document-repo`, and the since-removed
 * `fallbackTextSearch`. A rule that lives in the body of one query protects
 * that query. Copying it around would protect each copy until someone edits
 * one of them.
 *
 * THE DESIGN THIS IMPLEMENTS is deliberately two-layer, and both layers are
 * load-bearing:
 *
 *  - **Row layer, permissive on purpose.** A document is served if it has NO
 *    identifiers at all (legal acts, reports) or at least one *servable* one.
 *    It is NOT "has no withheld identifier": a public act that happens to name a
 *    PFA must stay reachable, because the act is public even though the person's
 *    identifier is not.
 *  - **Field layer, mandatory.** Because the row layer is permissive, a served
 *    row can still CARRY a withheld identifier. Every path that echoes `cuis`
 *    must scrub it. The row filter is only safe *because* the scrub runs.
 *
 * MEASURED ON LIVE PROD 2026-08-12, and it revises the older note in
 * `search-repo.ts` that speaks of 2,047 of 2,067 procurement contracts carrying
 * both an id shape: **today there are ZERO dual-keyed documents.** Of 13,846,721
 * rows, 117,688 have identifiers but no servable one, and **every one of them is
 * a `company` doc** — no contract, no legal act, no public act of any kind is in
 * the excluded set. Also measured: 0 rows are non-public and 0 are deleted, so
 * the `visibility`/`deleted_at` clauses cost nothing today and are carried as
 * defence-in-depth rather than as a live filter. Both numbers should be re-taken
 * before anyone reasons from them again; the permissive row rule is kept
 * precisely because the dual-keyed case is the one that will come back.
 *
 * Nothing here deletes or hides data in Postgres. The withheld identifiers stay
 * in the database with their `privacy_class`; this is the API-layer gate that
 * the standing rule ("extract everything; gate privacy at the API") requires.
 */

import { sql } from 'kysely';

import { MAX_SERVED_CUI_DIGITS, isWithheldOrganizationIdentifier } from '../../core/types.js';

/**
 * Rows whose identifier set is safe to serve.
 *
 * `coalesce(cardinality(cuis), 0) = 0` is the no-identifier case and must come
 * first: a NULL or empty array is not evidence of a withheld id, and dropping
 * those rows would silently remove every legal act and report from the surface.
 */
export const servableIdentifierSetSql = sql<boolean>`(
  coalesce(cardinality(cuis), 0) = 0
  or exists (
    select 1 from unnest(cuis) c
    where length(c) <= ${sql.lit(MAX_SERVED_CUI_DIGITS)}
  )
)`;

/**
 * Rows that are published, not tombstoned, and public-classed.
 *
 * `privacy_class` was added here 2026-08-25 (panel Q5): the Meili engine pins
 * `privacy_class = "public"` on every query, but the pg paths pinned only
 * `visibility` — and the two columns DISAGREE on 117,688 rows (measured live:
 * `visibility='public'` AND `privacy_class='restricted'`, the P0A CNP-keyed
 * companies). Those rows were contained only by `servableIdentifierSetSql`
 * plus loader-side fail-closed writes — construction, not a pinned predicate.
 * Pinning both makes every pg read default-deny on `restricted`, matching the
 * engine (B012 server follow-up). Strictly narrowing: 0 non-public rows exist
 * outside the CNP set today.
 */
export const servableDocumentRowSql = sql<boolean>`(
  visibility = 'public' and deleted_at is null and privacy_class = 'public'
)`;

/**
 * Whether an identifier may be used as a LOOKUP KEY.
 *
 * This is a different question from "may this row be served", and the row rule
 * cannot answer it. The permissive row rule keeps a public act reachable when it
 * also names a person — reachable *by its own attributes*: its title, the
 * buyer's CUI, its county. It was never meant to make the person's identifier a
 * working index into those acts, and a CUI-keyed read is exactly that: the
 * question "which documents mention <this person>?" is answered completely by a
 * non-empty result, and no field-level scrub can redact it. A count is the
 * purest case — the number IS the answer.
 *
 * Caught by a test, not by reading the code: with the row filter in place,
 * `countByCui(<13-digit id>)` still returned 1 and `listByCui` still returned
 * the document, because the dual-keyed row legitimately passes the row rule.
 *
 * NOTE — this is the narrow half of the open identifier-level-vs-row-level
 * question (task #15). Refusing a withheld key removes no public act from any
 * surface reachable another way, so it is the safe side to be on while that
 * decision is outstanding. The residual asymmetry, and the wider question, are
 * written up for the user rather than settled here.
 */
export const isWithheldLookupKey = (cui: string): boolean => isWithheldOrganizationIdentifier(cui);

/**
 * Remove withheld identifiers from an array before it leaves the process.
 *
 * Returns a new array; callers decide whether an empty result should be omitted
 * from the response or serialised as `[]`. The distinction matters: omitting is
 * right for an optional field, but a `Document.cuis` that is declared non-null
 * must stay an array or the shape breaks for consumers.
 */
export const scrubWithheldIdentifiers = (cuis: readonly string[]): readonly string[] =>
  cuis.filter((c) => !isWithheldOrganizationIdentifier(c));
