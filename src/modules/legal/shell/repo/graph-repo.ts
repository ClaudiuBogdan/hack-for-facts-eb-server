/**
 * Legal module — `LegalGraphRepo` (plan §3.3). Citation/amendment graph over
 * `legal.act_references` + `legal.external_acts`. Every read is page-bounded
 * (hub guard: Legea 47/1992 has 26,277 in-edges — never an unbounded fan-out)
 * and keyset-paged on the `act_references` PK `(source_document_id,
 * ref_index)`, the one tuple that is unique in BOTH directions: OUT pins one
 * canonical source document (order degenerates to `ref_index asc`, unchanged),
 * IN spans thousands of source documents where `ref_index` alone ties
 * massively. `source_document_id` is compared and ordered under the same
 * column collation, so the cursor predicate and ORDER BY agree by construction.
 *
 * Indexes hit: `act_references_target (target_act_id, relation)` for incoming;
 * `act_references_pkey (source_document_id, ref_index)` prefix for outgoing (via
 * the act's canonical document_id). `external_acts_pkey` for the external lookup.
 */

import { sql, type Kysely } from 'kysely';
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

import { LINKS_SORT, linksFhash } from './filter-helpers.js';
import { mapAct, mapExternalAct, mapReferenceEdge, type ActRow } from './mappers.js';

import type { CursorPageRequest, LegalGraphRepo } from '../../core/ports.js';
import type {
  LegalExternalAct,
  LegalIncomingAnchorsPage,
  LegalIncomingEdge,
  LegalReferenceEdge,
  LegalRelation,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const ID_RE = /^\d+$/u;
const MAX_EDGES = 200;
/** Page cap: the +1 probe must stay INSIDE the physical MAX_EDGES read bound. */
const MAX_LINKS_PAGE = MAX_EDGES - 1;
const MAX_ANCHOR_PAGE = 100;
const ANCHOR_SORT = 'edge_id';

const clampLinksPage = (n: number): number => Math.min(Math.max(Math.floor(n), 1), MAX_LINKS_PAGE);

export const makeLegalGraphRepo = (db: Db): LegalGraphRepo => {
  const selectRefs = () =>
    db
      .selectFrom('legal.act_references as r')
      .select([
        'r.source_document_id',
        'r.ref_index',
        'r.relation',
        'r.target_raw',
        'r.target_class',
        'r.target_act_id',
        'r.target_external_act_id',
        'r.target_fragment',
        'r.resolution',
        'r.confidence',
        'r.resolver_version',
      ]);

  /**
   * Decode + validate a links `after` cursor: keys are the PK tuple
   * `(source_document_id, ref_index)`. Validated here so a tampered key fails
   * cleanly instead of surfacing as a bind error mid-query.
   */
  const decodeLinksCursor = (
    after: string | undefined,
    fhash: string
  ): Result<{ doc: string; ref: number } | null, ApiError> => {
    if (after === undefined) return ok(null);
    const decoded = decodeCursor(after, { sort: LINKS_SORT, dir: 'asc', fhash });
    if (decoded.isErr()) return err(decoded.error);
    const [doc, ref] = decoded.value.keys;
    if (doc === undefined || doc === '') {
      return err(databaseError('links cursor carries an empty document key'));
    }
    if (ref === undefined || !ID_RE.test(ref)) {
      return err(databaseError('links cursor carries a non-numeric ref key'));
    }
    return ok({ doc, ref: Number.parseInt(ref, 10) });
  };

  /** Strictly-after predicate on the PK tuple: no repeats (strict >), no skips (=+tiebreak). */
  const afterPk = (cursor: { doc: string; ref: number }): ReturnType<typeof sql<boolean>> =>
    sql<boolean>`(r.source_document_id > ${cursor.doc} or (r.source_document_id = ${cursor.doc} and r.ref_index > ${cursor.ref}))`;

  const outgoingRefs = async (
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<LegalReferenceEdge>, ApiError>> => {
    if (!ID_RE.test(actId)) return ok({ items: [], next: null });
    const limit = clampLinksPage(page.first);
    const fhash = linksFhash('out', actId, relations);
    const cursorRes = decodeLinksCursor(page.after, fhash);
    if (cursorRes.isErr()) return err(cursorRes.error);
    const cursor = cursorRes.value;
    try {
      // The act's canonical document is the source of its outgoing references.
      let q = selectRefs()
        .innerJoin('legal.acts as a', 'a.canonical_document_id', 'r.source_document_id')
        .where('a.act_id', '=', actId);
      if (relations !== undefined && relations.length > 0) {
        q = q.where('r.relation', 'in', [...relations]);
      }
      if (cursor !== null) q = q.where(afterPk(cursor));
      const rows = await q
        .orderBy('r.source_document_id', 'asc')
        .orderBy('r.ref_index', 'asc')
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapReferenceEdge(r));
      const last = items[items.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: LINKS_SORT,
              dir: 'asc',
              fhash,
              lastKeys: [last.sourceDocumentId, String(last.refIndex)],
            })
          : null;
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('outgoingRefs failed', error));
    }
  };

  const incomingRefs = async (
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<LegalIncomingEdge>, ApiError>> => {
    if (!ID_RE.test(actId)) return ok({ items: [], next: null });
    const limit = clampLinksPage(page.first);
    const fhash = linksFhash('in', actId, relations);
    const cursorRes = decodeLinksCursor(page.after, fhash);
    if (cursorRes.isErr()) return err(cursorRes.error);
    const cursor = cursorRes.value;
    try {
      // act_references_target (target_act_id, relation) drives this. Join back to
      // the citing act via its canonical document (the edge's source_document_id).
      let q = selectRefs()
        .leftJoin('legal.acts as sa', 'sa.canonical_document_id', 'r.source_document_id')
        .where('r.target_act_id', '=', actId);
      if (relations !== undefined && relations.length > 0) {
        q = q.where('r.relation', 'in', [...relations]);
      }
      if (cursor !== null) q = q.where(afterPk(cursor));
      const rows = await q
        .select([
          'sa.act_id as sa_act_id',
          'sa.act_natural_key as sa_act_natural_key',
          'sa.act_type as sa_act_type',
          'sa.act_number as sa_act_number',
          'sa.act_year as sa_act_year',
          'sa.issuer_slug as sa_issuer_slug',
          'sa.canonical_document_id as sa_canonical_document_id',
          'sa.display_citation as sa_display_citation',
          'sa.status as sa_status',
          'sa.status_evidence as sa_status_evidence',
          sql<string | null>`sa.entry_into_force::text`.as('sa_entry_into_force'),
          'sa.in_degree as sa_in_degree',
        ])
        // The PK order — NOT bare ref_index, which ties across every citing
        // document and made deep IN reads non-deterministic. Edges arrive
        // grouped by citing document.
        .orderBy('r.source_document_id', 'asc')
        .orderBy('r.ref_index', 'asc')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const edges: LegalIncomingEdge[] = pageRows.map((row) => {
        const edge = mapReferenceEdge(row);
        const sourceAct =
          row.sa_act_id === null
            ? null
            : mapAct({
                act_id: row.sa_act_id,
                act_natural_key: row.sa_act_natural_key,
                act_type: row.sa_act_type,
                act_number: row.sa_act_number,
                act_year: row.sa_act_year,
                issuer_slug: row.sa_issuer_slug,
                canonical_document_id: row.sa_canonical_document_id,
                display_citation: row.sa_display_citation,
                status: row.sa_status,
                status_evidence: row.sa_status_evidence,
                entry_into_force: row.sa_entry_into_force,
                in_degree: row.sa_in_degree,
              } as unknown as ActRow);
        return { edge, sourceAct };
      });
      const last = edges[edges.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: LINKS_SORT,
              dir: 'asc',
              fhash,
              lastKeys: [last.edge.sourceDocumentId, String(last.edge.refIndex)],
            })
          : null;
      return ok({ items: edges, next });
    } catch (error) {
      return err(databaseError('incomingRefs failed', error));
    }
  };

  const externalAct = async (
    externalActId: string
  ): Promise<Result<LegalExternalAct | null, ApiError>> => {
    if (!ID_RE.test(externalActId)) return ok(null);
    try {
      const row = await db
        .selectFrom('legal.external_acts as x')
        .select(['x.external_act_id', 'x.identity_key', 'x.display_citation', 'x.kind'])
        .where('x.external_act_id', '=', externalActId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapExternalAct(row));
    } catch (error) {
      return err(databaseError('externalAct failed', error));
    }
  };

  const incomingAnchors = async (
    actId: string,
    page: CursorPageRequest
  ): Promise<Result<LegalIncomingAnchorsPage, ApiError>> => {
    if (!ID_RE.test(actId)) return ok({ items: [], next: null, totalCount: 0 });
    const limit = Math.min(Math.max(page.first, 1), MAX_ANCHOR_PAGE);
    // The cursor binds the act: a cursor minted for one act's anchors must
    // not silently page a different act's.
    const fhash = filterHash(`anchors:${actId}`);

    let afterEdgeId: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: ANCHOR_SORT, dir: 'asc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      const raw = decoded.value.keys[0];
      if (raw === undefined || !ID_RE.test(raw)) {
        return err(databaseError('anchors cursor carries a non-numeric key'));
      }
      afterEdgeId = raw;
    }

    try {
      // NO GENERATION JOIN HERE, AND THAT IS DELIBERATE — the database
      // already guarantees it. These rows serve `char_start`/`char_end`,
      // offsets into ONE generation's clean text, so the question "could this
      // return anchors into text we no longer serve?" is the right one to ask.
      // The answer is no, by three VALIDATED constraints (checked 2026-09-01):
      //   * `document_link_edges_generation_fk` FOREIGN KEY
      //     (document_id, run_id) REFERENCES document_generations
      //     (document_id, run_id), convalidated = true
      //   * `document_link_edges.run_id` is NOT NULL (0 rows null)
      //   * `document_generations_pkey` is PRIMARY KEY (document_id) ALONE —
      //     exactly ONE generation row per document
      // Together: an edge's run_id IS the served generation's run_id, and a
      // recompile cannot violate an enforced FK.
      //
      // A pinning join was written here and then REMOVED after measuring it.
      // It is a provable no-op (0 of 2,844,824 edges differ), and because the
      // count and the page share this builder, it landed on the count path:
      // hub act 185829, count went 148 ms / 31,072 buffers -> 225 ms / 98,077
      // buffers, since the planner builds a hash over the whole
      // document_generations index on every call. Paging a hub at 100/page
      // re-runs that count per page.
      //
      // This differs from `render-repo.ts:56-59`, which DOES bind the
      // generation: `document_render` has no such FK, so there the join is the
      // guarantee rather than a restatement of one. Module policy, for the
      // record: `retrieval-repo` pins with a LEFT join and degrades to NULL;
      // `outline-repo` pins with an INNER join and drops the row.
      //
      // WHAT THIS BUILDER DOES NOT GIVE YOU: the page and the count below run
      // as two statements under `Promise.all`, so they may take different
      // pool connections and different READ COMMITTED snapshots. Sharing
      // `serving()` makes their PREDICATE identical, not their snapshot — a
      // projection committing between the two can leave `totalCount` counting
      // a population the page did not see. Exact same-snapshot agreement would
      // need one statement (a window count) or a shared repeatable-read
      // transaction; neither is worth it for an anchor list.
      const serving = () =>
        db
          .selectFrom('legal.document_link_edges as e')
          .where('e.link_kind', '=', 'act')
          .where('e.target_act_id', '=', actId)
          .where('e.privacy_class', '=', 'public');

      let q = serving()
        .leftJoin('legal.act_documents as d', 'd.document_id', 'e.document_id')
        .select([
          'e.edge_id',
          'e.document_id',
          'e.source_node_path',
          'e.ordinal',
          'e.link_text',
          'e.target_fragment',
          'e.target_node_path',
          'e.target_resolution',
          'e.char_start',
          'e.char_end',
          'd.act_id as source_act_id',
        ]);
      if (afterEdgeId !== undefined) {
        q = q.where('e.edge_id', '>', afterEdgeId);
      }
      // One count + one page. The REAL total, not the page size (§9.1).
      // The two reads use DIFFERENT indexes: the page rides
      // `document_link_edges_target_act_edge_idx` (target + edge_id, so the
      // keyset order is free) and the count rides
      // `document_link_edges_target_act`.
      const [rows, total] = await Promise.all([
        q
          .orderBy('e.edge_id', 'asc')
          .limit(limit + 1)
          .execute(),
        serving()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((row) => ({
        edgeId: row.edge_id,
        sourceDocumentId: row.document_id,
        sourceActId: row.source_act_id,
        sourceNodePath: row.source_node_path,
        ordinal: row.ordinal,
        linkText: row.link_text,
        targetFragment: row.target_fragment,
        targetNodePath: row.target_node_path,
        targetResolution: row.target_resolution,
        charStart: row.char_start,
        charEnd: row.char_end,
      }));
      const last = items[items.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({ sort: ANCHOR_SORT, dir: 'asc', fhash, lastKeys: [last.edgeId] })
          : null;
      return ok({ items, next, totalCount: Number(total?.n ?? 0) });
    } catch (error) {
      return err(databaseError('incomingAnchors failed', error));
    }
  };

  return { outgoingRefs, incomingRefs, externalAct, incomingAnchors };
};
