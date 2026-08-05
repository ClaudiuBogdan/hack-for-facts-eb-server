/**
 * Legal module — `LegalOutlineRepo`. The document TOC over
 * `legal.document_nodes` v2 (the tldf-projection lane's node table).
 *
 * Correctness constraints this repo exists to enforce (the old tree-repo
 * violated both while the corpus load was writing v2 rows):
 *  - `role IS NULL` — role-bearing rows are heading/label runs INSIDE a
 *    node; without the filter an article shows up ~4 times.
 *  - NO path-prefix queries — `unmarked:N` keys carry no hierarchy in the
 *    string, so `path like 'x%'` silently lies for facsimile/unmarked
 *    content. Ordering is `order_index` (document order), depth is the fixed
 *    grammar rank (core/outline.ts).
 *
 * The stable key is `(document_id, path)`; `node_id` is minted fresh on
 * every recompile and never leaves this repo.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  filterHash,
} from '@/modules/shared/index.js';

import {
  OUTLINE_DEPTH_RANK,
  outlineKindsForDepth,
  type OutlineHeadingKind,
} from '../../core/outline.js';

import type { LegalOutlineOptions, LegalOutlineRepo } from '../../core/ports.js';
import type { LegalOutlineEntry } from '../../core/types.js';
import type { Kysely } from 'kysely';

type Db = Kysely<ProdDatabase>;

const MAX_OUTLINE_PAGE = 500;
const OUTLINE_SORT = 'order_index';

interface OutlineRow {
  document_id: string;
  path: string;
  node_kind: string;
  label: string | null;
  number_key: string | null;
  number_system: string | null;
  number_status: string | null;
  order_index: number;
  char_start: number | null;
  char_end: number | null;
}

const mapEntry = (row: OutlineRow): LegalOutlineEntry => ({
  documentId: row.document_id,
  path: row.path,
  nodeKind: row.node_kind,
  label: row.label,
  numberKey: row.number_key,
  numberSystem: row.number_system,
  numberStatus: row.number_status,
  // Rows are pre-filtered to outline kinds, so the cast cannot miss.
  depth: OUTLINE_DEPTH_RANK[row.node_kind as OutlineHeadingKind],
  orderIndex: row.order_index,
  charStart: row.char_start,
  charEnd: row.char_end,
});

export const makeLegalOutlineRepo = (db: Db): LegalOutlineRepo => {
  const selectEntries = () =>
    db
      .selectFrom('legal.document_nodes as n')
      .select([
        'n.document_id',
        'n.path',
        'n.node_kind',
        'n.label',
        'n.number_key',
        'n.number_system',
        'n.number_status',
        'n.order_index',
        'n.char_start',
        'n.char_end',
      ]);

  const outline = async (
    options: LegalOutlineOptions
  ): Promise<Result<CursorPage<LegalOutlineEntry>, ApiError>> => {
    const limit = Math.min(Math.max(options.page.first, 1), MAX_OUTLINE_PAGE);
    const kinds = outlineKindsForDepth(options.maxDepth);
    // The cursor binds document + depth budget: a cursor minted for one
    // outline must not silently page a different one.
    const fhash = filterHash(`outline:${options.documentId}:${String(options.maxDepth)}`);

    let afterOrderIndex: number | undefined;
    if (options.page.after !== undefined) {
      const decoded = decodeCursor(options.page.after, {
        sort: OUTLINE_SORT,
        dir: 'asc',
        fhash,
      });
      if (decoded.isErr()) return err(decoded.error);
      const raw = decoded.value.keys[0];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        return err(databaseError('outline cursor carries a non-numeric key'));
      }
      afterOrderIndex = parsed;
    }

    try {
      let q = selectEntries()
        .where('n.document_id', '=', options.documentId)
        .where('n.role', 'is', null)
        .where('n.node_kind', 'in', kinds);
      if (afterOrderIndex !== undefined) {
        q = q.where('n.order_index', '>', afterOrderIndex);
      }
      const rows = await q
        .orderBy('n.order_index', 'asc')
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapEntry);
      let next: string | null = null;
      const last = items[items.length - 1];
      if (hasMore && last !== undefined) {
        next = buildNextCursor({
          sort: OUTLINE_SORT,
          dir: 'asc',
          fhash,
          lastKeys: [String(last.orderIndex)],
        });
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('outline failed', error));
    }
  };

  const entryByPath = async (
    documentId: string,
    path: string
  ): Promise<Result<LegalOutlineEntry | null, ApiError>> => {
    try {
      const row = await selectEntries()
        .where('n.document_id', '=', documentId)
        .where('n.path', '=', path)
        .where('n.role', 'is', null)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapEntry(row));
    } catch (error) {
      return err(databaseError('entryByPath failed', error));
    }
  };

  const entryByArticle = async (
    documentId: string,
    numberKey: string
  ): Promise<Result<LegalOutlineEntry | null, ApiError>> => {
    try {
      const row = await selectEntries()
        .where('n.document_id', '=', documentId)
        .where('n.node_kind', '=', 'articol')
        .where('n.role', 'is', null)
        .where('n.number_key', '=', numberKey)
        .orderBy('n.order_index', 'asc')
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapEntry(row));
    } catch (error) {
      return err(databaseError('entryByArticle failed', error));
    }
  };

  return { outline, entryByPath, entryByArticle };
};
