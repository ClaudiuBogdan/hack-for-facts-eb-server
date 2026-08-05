/**
 * Legal module — `LegalGraphRepo` (plan §3.3). Citation/amendment graph over
 * `legal.act_references` + `legal.external_acts`. Every read is `limit`-bounded
 * (hub guard: Legea 47/1992 has 23,527 in-edges — never an unbounded fan-out).
 *
 * Indexes hit: `act_references_target (target_act_id, relation)` for incoming;
 * `act_references_pkey (source_document_id, ref_index)` prefix for outgoing (via
 * the act's canonical document_id). `external_acts_pkey` for the external lookup.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  filterHash,
} from '@/modules/shared/index.js';

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
const MAX_ANCHOR_PAGE = 100;
const ANCHOR_SORT = 'edge_id';

const clampEdges = (n: number): number => Math.min(Math.max(Math.floor(n), 1), MAX_EDGES);

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

  const outgoingRefs = async (
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    limit: number
  ): Promise<Result<readonly LegalReferenceEdge[], ApiError>> => {
    if (!ID_RE.test(actId)) return ok([]);
    const capped = clampEdges(limit);
    try {
      // The act's canonical document is the source of its outgoing references.
      let q = selectRefs()
        .innerJoin('legal.acts as a', 'a.canonical_document_id', 'r.source_document_id')
        .where('a.act_id', '=', actId);
      if (relations !== undefined && relations.length > 0) {
        q = q.where('r.relation', 'in', [...relations]);
      }
      const rows = await q.orderBy('r.ref_index', 'asc').limit(capped).execute();
      return ok(rows.map((r) => mapReferenceEdge(r)));
    } catch (error) {
      return err(databaseError('outgoingRefs failed', error));
    }
  };

  const incomingRefs = async (
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    limit: number
  ): Promise<Result<readonly LegalIncomingEdge[], ApiError>> => {
    if (!ID_RE.test(actId)) return ok([]);
    const capped = clampEdges(limit);
    try {
      // act_references_target (target_act_id, relation) drives this. Join back to
      // the citing act via its canonical document (the edge's source_document_id).
      let q = selectRefs()
        .leftJoin('legal.acts as sa', 'sa.canonical_document_id', 'r.source_document_id')
        .where('r.target_act_id', '=', actId);
      if (relations !== undefined && relations.length > 0) {
        q = q.where('r.relation', 'in', [...relations]);
      }
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
        .orderBy('r.ref_index', 'asc')
        .limit(capped)
        .execute();

      const edges: LegalIncomingEdge[] = rows.map((row) => {
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
      return ok(edges);
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
      // One count + one page. The REAL total, not the page size (§9.1);
      // `document_link_edges_target_act` keeps both reads on the index.
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
