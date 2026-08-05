/**
 * `to_plain_text` — PORTED from the scrapper's frozen transformer
 * (`prod/tldf/fold.ts`, TLDF spec §3.4). Normative emission order: within a
 * block, runs and children interleave by ascending span start; each run
 * contributes `sep + text` (sep defaults to none).
 *
 * `provenFold` is the gate every text-serving surface (MCP markdown, the
 * exporter reconcile sampler, fixture tests) goes through: the fold is only
 * trusted when its sha256 equals the envelope's `text_sha256` — a value
 * produced by the scrapper compiler at load time, OUTSIDE this codebase, so
 * agreement is evidence rather than self-corroboration.
 */
import { createHash } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import type { TldfBlock, TldfEnvelope } from './types.js';

export function tldfToPlainText(envelope: Pick<TldfEnvelope, 'blocks'>): string {
  const parts: string[] = [];
  const emit = (block: TldfBlock): void => {
    const items = [
      ...block.content.map((run) => ({ start: run.span[0], run })),
      ...(block.children ?? []).map((child) => ({
        start: child.span[0],
        child,
      })),
    ].sort((a, b) => a.start - b.start);
    for (const item of items) {
      if ('run' in item) parts.push((item.run.sep ?? '') + item.run.text);
      else emit(item.child);
    }
  };
  for (const block of envelope.blocks) emit(block);
  return parts.join('');
}

export interface FoldMismatch {
  readonly reason: 'fold_mismatch';
  readonly documentId: string;
  readonly expected: string;
  readonly actual: string;
}

export function provenFold(envelope: TldfEnvelope): Result<string, FoldMismatch> {
  const text = tldfToPlainText(envelope);
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  if (sha !== envelope.text_sha256) {
    return err({
      reason: 'fold_mismatch',
      documentId: envelope.document_id,
      expected: envelope.text_sha256,
      actual: sha,
    });
  }
  return ok(text);
}
