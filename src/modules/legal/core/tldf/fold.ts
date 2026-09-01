/**
 * `to_plain_text` — PORTED from the scrapper's frozen transformer
 * (`prod/tldf/fold.ts`, TLDF spec §3.4). Normative emission order: within a
 * block, runs and children interleave by ascending span start; each run
 * contributes `sep + text` (sep defaults to none).
 *
 * `provenFold` trusts the fold only when its sha256 equals the envelope's
 * `text_sha256`. Be precise about what that proves: the envelope's sha is
 * COMPILER-PRODUCED, so agreement means this port reproduces the compiler's
 * segmentation — it is a cross-implementation check, NOT an independent one.
 * If the compiler mis-segmented a document, its own recorded sha would agree
 * with its own wrong blocks and this would stay green.
 *
 * The loop is escaped in exactly one place: the e2e suite reads the expected
 * sha from RAW `portal_text.documents.text_sha256`, computed from the original
 * clean text before TLDF existed. That was run against the v6 corpus on
 * 2026-09-01 over a stratified 500-document sample (300 single-chunk, 200
 * chunked): 500 matched, 0 mismatched, 0 reassembly errors.
 *
 * WHAT ACTUALLY CALLS IT, corrected 2026-09-01: only tests. An earlier version
 * of this note claimed MCP markdown and an exporter reconcile sampler go
 * through it; there is no exporter in this repo, MCP serves no node text
 * (`mcp/io.ts:13`), and no production surface folds today. The strongest use is
 * `tests/e2e/legal-fold-against-prod.test.ts`, which folds live prod artifacts
 * against the RAW pre-TLDF `portal_text.documents.text_sha256` — the only gate
 * here that reaches outside the compiler's own claim. CI runs `test:unit` and
 * `test:integration` and NOT `test:e2e`, so that gate is currently dark.
 *
 * EMISSION ORDER IS SHARED, NOT MERELY SIMILAR. This function is
 * ALGORITHMICALLY identical to the scrapper's `prod/tldf/fold.ts` and the
 * client's `lib/tldf/fold.ts` — same sort key, same absence of a tiebreak,
 * same content-before-children order. Not character-identical: the client's is
 * named `foldTldfBlocks` and takes `readonly TldfBlock[]`, and the three differ
 * in wrapping and semicolons, so a literal `diff` will not come back empty.
 *
 * The sort key is `span[0]` with NO tiebreak and content runs are spread
 * before children, so a stable sort always emits a run before a child at an
 * equal offset. Any change to that ordering must land in all three in the same
 * window. Be clear about what would and would not catch you otherwise: nothing
 * runs `provenFold` automatically — only tests call it, and the e2e self-skips
 * without both URLs and is absent from dev CI — so a divergence surfaces as
 * test drift when someone runs it, never as a failed request.
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
