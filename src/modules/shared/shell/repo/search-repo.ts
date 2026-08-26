/**
 * Shared Kernel — Search repo (foundation §4.5).
 *
 * Postgres side of hybrid search over `search.documents`. One method remains: a
 * privacy-scoped CUI presence count. The ILIKE degrade path that used to live
 * here was removed 2026-08-26 (SEARCH_LAYER_REVIEW_2026-08-25.md D5) — see the
 * note at the bottom of the factory.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  isWithheldLookupKey,
  servableDocumentRowSql,
  servableIdentifierSetSql,
} from './document-privacy.js';
import { databaseError, type ApiError } from '../../core/errors.js';
import { type Cui } from '../../core/types.js';

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

  // The count above is ALSO known to under-report, because `search.documents` is
  // only partially maintained. That is D6, which the user considered and
  // explicitly deferred on 2026-08-26 ("leave search.documents alone"), so it
  // stays wrong on purpose rather than being patched here.
  //
  // `fallbackTextSearch` removed 2026-08-25 (SEARCH_LAYER_REVIEW D9): no
  // production caller, and its e2e test documented that it did NOT pin
  // visibility.
  //
  // `searchEntities` removed 2026-08-26 (D5): it was global search's degrade
  // path — `title/body/doc_id ILIKE '%q%'` over 13.8M rows with no trigram
  // index, a sequential scan that turned a search outage into a database
  // incident while looking like a working fallback. The outage path now resolves
  // an exact CUI over the indexed identity spine inside the usecase.
});
