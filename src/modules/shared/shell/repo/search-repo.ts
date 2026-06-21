/**
 * Shared Kernel — Search repo (foundation §4.5).
 *
 * Postgres side of hybrid search over `search.documents`: a CUI presence count
 * and a bounded ILIKE fallback used when Meili/OpenSearch are down. Capped,
 * never an unbounded scan over 6M+ docs.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '../../core/errors.js';
import { SEARCH_ENTITY_DOC_TYPES, type Cui, type SearchHit } from '../../core/types.js';

import type { SearchRepo } from '../../core/ports.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

export const makeSearchRepo = (db: Db): SearchRepo => ({
  async countByCui(cui: Cui): Promise<Result<number, ApiError>> {
    try {
      const row = await db
        .selectFrom('search.documents')
        .select(sql<string>`count(*)`.as('total'))
        .where(sql<boolean>`${cui} = any(cuis)`)
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
        .where(sql<boolean>`title ilike ${'%' + escapedRaw + '%'} escape '\\'`);
      if (docTypes.length > 0) query = query.where('doc_type', 'in', [...docTypes]);

      const rows = await query.limit(capped).execute();
      return ok(
        rows.map(
          (r): SearchHit => ({
            id: r.doc_id,
            docType: r.doc_type,
            title: r.title,
            snippet: r.body !== null ? r.body.slice(0, 200) : null,
            score: null,
            source: 'postgres',
            attrs: r.attrs,
          })
        )
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
          if (isDigits) ors.push(sql<boolean>`${trimmed} = any(cuis)`);
          return eb.or(ors);
        })
        .where('doc_type', 'in', allowlist)
        .where('visibility', '=', 'public')
        .where('deleted_at', 'is', null);

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
            ...(r.cuis.length > 0 && { cuis: r.cuis }),
          };
        })
      );
    } catch (error) {
      return err(databaseError('searchEntities failed', error));
    }
  },
});
