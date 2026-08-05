/**
 * Fixture pins for the ported TLDF core (types/reassemble/fold) and the
 * ported MRL truncation. The fixtures are REAL prod artifacts committed in
 * the scrapper repo and copied here byte-identically:
 *  - render-rows-100023.json — single-row standard_articles doc, 11 act marks
 *  - render-rows-100019.json — smallest chunked doc (manifest + 2 chunk rows)
 *  - mrl-qwen3-100023-win1.json — real 4096-d Qwen3 vector + its
 *    scrapper-produced 1024-d matryoshka truncation
 *
 * The fold gate reaches OUTSIDE this codebase: `text_sha256` was produced by
 * the scrapper's TLDF compiler at load time. If a port drifts from the
 * scrapper implementation, these tests are the tripwire — fix the port, never
 * the fixture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { l2Norm, truncateAndRenormalize } from '@/modules/legal/core/embedding/mrl.js';
import { provenFold } from '@/modules/legal/core/tldf/fold.js';
import { reassembleTldf } from '@/modules/legal/core/tldf/reassemble.js';

import type { TldfEnvelope, TldfPhysicalRow } from '@/modules/legal/core/tldf/types.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/legal/tldf');

interface RenderRowFixture {
  chunk_index: number;
  chunk_count: number;
  block_id: string | null;
  tldf: unknown;
}

function loadRows(name: string): TldfPhysicalRow[] {
  // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
  const raw = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as RenderRowFixture[];
  return raw.map((row) => ({
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    blockId: row.block_id,
    payload: row.tldf as TldfPhysicalRow['payload'],
  }));
}

function mustReassemble(rows: TldfPhysicalRow[]): TldfEnvelope {
  const result = reassembleTldf(rows);
  if (result.isErr()) {
    throw new Error(`fixture failed to reassemble: ${result.error.detail}`);
  }
  return result.value;
}

describe('ported TLDF reassembly + fold against real prod fixtures', () => {
  it('single-row 100023 reassembles and provenFold matches the compiler sha', () => {
    const rows = loadRows('render-rows-100023.json');
    expect(rows).toHaveLength(1);
    const envelope = mustReassemble(rows);
    expect(envelope.document_id).toBe('100023');
    expect(envelope.shape).toBe('standard_articles');
    expect(envelope.marks.length).toBeGreaterThan(0);
    const fold = provenFold(envelope);
    expect(fold.isOk()).toBe(true);
  });

  it('chunked 100019 reassembles across manifest + chunk rows and provenFold matches', () => {
    const rows = loadRows('render-rows-100019.json');
    expect(rows.length).toBeGreaterThan(1);
    const envelope = mustReassemble(rows);
    expect(envelope.document_id).toBe('100019');
    const fold = provenFold(envelope);
    expect(fold.isOk()).toBe(true);
    expect(fold._unsafeUnwrap().length).toBeGreaterThan(400_000);
  });

  it('rejects a chunk set with a missing row as render_inconsistent, never a partial envelope', () => {
    const rows = loadRows('render-rows-100019.json');
    const truncated = rows.slice(0, rows.length - 1);
    const result = reassembleTldf(truncated);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe('render_inconsistent');
  });

  it('rejects a chunk whose head disagrees with the manifest (privacy confusion guard)', () => {
    const rows = loadRows('render-rows-100019.json');
    const lastIndex = rows.length - 1;
    const last = rows[lastIndex];
    if (last === undefined) throw new Error('fixture rows missing');
    const forged: TldfPhysicalRow = {
      ...last,
      payload: {
        ...(last.payload as unknown as Record<string, unknown>),
        privacy_class: 'restricted',
      } as unknown as TldfPhysicalRow['payload'],
    };
    const result = reassembleTldf([...rows.slice(0, lastIndex), forged]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().detail).toContain('disagrees');
  });

  it('provenFold surfaces a fold mismatch instead of returning unproven text', () => {
    const rows = loadRows('render-rows-100023.json');
    const envelope = mustReassemble(rows);
    const corrupted: TldfEnvelope = {
      ...envelope,
      text_sha256: '0'.repeat(64),
    };
    const fold = provenFold(corrupted);
    expect(fold.isErr()).toBe(true);
    expect(fold._unsafeUnwrapErr().reason).toBe('fold_mismatch');
  });
});

describe('ported MRL truncation against the scrapper-produced fixture', () => {
  it('reproduces the committed 1024-d vector float-for-float', () => {
    // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, 'mrl-qwen3-100023-win1.json'), 'utf8')
    ) as { full_4096: number[]; truncated_1024: number[] };
    expect(fixture.full_4096).toHaveLength(4096);
    expect(fixture.truncated_1024).toHaveLength(1024);
    const produced = truncateAndRenormalize(fixture.full_4096, 1024)._unsafeUnwrap();
    expect(produced).toEqual(fixture.truncated_1024);
    expect(l2Norm(produced)).toBeCloseTo(1, 6);
  });
});
