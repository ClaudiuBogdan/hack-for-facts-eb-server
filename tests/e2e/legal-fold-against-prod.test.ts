/**
 * The SERVER's fold, run against the real corpus, checked with a sha that the
 * server had no hand in producing.
 *
 * The committed fixture tests prove the fold is self-consistent: they compare
 * `sha256(fold(blocks))` against `text_sha256`, and both values travel in the
 * same artifact, written by the same scrapper compiler. That is a closed loop —
 * if the compiler mis-segmented a document, its own recorded sha would agree
 * with its own wrong blocks and every fixture would stay green.
 *
 * This suite escapes the loop the only way that counts: the expected sha is read
 * from `portal_text.documents.text_sha256` in the RAW database, computed from
 * the original clean text before TLDF existed, and the fold is the SERVER's
 * independent re-implementation of an algorithm the scrapper also implements.
 * Two implementations, two databases, one number that has to match — that is
 * what makes a green run mean the reader will see the law's actual text.
 *
 * Live-only: set both URLs (through the tunnels) to run it.
 *   LEGAL_FOLD_PROD_URL=... LEGAL_FOLD_RAW_URL=... npx vitest run tests/e2e/legal-fold-against-prod.test.ts
 * Without them the suite skips — and a skipped run is not a passing run.
 */

import { createHash } from 'node:crypto';

import pg from 'pg';
import { describe, expect, it as vitestIt } from 'vitest';

import { tldfToPlainText } from '@/modules/legal/core/tldf/fold.js';
import { reassembleTldf } from '@/modules/legal/core/tldf/reassemble.js';

import type { TldfPhysicalRow } from '@/modules/legal/core/tldf/types.js';

const PROD_URL = process.env['LEGAL_FOLD_PROD_URL'];
const RAW_URL = process.env['LEGAL_FOLD_RAW_URL'];
const live = PROD_URL !== undefined && RAW_URL !== undefined;
const it = live ? vitestIt : vitestIt.skip;

/** Stratified: chunked documents are the ones reassembly can get wrong. */
const SINGLE_SAMPLE = 30;
const CHUNKED_SAMPLE = 20;

interface RenderRow {
  document_id: string;
  chunk_index: number;
  chunk_count: number;
  block_id: string | null;
  tldf: unknown;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('legal TLDF fold vs the raw text sha', () => {
  it('folds a stratified live sample to the sha the raw database recorded', async () => {
    const prod = new pg.Pool({ connectionString: PROD_URL, max: 2 });
    const raw = new pg.Pool({ connectionString: RAW_URL, max: 2 });
    try {
      const sample = await prod.query<{ document_id: string }>(
        `(select document_id from legal.document_render
             where chunk_index = 0 and chunk_count = 1
             order by random() limit $1)
           union all
           (select document_id from legal.document_render
             where chunk_index = 0 and chunk_count > 1
             order by random() limit $2)`,
        [SINGLE_SAMPLE, CHUNKED_SAMPLE]
      );
      const ids = sample.rows.map((r) => r.document_id);
      expect(ids.length).toBeGreaterThanOrEqual(SINGLE_SAMPLE);

      const [renderRows, rawRows] = await Promise.all([
        prod.query<RenderRow>(
          `select document_id, chunk_index, chunk_count, block_id, tldf
               from legal.document_render
              where document_id = any($1::text[])
              order by document_id, chunk_index`,
          [ids]
        ),
        raw.query<{ document_id: string; text_sha256: string }>(
          `select document_id, text_sha256 from portal_text.documents
              where document_id = any($1::text[])`,
          [ids]
        ),
      ]);

      const rawSha = new Map(rawRows.rows.map((r) => [r.document_id, r.text_sha256]));
      const byDocument = new Map<string, TldfPhysicalRow[]>();
      for (const row of renderRows.rows) {
        const rows = byDocument.get(row.document_id) ?? [];
        rows.push({
          chunkIndex: row.chunk_index,
          chunkCount: row.chunk_count,
          blockId: row.block_id,
          payload: row.tldf as TldfPhysicalRow['payload'],
        });
        byDocument.set(row.document_id, rows);
      }

      const failures: string[] = [];
      let chunkedChecked = 0;
      for (const documentId of ids) {
        const rows = byDocument.get(documentId);
        if (rows === undefined) {
          failures.push(`${documentId}: no render rows`);
          continue;
        }
        if (rows.length > 1) chunkedChecked += 1;
        const envelope = reassembleTldf(rows);
        if (envelope.isErr()) {
          failures.push(`${documentId}: reassembly refused (${envelope.error.detail})`);
          continue;
        }
        const expected = rawSha.get(documentId);
        if (expected === undefined) {
          failures.push(`${documentId}: absent from raw portal_text.documents`);
          continue;
        }
        // The artifact's own claim, and the server's re-derivation, each
        // against the raw number. Asserting both separates "the compiler
        // recorded the wrong sha" from "our fold disagrees with it".
        if (envelope.value.text_sha256 !== expected) {
          failures.push(`${documentId}: artifact sha != raw sha`);
          continue;
        }
        const folded = sha256(tldfToPlainText(envelope.value));
        if (folded !== expected) {
          failures.push(`${documentId}: server fold != raw sha`);
        }
      }

      // Report the whole set, never the first failure: one broken document and
      // fifty broken documents call for very different responses.
      expect(failures).toEqual([]);
      // Stratification actually happened — a run that checked only single-chunk
      // documents would prove nothing about reassembly, the risky part.
      expect(chunkedChecked).toBeGreaterThan(0);
    } finally {
      await prod.end();
      await raw.end();
    }
  }, 120_000);
});
