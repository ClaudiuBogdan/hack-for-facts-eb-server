/**
 * Shared Kernel — Search repo (foundation §4.5).
 *
 * Postgres side of hybrid search over `search.documents`: a CUI presence count
 * and a bounded ILIKE fallback used when Meili/OpenSearch are down. Capped,
 * never an unbounded scan over 6M+ docs.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  isWithheldLookupKey,
  scrubWithheldIdentifiers,
  servableDocumentRowSql,
  servableIdentifierSetSql,
} from './document-privacy.js';
import { databaseError, type ApiError } from '../../core/errors.js';
import { SEARCH_ENTITY_DOC_TYPES, type Cui, type SearchHit } from '../../core/types.js';

import type { SearchRepo } from '../../core/ports.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

export const makeSearchRepo = (db: Db): SearchRepo => ({
  async countByCui(cui: Cui): Promise<Result<number, ApiError>> {
    // A withheld identifier is not a key. Answered before the query runs, so
    // the number never exists in this process at all.
    if (isWithheldLookupKey(cui)) return ok(0);
    try {
      const row = await db
        .selectFrom('search.documents')
        .select(sql<string>`count(*)`.as('total'))
        .where(sql<boolean>`${cui} = any(cuis)`)
        // This count is SERVED — entity-360 renders it and a GraphQL resolver
        // returns it. Unfiltered it answered "how many documents mention this
        // identifier?" for ANY identifier, including a withheld one, and a
        // number is a complete answer to that question: no field-level scrub can
        // redact a count. It also counted tombstoned and non-public rows, so it
        // was wrong as a served figure quite apart from privacy.
        .where(servableDocumentRowSql)
        .where(servableIdentifierSetSql)
        .executeTakeFirst();
      return ok(Number(row?.total ?? 0));
    } catch (error) {
      return err(databaseError('countByCui failed', error));
    }
  },

  async fallbackTextSearch(
    q: string,
    docTypes: readonly string[],
    limit: number
  ): Promise<Result<readonly SearchHit[], ApiError>> {
    const trimmed = q.trim();
    if (trimmed === '') return ok([]);
    const capped = Math.min(Math.max(limit, 1), 50);
    const escapedRaw = trimmed.replace(/[%_\\]/gu, '\\$&');
    try {
      // `search.documents.title` is NOT folded → match the RAW query so
      // diacritic titles are found (this is the engines-down fallback). §15.7.
      let query = db
        .selectFrom('search.documents')
        .select(['doc_id', 'doc_type', 'title', 'body', 'attrs'])
        .where(sql<boolean>`title ilike ${'%' + escapedRaw + '%'} escape '\\'`)
        // The engines-down path had no visibility, tombstone or containment
        // filter at all — so while Meili was unavailable it was the one surface
        // that would return a withheld-keyed document by title match.
        .where(servableDocumentRowSql)
        .where(servableIdentifierSetSql);
      if (docTypes.length > 0) query = query.where('doc_type', 'in', [...docTypes]);

      const rows = await query.limit(capped).execute();
      return ok(
        rows.map((r): SearchHit => ({
          id: r.doc_id,
          docType: r.doc_type,
          title: r.title,
          snippet: r.body !== null ? r.body.slice(0, 200) : null,
          score: null,
          source: 'postgres',
          attrs: r.attrs,
        }))
      );
    } catch (error) {
      return err(databaseError('fallbackTextSearch failed', error));
    }
  },

  async searchEntities(
    q: string,
    opts: {
      readonly docTypes?: readonly string[];
      readonly county?: string;
      readonly year?: number;
      readonly limit: number;
      readonly offset?: number;
    }
  ): Promise<Result<readonly SearchHit[], ApiError>> {
    const trimmed = q.trim();
    if (trimmed === '') return ok([]);

    // Allowlist = requested ∩ entity-grade set (else the full entity-grade set),
    // so the pg fallback can never return content/fragment doc types.
    const allowlist =
      opts.docTypes !== undefined
        ? opts.docTypes.filter((t) => (SEARCH_ENTITY_DOC_TYPES as readonly string[]).includes(t))
        : [...SEARCH_ENTITY_DOC_TYPES];
    // A requested-but-all-invalid docTypes set narrows to nothing — no rows.
    if (allowlist.length === 0) return ok([]);

    const capped = Math.min(Math.max(opts.limit, 1), 50);
    const escapedRaw = trimmed.replace(/[%_\\]/gu, '\\$&');
    const like = '%' + escapedRaw + '%';
    const isDigits = /^\d+$/u.test(trimmed);
    try {
      // `search.documents.title` is NOT folded → match the RAW query so diacritic
      // titles are found (engines-down fallback). Parity with the Meili
      // `searchableAttributes` (title/subtitle/cuis/doc_id): ILIKE on
      // title/body(≈subtitle)/doc_id, plus an EXACT cui hit for all-digit queries
      // so CUI lookups still resolve while Meili is down.
      let query = db
        .selectFrom('search.documents')
        .select(['doc_id', 'doc_type', 'title', 'body', 'county_name', 'url', 'cuis', 'attrs'])
        .where((eb) => {
          const ors = [
            sql<boolean>`title ilike ${like} escape '\\'`,
            sql<boolean>`body ilike ${like} escape '\\'`,
            sql<boolean>`doc_id ilike ${like} escape '\\'`,
          ];
          // DELIBERATELY LEFT AS-IS. This branch is a lookup key by another
          // name, and by the reasoning in `isWithheldLookupKey` it arguably
          // should not fire for a withheld id. But an existing test
          // (`identity-containment-sql.test.ts`) asserts the opposite in as many
          // words -- "the CNP lookup path exists and is guarded" -- so a
          // previous decision chose row-level containment here on purpose.
          // Changing it is the open identifier-level-vs-row-level question
          // (task #15), which belongs to the user, not to a passing test I
          // could rewrite. The asymmetry with countByCui/listByCui is real and
          // is written up rather than silently resolved.
          if (isDigits) ors.push(sql<boolean>`${trimmed} = any(cuis)`);
          return eb.or(ors);
        })
        .where('doc_type', 'in', allowlist)
        .where('visibility', '=', 'public')
        .where('deleted_at', 'is', null)
        // P0 containment on the DEGRADED path. `search.documents` still carries
        // 117,688 `company` docs keyed by a CNP-shaped CUI (the projection purge
        // is a pending data-layer task), and `visibility='public'` does not
        // exclude them. Worse, the all-digit branch above matches
        // `<query> = any(cuis)` — so without this, typing a CNP into search
        // returns that person's document by direct lookup whenever Meili is
        // unavailable.
        //
        // The test is "has NO servable CUI", not "has a withheld one". Measured:
        // all 117,688 company docs are keyed ONLY to a withheld id (drop them),
        // while 2,047 of 2,067 procurement contracts also carry a servable buyer
        // CUI — those are public acts and must stay searchable; only the 20
        // keyed solely to a person are withheld. Docs with no CUIs at all (legal
        // acts, reports) are unaffected.
        .where(servableIdentifierSetSql);

      if (opts.county !== undefined && opts.county.trim() !== '') {
        query = query.where('county_name', '=', opts.county.trim());
      }
      // No `year` column on search.documents — derive it from `doc_date`.
      if (opts.year !== undefined && Number.isInteger(opts.year)) {
        query = query.where(sql<boolean>`extract(year from doc_date) = ${opts.year}`);
      }
      if (opts.offset !== undefined) query = query.offset(opts.offset);

      // Deterministic order so limit/offset paging can't skip or duplicate rows
      // across requests on the degraded path: importance first, doc_id tiebreak.
      const rows = await query
        .orderBy(sql`rank_boost desc nulls last`)
        .orderBy('doc_id', 'asc')
        .limit(capped)
        .execute();
      return ok(
        rows.map((r): SearchHit => {
          // `doc_key` = the id key (everything after the first `:`); the whole
          // id when there is no separator.
          const sepIdx = r.doc_id.indexOf(':');
          const docKey = sepIdx >= 0 ? r.doc_id.slice(sepIdx + 1) : r.doc_id;
          // No `subtitle` column on search.documents — derive it from `body`.
          const subtitle = r.body !== null ? r.body.slice(0, 300) : undefined;
          return {
            id: r.doc_id,
            docType: r.doc_type,
            title: r.title,
            snippet: r.body !== null ? r.body.slice(0, 200) : null,
            score: null,
            source: 'postgres',
            attrs: r.attrs,
            docId: r.doc_id,
            docKey,
            ...(subtitle !== undefined && { subtitle }),
            ...(r.county_name !== null && { countyName: r.county_name }),
            ...(r.url !== null && { url: r.url }),
            // Scrub withheld ids from the echoed array. The 2,047 retained
            // contracts legitimately involve a PFA, but the contract is the
            // public act — the person's identifier is not, and it must not ride
            // out on a hit that was matched on something else entirely.
            ...(() => {
              const servable = scrubWithheldIdentifiers(r.cuis);
              return servable.length > 0 ? { cuis: servable } : {};
            })(),
          };
        })
      );
    } catch (error) {
      return err(databaseError('searchEntities failed', error));
    }
  },
});
