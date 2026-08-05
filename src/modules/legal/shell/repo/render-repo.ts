/**
 * Legal module — `LegalRenderRepo`. Reads the TLDF artifact tables
 * (`legal.document_generations` + `legal.document_render`).
 *
 * No gating here: privacy/status decisions live in the usecase so 403/409
 * stay distinguishable from 404 at the surface. `chunk_count` comes off render
 * row 0 (the generation row deliberately does not duplicate it); a served
 * generation with no render rows reads `chunkCount: null` and the usecase
 * reports it as an inconsistency rather than a missing document.
 */

import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import type { LegalRenderRepo } from '../../core/ports.js';
import type { LegalRenderInfo, LegalRenderRow, LegalRenderStatus } from '../../core/types.js';
import type { Kysely } from 'kysely';

type Db = Kysely<ProdDatabase>;

interface InfoRow {
  document_id: string;
  run_id: string;
  text_sha256: string;
  compiler_version: string;
  compiled_at: string;
  render_status: string;
  chunk_count: number | null;
  privacy_class: string | null;
}

const mapInfo = (row: InfoRow): LegalRenderInfo => ({
  documentId: row.document_id,
  // The DDL CHECK constrains the vocabulary; the cast mirrors it.
  renderStatus: row.render_status as LegalRenderStatus,
  // A generation without render rows has no expression-level privacy row yet;
  // defaulting to 'restricted' fails CLOSED (the usecase then reports the
  // missing rows as an inconsistency only for otherwise-servable documents).
  privacyClass: row.privacy_class ?? 'restricted',
  runId: row.run_id,
  textSha256: row.text_sha256,
  compilerVersion: row.compiler_version,
  compiledAt: row.compiled_at,
  chunkCount: row.chunk_count,
});

export const makeLegalRenderRepo = (db: Db): LegalRenderRepo => {
  const selectInfo = () =>
    db
      .selectFrom('legal.document_generations as g')
      .leftJoin('legal.document_render as r', (join) =>
        join.onRef('r.document_id', '=', 'g.document_id').on('r.chunk_index', '=', 0)
      )
      .select([
        'g.document_id',
        'g.run_id',
        'g.text_sha256',
        'g.compiler_version',
        'g.compiled_at',
        'g.render_status',
        'r.chunk_count',
        'r.privacy_class',
      ]);

  const renderInfo = async (
    documentId: string
  ): Promise<Result<LegalRenderInfo | null, ApiError>> => {
    try {
      const row = await selectInfo().where('g.document_id', '=', documentId).executeTakeFirst();
      return ok(row === undefined ? null : mapInfo(row));
    } catch (error) {
      return err(databaseError('renderInfo failed', error));
    }
  };

  const renderInfoForDocuments = async (
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalRenderInfo>, ApiError>> => {
    if (documentIds.length === 0) return ok(new Map());
    try {
      const rows = await selectInfo()
        .where('g.document_id', 'in', [...documentIds])
        .execute();
      return ok(new Map(rows.map((row) => [row.document_id, mapInfo(row)])));
    } catch (error) {
      return err(databaseError('renderInfoForDocuments failed', error));
    }
  };

  const renderRow = async (
    documentId: string,
    chunkIndex: number
  ): Promise<Result<LegalRenderRow | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('legal.document_render')
        .select(['chunk_index', 'chunk_count', 'block_id', 'tldf'])
        .where('document_id', '=', documentId)
        .where('chunk_index', '=', chunkIndex)
        .executeTakeFirst();
      if (row === undefined) return ok(null);
      return ok({
        chunkIndex: row.chunk_index,
        chunkCount: row.chunk_count,
        blockId: row.block_id,
        payload: row.tldf,
      });
    } catch (error) {
      return err(databaseError('renderRow failed', error));
    }
  };

  return { renderInfo, renderInfoForDocuments, renderRow };
};
