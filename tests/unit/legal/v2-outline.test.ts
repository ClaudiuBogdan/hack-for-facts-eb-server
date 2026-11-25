/**
 * The legal_v2 outline: provisions composed by per-unit offsets, each given
 * the id of the render block it is (the client's `tldf-{path}` anchor).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  composeV2Outline,
  flattenBlocks,
  outlineTypeOfKind,
  type V2OutlineUnit,
  type V2ProvisionRow,
} from '@/modules/legal/core/v2/outline.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  text: string;
  render: { body: string }[];
  provisions: {
    provision_seq: number;
    kind: string;
    citation_path: string | null;
    address: string | null;
    address_state: string;
    label_raw: string | null;
    source_element_id: string | null;
    char_start: number;
    char_end: number;
  }[];
}

const unitOf = (id: string, ordinal: number): V2OutlineUnit => {
  // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
  const f = JSON.parse(
    readFileSync(path.join(here, '../../fixtures/legal/v2', `unit-${id}.json`), 'utf8')
  ) as Fixture;
  const provisions: V2ProvisionRow[] = f.provisions.map((p) => ({
    provisionSeq: p.provision_seq,
    kind: p.kind,
    citationPath: p.citation_path,
    address: p.address ?? null,
    addressState: p.address_state,
    labelRaw: p.label_raw,
    sourceElementId: p.source_element_id,
    charStart: p.char_start,
    charEnd: p.char_end,
  }));
  return {
    componentOrdinal: ordinal,
    textLength: f.text.length,
    provisions,
    blocks: f.render.flatMap((r) =>
      // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
      flattenBlocks((JSON.parse(r.body) as { blocks: unknown[] }).blocks)
    ),
  };
};

describe('legal_v2 outline', () => {
  it('gives every provision of a real unit the id of its render block', () => {
    for (const id of ['8154', '8851', '146017']) {
      const unit = unitOf(id, 0);
      const ids = new Set(unit.blocks.map((b) => b.id));
      const entries = composeV2Outline('f1', [unit]);
      expect(entries).toHaveLength(unit.provisions.length);
      for (const e of entries) {
        expect(ids.has(e.path)).toBe(true);
        const block = unit.blocks.find((b) => b.id === e.path);
        expect(block?.kind).toBe(e.nodeKind);
        expect([block?.span[0], block?.span[1]]).toEqual([e.charStart, e.charEnd]);
      }
    }
  });

  it('ranks headings with the grammar depth and leaves sub-article provisions unranked', () => {
    const entries = composeV2Outline('f1', [unitOf('8154', 0)]);
    const articles = entries.filter((e) => e.nodeKind === 'articol');
    expect(articles.length).toBeGreaterThan(0);
    for (const a of articles) expect(a.depth).toBe(7);
    for (const e of entries.filter((x) => x.nodeKind === 'alineat')) expect(e.depth).toBeNull();
    expect(outlineTypeOfKind('anexa')).toBe('ANX');
    expect(outlineTypeOfKind('constructor')).toBeNull();
    expect(entries.map((e) => e.orderIndex)).toEqual(entries.map((_, i) => i));
  });

  it('composes several units by offset and keeps their block ids apart', () => {
    const a = unitOf('8851', 0);
    const b = unitOf('146017', 1);
    const entries = composeV2Outline('f1', [b, a]);
    const fromB = entries.filter((e) => e.path.startsWith('1.'));
    const fromA = entries.filter((e) => e.path.startsWith('0.'));
    expect(fromA).toHaveLength(a.provisions.length);
    expect(fromB).toHaveLength(b.provisions.length);
    const local = composeV2Outline('f1', [b]);
    expect(fromB.map((e) => [e.charStart, e.charEnd])).toEqual(
      local.map((e) => [a.textLength + 1 + e.charStart!, a.textLength + 1 + e.charEnd!])
    );
    expect(entries.indexOf(fromA[0] ?? entries[0]!)).toBeLessThan(entries.indexOf(fromB[0]!));
  });

  it('keeps a non-DOM key when no block has the provision span', () => {
    const entries = composeV2Outline('f1', [
      {
        componentOrdinal: 0,
        textLength: 10,
        provisions: [
          {
            provisionSeq: 3,
            kind: 'articol',
            citationPath: 'art:1',
            address: 'art:1',
            addressState: 'unique',
            labelRaw: 'Articolul 1',
            sourceElementId: null,
            charStart: 0,
            charEnd: 5,
          },
        ],
        blocks: [],
      },
    ]);
    expect(entries[0]).toMatchObject({ path: 'prov:0:3', numberKey: '1', numberStatus: 'parsed' });
  });
});
