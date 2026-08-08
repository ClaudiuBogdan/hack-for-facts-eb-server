/**
 * Legal module — `LegalOutlineRepo`. The document TOC over
 * `legal.document_nodes` v2 (the tldf-projection lane's node table).
 *
 * Correctness constraints this repo exists to enforce (the old tree-repo
 * violated the first two while the corpus load was writing v2 rows):
 *  - `role IS NULL` — role-bearing rows are heading/label runs INSIDE a
 *    node; without the filter an article shows up ~4 times.
 *  - NO path-prefix queries — `unmarked:N` keys carry no hierarchy in the
 *    string, so `path like 'x%'` silently lies for facsimile/unmarked
 *    content. Ordering is `order_index` (document order, unique per document —
 *    verified over all 70,062,662 rows), depth is the fixed grammar rank
 *    (core/outline.ts).
 *  - GENERATION PIN — `document_nodes` still holds 10,152 legacy split-v2 rows
 *    over 137 documents (`run_id IS NULL`), and they carry `role IS NULL`, a
 *    label and a number_key, so the two filters above match them. Measured on
 *    exactly those documents, the unpinned predicate returned 10,015 legacy
 *    rows and ZERO current rows: their whole TOC came from a retired
 *    generation, when the honest answer is an empty outline. The join to
 *    `document_generations` on `(document_id, run_id)` is what makes the pin
 *    structural — `run_id IS NOT NULL` would not, because the generation FK is
 *    still NOT VALID. Evidence: scrapper
 *    prod-db/LEGAL_NODES_V41_SERVING_AUDIT_2026-08-08.md §3 D1.
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
  outlineTypesForDepth,
  type OutlineHeadingType,
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
  node_kind: string | null;
  node_type: string | null;
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
  // `role IS NULL` rows always carry a node_kind (DDL:
  // `(disposition = 'role') = (node_kind IS NULL)`), and every caller filters
  // on role. The fallback is unreachable rather than cosmetic — it exists so a
  // contract change surfaces as a visibly wrong kind, not a crash.
  nodeKind: row.node_kind ?? 'necunoscut',
  label: row.label,
  numberKey: row.number_key,
  numberSystem: row.number_system,
  numberStatus: row.number_status,
  // Rows are pre-filtered to outline TYPES, so the cast cannot miss.
  depth: OUTLINE_DEPTH_RANK[row.node_type as OutlineHeadingType],
  orderIndex: row.order_index,
  charStart: row.char_start,
  charEnd: row.char_end,
});

export const makeLegalOutlineRepo = (db: Db): LegalOutlineRepo => {
  // Every read goes through this select: the generation join is the pin, and
  // putting it here means `entryByPath` inherits it too (it is reachable for
  // the same 137 legacy documents as `outline`).
  const selectEntries = () =>
    db
      .selectFrom('legal.document_nodes as n')
      .innerJoin('legal.document_generations as g', (join) =>
        join.onRef('g.document_id', '=', 'n.document_id').onRef('g.run_id', '=', 'n.run_id')
      )
      .select([
        'n.document_id',
        'n.path',
        'n.node_kind',
        'n.node_type',
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
    const types = outlineTypesForDepth(options.maxDepth);
    if (types.length === 0) return ok({ items: [], next: null });
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
        .where('n.node_type', 'in', types);
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

  // `entryByArticle(documentId, numberKey)` used to live here. It is gone on
  // purpose: article numbers restart inside annexes, so the pair is not an
  // identity — 5,303 documents contain 32,484 duplicate
  // (document_id, number_key) article groups, and the method answered them by
  // silently taking the lowest order_index. `path` is the identity (the
  // citation-path decision in scrapper
  // prod-db/LEGAL_SECTION_ANCHOR_REDESIGN_2026-08-06.md); a future "article N"
  // lookup must resolve through a container-qualified path or return the
  // ambiguity, never pick a winner.

  return { outline, entryByPath };
};
