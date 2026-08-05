/**
 * Logical-artifact reassembly, PORTED from the scrapper's
 * `prod/tldf/chunk.ts` (`reassembleTldf`) — see types.ts for why a port, not
 * an import. Invariants are identical to the loader's blocking promotion
 * gate: chunk 0 present, contiguous indices, one chunk_count, manifest↔chunk
 * agreement on EVERY shared head field, per-chunk block/span/id agreement,
 * duplicate-block rejection.
 *
 * The scrapper version throws (a lane failure aborts the run); this port
 * returns `Result` per the server core contract — every violation folds to
 * ONE expected condition, `render_inconsistent`, which the REST shell serves
 * as 409 with the detail. A partial or plausible-but-corrupt reading is
 * never returned.
 */
import { err, ok, type Result } from 'neverthrow';

import type { TldfBlock, TldfEnvelope, TldfPhysicalRow } from './types.js';

export interface RenderInconsistency {
  readonly reason: 'render_inconsistent';
  readonly detail: string;
}

const inconsistent = (detail: string): Result<never, RenderInconsistency> =>
  err({ reason: 'render_inconsistent', detail });

export function reassembleTldf(
  rows: readonly TldfPhysicalRow[]
): Result<TldfEnvelope, RenderInconsistency> {
  if (rows.length === 0) return inconsistent('no rows');
  const sorted = [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const head = sorted[0];
  if (head?.chunkIndex !== 0) return inconsistent('chunk 0 missing');
  if (head.blockId !== null) {
    return inconsistent('chunk 0 must carry a null block_id');
  }
  const declaredCount = head.chunkCount;
  for (const [i, row] of sorted.entries()) {
    if (row.chunkIndex !== i) {
      return inconsistent(
        `non-contiguous chunk_index ${String(row.chunkIndex)} at position ${String(i)}`
      );
    }
    if (row.chunkCount !== declaredCount) {
      return inconsistent(
        `inconsistent chunk_count ${String(row.chunkCount)} != ${String(declaredCount)}`
      );
    }
  }
  if (sorted.length !== declaredCount) {
    return inconsistent(`${String(sorted.length)} rows != chunk_count ${String(declaredCount)}`);
  }
  if (declaredCount === 1) {
    const payload = head.payload;
    if ('physical' in payload) {
      return inconsistent('single row must be a plain envelope');
    }
    return ok(payload);
  }
  const manifest = head.payload;
  if (!('physical' in manifest) || manifest.physical !== 'manifest') {
    return inconsistent('chunk 0 of a group must be a manifest');
  }
  const seenBlockIds = new Set<string>();
  const blocks: TldfBlock[] = [];
  for (const [i, row] of sorted.slice(1).entries()) {
    const entry = manifest.chunks[i];
    if (entry?.chunk_index !== row.chunkIndex) {
      return inconsistent(`manifest entry missing for chunk ${String(row.chunkIndex)}`);
    }
    const payload = row.payload;
    if (!('physical' in payload) || payload.physical !== 'chunk') {
      return inconsistent(`chunk ${String(row.chunkIndex)} is not a chunk payload`);
    }
    // EVERY shared head field must agree — a chunk claiming a different
    // privacy class, generation identity, or format under a public manifest
    // is corruption, never a reassembly candidate. Stored jsonb rows can
    // carry anything, so the literal-typed fields are checked at runtime
    // through string-widened locals.
    const payloadFormat: string = payload.format;
    const payloadFormatVersion: string = payload.format_version;
    const manifestFormat: string = manifest.format;
    const manifestFormatVersion: string = manifest.format_version;
    if (
      payloadFormat !== manifestFormat ||
      payloadFormatVersion !== manifestFormatVersion ||
      payload.document_id !== manifest.document_id ||
      payload.privacy_class !== manifest.privacy_class ||
      payload.text_sha256 !== manifest.text_sha256 ||
      payload.generation.run_id !== manifest.generation.run_id ||
      payload.generation.body_sha256 !== manifest.generation.body_sha256 ||
      payload.generation.structure_parser_version !==
        manifest.generation.structure_parser_version ||
      payload.generation.content_parser_version !== manifest.generation.content_parser_version
    ) {
      return inconsistent(`chunk ${String(row.chunkIndex)} head disagrees with the manifest`);
    }
    const first = payload.blocks[0];
    if (first === undefined) {
      return inconsistent(`chunk ${String(row.chunkIndex)} carries no blocks`);
    }
    if (payload.blocks.length !== entry.block_count) {
      return inconsistent(
        `chunk ${String(row.chunkIndex)} has ${String(payload.blocks.length)} blocks, manifest says ${String(entry.block_count)}`
      );
    }
    if (row.blockId === null || row.blockId !== first.id) {
      return inconsistent(
        `chunk ${String(row.chunkIndex)} block_id ${String(row.blockId)} != first payload block ${first.id}`
      );
    }
    if (entry.block_id !== first.id) {
      return inconsistent(
        `manifest names ${entry.block_id} for chunk ${String(row.chunkIndex)}, payload starts at ${first.id}`
      );
    }
    const last = payload.blocks[payload.blocks.length - 1] ?? first;
    if (entry.span[0] !== first.span[0] || entry.span[1] !== last.span[1]) {
      return inconsistent(`chunk ${String(row.chunkIndex)} span disagrees with the manifest`);
    }
    for (const block of payload.blocks) {
      if (seenBlockIds.has(block.id)) {
        return inconsistent(`duplicate block_id ${block.id}`);
      }
      seenBlockIds.add(block.id);
      blocks.push(block);
    }
  }
  if (manifest.chunks.length !== sorted.length - 1) {
    return inconsistent(
      `manifest lists ${String(manifest.chunks.length)} chunks, ${String(sorted.length - 1)} present`
    );
  }
  const { physical, chunks, ...envelopeHead } = manifest;
  void physical;
  void chunks;
  return ok({ ...envelopeHead, blocks });
}
