/**
 * Parliament module — the canonical FULL-HISTORY transcript search projection
 * (`ParliamentTranscriptSearchPort`).
 *
 * WHAT THIS READS. `search.documents` rows of doc_type `parliament_speech_segment`:
 * ONE document per canonical PUBLIC SPEECH reading block, built by the scrapper's
 * `buildParliamentSearchDocumentsSelect` (load-prod.ts). The projection is
 * rebuildable and is deliberately NOT a source of truth — every fact served to a
 * client is re-read from `parliament.stenogram_*` after this narrows the candidate
 * sittings, so a stale index can only make a sitting missing from a search, never
 * make the served reading wrong.
 *
 * THE DOCUMENT CONTRACT WE BIND TO (verbatim from the loader's `speech_segments` CTE):
 *   doc_id      'parliament:speech:' || sg.speech_key
 *   attrs       session_key · segment_key · speech_key · position · chamber ·
 *               session_date · session_title · availability · agenda_ref ·
 *               speaker_name · mandate_key · has_mandate · source_url_kind ·
 *               source_ref · privacy_class · unit_kind='stenogram-reading-block'
 *   visibility  derived from the block's privacy_class
 * The loader's own scope already requires a public block of a public, non-SOURCE_ONLY,
 * dated session.
 *
 * WHY WE NEVER PARSE `doc_id`. A canonical speech key is `canon:<session_key>#<pos>`
 * and a session key is itself colon-bearing (`cdep:9043`), so the doc_id is
 * `parliament:speech:canon:cdep:9043#00004` — five colons, and the count varies by
 * source system. Splitting it is guesswork that silently mis-attributes blocks to the
 * wrong sitting. `attrs.session_key` is the loader's explicit, indexed contract; a doc
 * without it is not a doc we can honour, so it is EXCLUDED rather than salvaged.
 *
 * WHY GROUPING HAPPENS IN SQL. The projection's unit is the block, so one long sitting
 * contributes thousands of documents. Capping documents and grouping afterwards would
 * let a single sitting consume the entire cap — the user sees "one sitting ever
 * mentioned this" when hundreds did. So the `group by attrs->>'session_key'` and the
 * ranking run BEFORE `limit`, and the cap counts SITTINGS.
 *
 * WHY IT MAY REFUSE. `available()` is the honest gate, and it separates "no readable
 * `search.documents`" from "readable, but this doc type holds no public document"
 * (the current state: `PARLIAMENT_SPEECH_SEARCH_MODE` is off, so the loader emits the
 * CTE not at all). Both refuse a `q` with `SearchUnavailable`. We do NOT substitute a
 * title-only match or a bounded legacy `ILIKE` over `parliament.speeches`: both answer
 * a strictly narrower question while looking exactly like a full-history answer, and
 * the scrapper takes the same stance (no fallback to the legacy grain, ever).
 *
 * PRIVACY, TWO LAYERS. `visibility` is derived from the block's `privacy_class`, and
 * we ALSO require `attrs->>'privacy_class' = 'public'` — a projection bug that set one
 * without the other cannot leak a restricted block into a hit set. The repo then
 * re-applies the row-level gates on the real tables. Both layers, never one.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, servableDocumentRowSql } from '@/modules/shared/index.js';

import {
  PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE,
  type ParliamentStenogramError,
} from '../../core/types.js';

import type { ParliamentTranscriptSearchPort } from '../../core/ports.js';

type Db = Kysely<import('@/modules/shared/index.js').ProdDatabase>;

/** Negative-TTL for the projection probe (the `speech_texts` pattern). */
const PROJECTION_PROBE_NEG_TTL_MS = 60_000;

/** Hard ceiling on sittings resolved per search, independent of the caller's ask. */
const MAX_SESSIONS_PER_SEARCH = 5_000;

type Availability = Awaited<ReturnType<ParliamentTranscriptSearchPort['available']>>;

export const makeParliamentTranscriptSearch = (db: Db): ParliamentTranscriptSearchPort => {
  let usable = false;
  let lastNegative: { at: number; reason: Availability['reason'] } | undefined;
  let inFlight: Promise<Availability> | undefined;

  /**
   * Availability is "the projection HAS public documents of its doc_type", not merely
   * "the table exists". `search.documents` is kernel schema and always exists, so a
   * catalog probe would report the projection available while it holds zero transcript
   * blocks — and every `q` would then answer "no matches" for the whole of
   * parliamentary history. That silent-empty is exactly the failure the UNAVAILABLE
   * contract exists to prevent, which is why the two cases are reported separately.
   */
  const available = (): Promise<Availability> => {
    if (usable) return Promise.resolve({ available: true, reason: 'ok' as const });
    if (inFlight !== undefined) return inFlight;
    if (lastNegative !== undefined && Date.now() - lastNegative.at < PROJECTION_PROBE_NEG_TTL_MS) {
      return Promise.resolve({ available: false, reason: lastNegative.reason });
    }
    inFlight = (async () => {
      try {
        const row = await db
          .selectFrom('search.documents')
          .select(sql<number>`1`.as('one'))
          .where('doc_type', '=', PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE)
          // The SHARED servable predicate (visibility + tombstone + the
          // CANONICAL privacy_class column). This probe previously checked only
          // visibility and the tombstone while the search below pinned just the
          // `attrs` copy of the class — the same split that disagrees on 117,688
          // rows elsewhere in this table (SEARCH_LAYER_REVIEW_2026-08-25.md
          // F13/F16). The probe decides whether the whole surface is available,
          // so it must not be the more permissive of the two.
          .where(servableDocumentRowSql)
          // A doc we could not attribute to a sitting is not a usable doc (see the
          // header) — so it must not make the projection look built either.
          .where(sql<boolean>`nullif(attrs->>'session_key', '') is not null`)
          .limit(1)
          .executeTakeFirst();
        if (row !== undefined) {
          usable = true;
          lastNegative = undefined;
          return { available: true, reason: 'ok' as const };
        }
        lastNegative = { at: Date.now(), reason: 'doc_type_unbuilt' as const };
        return { available: false, reason: 'doc_type_unbuilt' as const };
      } catch {
        // `search.documents` itself is unreadable (absent, permission, transport).
        lastNegative = { at: Date.now(), reason: 'relation_unavailable' as const };
        return { available: false, reason: 'relation_unavailable' as const };
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const searchSessionKeys = async (
    q: string,
    limit: number
  ): Promise<
    Result<
      {
        sessions: readonly { sessionKey: string; matchedBlocks: number }[];
        truncated: boolean;
      },
      ParliamentStenogramError
    >
  > => {
    const trimmed = q.trim();
    if (trimmed === '') return ok({ sessions: [], truncated: false });
    const capped = Math.min(Math.max(limit, 1), MAX_SESSIONS_PER_SEARCH);
    // `title`/`body` on search.documents are NOT diacritic-folded, so match the RAW
    // query (the kernel `fallbackTextSearch` precedent, §15.7). LIKE wildcards in the
    // user token are escaped so a `%` cannot silently widen the search.
    const needle = `%${trimmed.replace(/[%_\\]/gu, '\\$&')}%`;
    try {
      const rows = await db
        .selectFrom('search.documents')
        .select([
          sql<string>`attrs->>'session_key'`.as('session_key'),
          sql<string>`count(*)`.as('matched_blocks'),
          // Rank the SITTING, not a block: its best block's importance, then its
          // recency. Both are aggregates so they survive the GROUP BY.
          sql<number | null>`max(rank_boost)`.as('best_rank'),
          sql<string | null>`max(doc_date)::text`.as('latest_doc_date'),
        ])
        .where('doc_type', '=', PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE)
        .where(servableDocumentRowSql)
        // Defence in depth on TOP of the shared predicate: the `attrs` copy must
        // agree with the canonical column. Until 2026-08-26 only this copy was
        // checked here, and the shared predicate was not used at all (F16).
        .where(sql<boolean>`attrs->>'privacy_class' = 'public'`)
        // Only canonical reading blocks, and only ones we can attribute to a sitting.
        .where(sql<boolean>`attrs->>'unit_kind' = 'stenogram-reading-block'`)
        .where(sql<boolean>`nullif(attrs->>'session_key', '') is not null`)
        .where((eb) =>
          eb.or([
            sql<boolean>`title ilike ${needle} escape '\\'`,
            sql<boolean>`body ilike ${needle} escape '\\'`,
          ])
        )
        // GROUP BEFORE CAP (see the header): the cap counts sittings, so a 2,000-block
        // sitting takes one slot, not two thousand.
        .groupBy(sql`attrs->>'session_key'`)
        .orderBy(sql`max(rank_boost) desc nulls last`)
        .orderBy(sql`max(doc_date) desc nulls last`)
        .orderBy(sql`count(*) desc`)
        // Total order, so the same q resolves the same sittings run to run.
        .orderBy(sql`attrs->>'session_key' asc`)
        .limit(capped + 1)
        .execute();

      const truncated = rows.length > capped;
      const sessions = (truncated ? rows.slice(0, capped) : rows).map((r) => ({
        sessionKey: r.session_key,
        matchedBlocks: Number(r.matched_blocks),
      }));
      return ok({ sessions, truncated });
    } catch (e) {
      // A transport/DB failure is NOT "no matches" and NOT "unavailable" — it is an
      // error, and it propagates as one (never swallowed into an empty hit set).
      return err(databaseError('transcript searchSessionKeys failed', e));
    }
  };

  return { docType: PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE, available, searchSessionKeys };
};
