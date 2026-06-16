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

import type { SearchRepo } from '../../core/ports.js';
import type { Cui, SearchHit } from '../../core/types.js';
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
});
