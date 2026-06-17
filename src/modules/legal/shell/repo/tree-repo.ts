/**
 * Legal module — `LegalTreeRepo` (plan §3.4). Intra-act structure over
 * `legal.document_nodes`. **Structure ONLY — no passage text** (the raw
 * `clean_text` lives in the raw cluster the server must not read, §3.4). Nodes
 * carry char offsets as a forward-compat locator, never served text.
 *
 * Indexes hit: `document_nodes_document_id_path_key (document_id, path)` for
 * path/children; `document_nodes_lookup (document_id, node_kind, number_key)` for
 * the article lookup.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { type ApiError, type ProdDatabase, databaseError } from '@/modules/shared/index.js';

import { mapNode } from './mappers.js';

import type { LegalTreeRepo } from '../../core/ports.js';
import type { LegalNode } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const MAX_NODES = 500;

export const makeLegalTreeRepo = (db: Db): LegalTreeRepo => {
  const selectNodes = () =>
    db.selectFrom('legal.document_nodes as n').select([
      'n.node_id',
      'n.document_id',
      'n.parent_node_id',
      'n.node_kind',
      'n.label',
      'n.number_key',
      'n.path',
      'n.order_index',
      'n.char_start',
      'n.char_end',
    ]);

  const nodeChildren = async (
    documentId: string,
    parentNodeId: string | null,
    depth: number
  ): Promise<Result<readonly LegalNode[], ApiError>> => {
    const d = Math.min(Math.max(Math.floor(depth), 1), 3);
    try {
      // Direct children by parent (depth 1); deeper levels are pulled by path
      // prefix off the parent's path. For the top level (parentNodeId=null) we
      // return the roots and one level down (bounded).
      let q = selectNodes().where('n.document_id', '=', documentId);
      if (parentNodeId === null) {
        q = q.where('n.parent_node_id', 'is', null);
      } else {
        if (d === 1) {
          q = q.where('n.parent_node_id', '=', parentNodeId);
        } else {
          // depth>1: descendants of the parent's materialized path.
          const parent = await selectNodes()
            .where('n.document_id', '=', documentId)
            .where('n.node_id', '=', parentNodeId)
            .limit(1)
            .executeTakeFirst();
          if (parent === undefined) return ok([]);
          const prefix = `${parent.path.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
          q = q.where(sql<boolean>`n.path like ${prefix} escape '\\'`).where('n.node_id', '!=', parentNodeId);
        }
      }
      const rows = await q.orderBy('n.order_index', 'asc').limit(MAX_NODES).execute();
      return ok(rows.map((r) => mapNode(r)));
    } catch (error) {
      return err(databaseError('nodeChildren failed', error));
    }
  };

  const nodeByPath = async (
    documentId: string,
    path: string
  ): Promise<Result<LegalNode | null, ApiError>> => {
    try {
      const row = await selectNodes()
        .where('n.document_id', '=', documentId)
        .where('n.path', '=', path)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapNode(row));
    } catch (error) {
      return err(databaseError('nodeByPath failed', error));
    }
  };

  const nodeByArticle = async (
    documentId: string,
    numberKey: string
  ): Promise<Result<LegalNode | null, ApiError>> => {
    try {
      const row = await selectNodes()
        .where('n.document_id', '=', documentId)
        .where('n.node_kind', '=', 'articol')
        .where('n.number_key', '=', numberKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapNode(row));
    } catch (error) {
      return err(databaseError('nodeByArticle failed', error));
    }
  };

  return { nodeChildren, nodeByPath, nodeByArticle };
};
