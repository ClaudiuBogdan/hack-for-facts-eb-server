/**
 * The render conversion `tldf-unit` v1 → TLDF 1.1, proven on three real units
 * (tests/fixtures/legal/v2: what legal_v2 stores for them, and the old
 * compiler's envelope of the same input) with the server's own independent
 * gates: `reassembleTldf` (the physical layout) and `provenFold` (the fold's
 * sha256 against the text the parser hashed).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { provenFold } from '@/modules/legal/core/tldf/fold.js';
import { reassembleTldf } from '@/modules/legal/core/tldf/reassemble.js';
import {
  convertUnitRender,
  linkKindFromHref,
  textOnlyBlocks,
  toTldfLink,
  v2PhysicalChunkCount,
  type V2LinkTarget,
  type V2PhysicalPayload,
} from '@/modules/legal/core/v2/tldf-unit.js';

import type { TldfBlock, TldfPhysicalRow } from '@/modules/legal/core/tldf/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Fixture {
  pageId: string;
  text: string;
  textSha256: string;
  unit: { render_state: 'structured'; compiler_version: string; text_sha256: string };
  render: { chunk_seq: number; body: string; char_start: number; char_end: number }[];
  links: {
    ordinal: number;
    href: string;
    target_page_id: string | null;
    target_fragment: string | null;
  }[];
  assets: { ordinal: number }[];
  reference: {
    blocks: TldfBlock[];
    marks: { ordinal: number; kind: string; span: [number, number]; link?: { kind: string } }[];
    shape: string;
    contains_non_bmp: boolean;
  };
}

const fixture = (id: string): Fixture =>
  // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
  JSON.parse(
    readFileSync(path.join(here, '../../fixtures/legal/v2', `unit-${id}.json`), 'utf8')
  ) as Fixture;

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const HEAD = {
  documentId: 'f7',
  runId: 99,
  compilerVersion: 'unit-compiler-v1',
  bodySha256: 'b'.repeat(64),
  parseBuildId: 'build-1',
  contentParserVersion: 'v9',
  sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/1',
};

/** The payloads as physical rows, for the legacy reassembly gate. */
const asRows = (payloads: readonly V2PhysicalPayload[]): TldfPhysicalRow[] =>
  payloads.map((p, i) => ({
    chunkIndex: i,
    chunkCount: payloads.length,
    blockId: p.kind === 'chunk' ? (p.tldf.blocks[0]?.id ?? null) : null,
    payload: p.tldf,
  }));

const links = (f: Fixture, actOf: (page: string) => string | null): Map<number, V2LinkTarget> =>
  new Map(
    f.links.map((l) => [
      l.ordinal,
      {
        ordinal: l.ordinal,
        href: l.href,
        targetFragment: l.target_fragment,
        targetActId: l.target_page_id === null ? null : actOf(l.target_page_id),
        targetFormId: null,
      },
    ])
  );

const stripAsset = (b: TldfBlock): unknown => {
  const { asset, children, ...rest } = b;
  void asset;
  return { ...rest, children: (children ?? []).map(stripAsset) };
};

describe('tldf-unit → TLDF 1.1 on real units', () => {
  for (const id of ['8154', '8851', '146017']) {
    it(`${id}: folds to the parsed text and keeps the compiler's blocks and marks`, () => {
      const f = fixture(id);
      expect(sha(f.text)).toBe(f.textSha256);
      const payloads = convertUnitRender(
        { ...HEAD, textSha256: f.unit.text_sha256 },
        {
          renderState: 'structured',
          chunks: f.render.map((r) => ({
            chunkSeq: r.chunk_seq,
            charStart: r.char_start,
            charEnd: r.char_end,
            body: r.body,
          })),
          links: links(f, (page) => `9${page}`),
          assetSha256: new Map(f.assets.map((a) => [a.ordinal, 'c'.repeat(64)])),
        }
      )._unsafeUnwrap().payloads;
      const envelope = reassembleTldf(asRows(payloads))._unsafeUnwrap();
      expect(provenFold(envelope)._unsafeUnwrap()).toBe(f.text);
      expect(envelope.format_version).toBe('1.1');
      expect(envelope.shape).toBe(f.reference.shape);
      expect(envelope.contains_non_bmp).toBe(f.reference.contains_non_bmp);
      // The blocks are the old compiler's, apart from the image description.
      expect(envelope.blocks.map(stripAsset)).toEqual(f.reference.blocks.map(stripAsset));
      // Every mark is the old compiler's, and every link kind is re-derived.
      expect(envelope.marks.map((m) => [m.ordinal, m.kind, m.span])).toEqual(
        f.reference.marks.map((m) => [m.ordinal, m.kind, m.span])
      );
      for (const [i, mark] of envelope.marks.entries()) {
        expect(mark.link?.kind).toBe(f.reference.marks[i]?.link?.kind);
        if (mark.link?.kind === 'act') expect(typeof mark.link.target_act_id).toBe('number');
      }
      // Separator and run counts are recomputed from the served blocks.
      const runChars = f.text.length - envelope.accounting.separator_chars;
      expect(envelope.accounting.emitted_chars).toBe(runChars);
      expect(envelope.accounting.excluded_by_reason).toEqual({});
    });
  }

  it('146017: an image keeps its dimensions and takes the custody hash', () => {
    const f = fixture('146017');
    const payloads = convertUnitRender(
      { ...HEAD, textSha256: f.textSha256 },
      {
        renderState: 'structured',
        chunks: f.render.map((r) => ({
          chunkSeq: r.chunk_seq,
          charStart: r.char_start,
          charEnd: r.char_end,
          body: r.body,
        })),
        links: new Map(),
        assetSha256: new Map([[0, 'c'.repeat(64)]]),
      }
    )._unsafeUnwrap().payloads;
    const first = payloads[0];
    const images: TldfBlock[] = [];
    const walk = (bs: readonly TldfBlock[]): void => {
      for (const b of bs) {
        if (b.kind === 'imagine') images.push(b);
        walk(b.children ?? []);
      }
    };
    if (first?.kind === 'envelope') walk(first.tldf.blocks);
    expect(images).toHaveLength(1);
    expect(images[0]?.asset?.sha256).toBe('c'.repeat(64));
    expect(JSON.stringify(images[0])).not.toContain('asset_ordinal');
  });

  it('serves a manifest and chunk groups for a multi-chunk unit, pinned to one generation', () => {
    const f = fixture('8154');
    // Split the stored unit as the compiler would: whole top-level blocks.
    // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
    const body = JSON.parse(f.render[0]?.body ?? '{}') as {
      blocks: { span: [number, number] }[];
      marks: { span: [number, number] }[];
    };
    const half = Math.floor(body.blocks.length / 2);
    const cut = body.blocks[half]?.span[0] ?? 0;
    // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
    const head = JSON.parse(f.render[0]?.body ?? '{}') as Record<string, unknown>;
    const chunk0 = JSON.stringify({
      ...head,
      blocks: body.blocks.slice(0, half),
      marks: body.marks.filter((m) => m.span[0] < cut),
    });
    const chunk1 = JSON.stringify({
      blocks: body.blocks.slice(half),
      marks: body.marks.filter((m) => m.span[0] >= cut),
    });
    const payloads = convertUnitRender(
      { ...HEAD, textSha256: f.textSha256 },
      {
        renderState: 'structured',
        chunks: [
          { chunkSeq: 1, charStart: cut, charEnd: f.text.length, body: chunk1 },
          { chunkSeq: 0, charStart: 0, charEnd: cut, body: chunk0 },
        ],
        links: links(f, () => '5'),
        assetSha256: new Map(),
      }
    )._unsafeUnwrap().payloads;
    expect(payloads.map((p) => p.kind)).toEqual(['manifest', 'chunk', 'chunk']);
    expect(payloads).toHaveLength(v2PhysicalChunkCount(2));
    const manifest = payloads[0];
    if (manifest?.kind !== 'manifest') throw new Error('manifest expected');
    // The manifest carries every mark of the unit, like the old format.
    expect(manifest.tldf.marks).toHaveLength(body.marks.length);
    const envelope = reassembleTldf(asRows(payloads))._unsafeUnwrap();
    expect(provenFold(envelope)._unsafeUnwrap()).toBe(f.text);
  });
});

describe('text-only units', () => {
  const text = 'Primul rând\nal doilea 𝔄 rând\n\nultimul';

  it('folds one paragraf per line back to exactly the text', () => {
    const blocks = textOnlyBlocks(text);
    expect(blocks.map((b) => b.id)).toEqual([
      'unmarked:0',
      'unmarked:1',
      'unmarked:2',
      'unmarked:3',
    ]);
    const payloads = convertUnitRender(
      { ...HEAD, compilerVersion: 'text-only', textSha256: sha(text) },
      {
        renderState: 'text_only',
        chunks: [{ chunkSeq: 0, charStart: 0, charEnd: text.length, body: text }],
        links: new Map(),
        assetSha256: new Map(),
      }
    )._unsafeUnwrap().payloads;
    const envelope = reassembleTldf(asRows(payloads))._unsafeUnwrap();
    expect(provenFold(envelope)._unsafeUnwrap()).toBe(text);
    expect(envelope.shape).toBe('paragraph_stream');
    expect(envelope.contains_non_bmp).toBe(true);
  });

  it('keeps the fold exact when a stored chunk cuts a line', () => {
    const cut = 7; // inside "Primul rând"
    const payloads = convertUnitRender(
      { ...HEAD, compilerVersion: 'text-only', textSha256: sha(text) },
      {
        renderState: 'text_only',
        chunks: [
          { chunkSeq: 0, charStart: 0, charEnd: cut, body: text.slice(0, cut) },
          { chunkSeq: 1, charStart: cut, charEnd: text.length, body: text.slice(cut) },
        ],
        links: new Map(),
        assetSha256: new Map(),
      }
    )._unsafeUnwrap().payloads;
    expect(payloads).toHaveLength(3);
    const envelope = reassembleTldf(asRows(payloads))._unsafeUnwrap();
    expect(provenFold(envelope)._unsafeUnwrap()).toBe(text);
    // Block ids stay unique across chunks.
    expect(new Set(envelope.blocks.map((b) => b.id)).size).toBe(envelope.blocks.length);
  });
});

describe('links resolved at read time', () => {
  it("classifies hrefs exactly as the structure parser's classifier", () => {
    expect(
      linkKindFromHref('https://legislatie.just.ro/Public/DetaliiDocumentAfis/123#id_art5')
    ).toBe('act');
    expect(linkKindFromHref('/Public/DetaliiDocument/77')).toBe('act');
    expect(linkKindFromHref('https://legislatie.just.ro/Public/DetaliiDocumentAfis/')).toBe(
      'act_missing_id'
    );
    expect(linkKindFromHref('#id_art5')).toBe('internal');
    expect(linkKindFromHref('https://example.org/x')).toBe('external');
    expect(linkKindFromHref('mailto:a@b.ro')).toBe('external');
    expect(linkKindFromHref('javascript:void(0)')).toBe('other');
  });

  const row = (over: Partial<V2LinkTarget>): V2LinkTarget => ({
    ordinal: 0,
    href: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/123#id_art5',
    targetFragment: 'id_art5',
    targetActId: '555',
    targetFormId: '9',
    ...over,
  });

  it('links an act only when its target act is public (the read joins public rows only)', () => {
    expect(toTldfLink(row({}))).toEqual({
      kind: 'act',
      target_act_id: 555,
      target_document_id: 'f9',
      target_fragment: 'id_art5',
      href: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/123#id_art5',
    });
    // A restricted or unknown target answers no act id: the reader shows a
    // plain reference, never a link to it.
    const unresolved = toTldfLink(row({ targetActId: null, targetFormId: null }));
    expect(unresolved).toEqual({
      kind: 'act',
      target_fragment: 'id_art5',
      href: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/123#id_art5',
    });
    expect(unresolved).not.toHaveProperty('target_act_id');
  });

  it('drops a link the compiler would never serve', () => {
    expect(toTldfLink(row({ href: 'javascript:alert(1)' }))).toBeNull();
    expect(toTldfLink(row({ href: null }))).toBeNull();
  });
});

describe('unsafe hrefs (security review 2026-11-20)', () => {
  const target = (href: string): V2LinkTarget => ({
    ordinal: 0,
    href,
    targetFragment: null,
    targetActId: '555',
    targetFormId: null,
  });

  it('never classes a non-web scheme as a link, whatever path it carries', () => {
    for (const href of [
      'javascript:alert(1)//https://legislatie.just.ro/Public/DetaliiDocument/1',
      'javascript:/Public/DetaliiDocument/1',
      'java\tscript:/Public/DetaliiDocumentAfis/1',
      ' javascript:void(0)//DetaliiDocumentAfis/1',
      'data:text/html,<script>alert(1)</script>/Public/DetaliiDocument/1',
      'vbscript:msgbox(1)/Public/DetaliiDocumentAfis/2',
      'https://evil.example/Public/DetaliiDocumentAfis/3x',
    ]) {
      const link = toTldfLink(target(href));
      if (link === null) continue;
      // Anything served is an external http(s) link or carries no href at all.
      expect(link.kind === 'external' ? link.href : (link.href ?? null)).not.toMatch(
        /^\s*(?:java|vb)script:|^\s*data:/iu
      );
    }
    expect(linkKindFromHref('javascript:alert(1)//DetaliiDocument/1')).toBe('other');
    expect(linkKindFromHref('data:text/html,DetaliiDocument/1')).toBe('other');
    expect(linkKindFromHref('vbscript:x/Public/DetaliiDocument/1')).toBe('other');
    expect(linkKindFromHref('java\tscript:/Public/DetaliiDocument/1')).toBe('other');
    expect(linkKindFromHref('https://evil.example/Public/DetaliiDocumentAfis/3')).toBe('external');
  });

  it('serves a relative Portal link as an act link with a rebuilt Portal href', () => {
    expect(linkKindFromHref('~/../../../Public/DetaliiDocumentAfis/7919')).toBe('act');
    expect(linkKindFromHref('../Public/DetaliiDocument/5')).toBe('act');
    const link = toTldfLink({
      ...target('~/../../../Public/DetaliiDocumentAfis/4181#id_artA96'),
      targetFragment: 'id_artA96',
    });
    expect(link).toEqual({
      kind: 'act',
      target_act_id: 555,
      target_fragment: 'id_artA96',
      href: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/4181#id_artA96',
    });
  });

  it('drops a fragment that is not an id, and keeps internal links to their fragment', () => {
    const odd = toTldfLink({ ...target('#x"><img src=x onerror=1>'), targetFragment: 'x"><img' });
    expect(odd).toEqual({ kind: 'internal' });
    expect(toTldfLink({ ...target('#id_art5'), targetFragment: 'id_art5' })).toEqual({
      kind: 'internal',
      href: '#id_art5',
      target_fragment: 'id_art5',
    });
  });
});
