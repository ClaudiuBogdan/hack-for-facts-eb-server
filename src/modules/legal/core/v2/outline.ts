/**
 * The legal_v2 outline (pure): `unit_provisions` of the form's text units,
 * composed into one document by per-unit offsets, each provision given the id
 * of the render block it is.
 *
 * The client scrolls to `tldf-{path}`, the block's DOM id, so `path` must BE a
 * render block id. `unit_provisions` keeps no block id, but the TLDF compiler
 * refuses any block whose hull differs from its parser node's span
 * (tldf/compile.ts:525) and the unit compiler writes a provision's span from
 * the same node (addresses.ts:1086), so a provision and its block share their
 * exact span; on the compiler's real fixtures every provision matched exactly
 * one block of its span and kind (2026-11-20). Where several blocks share a
 * span the one with the provision's source element id, then its kind, then
 * the outermost is taken. A provision with no block of its span keeps a
 * non-DOM key `prov:<component>:<seq>` (exact match only on the client).
 *
 * A form of several units prefixes block ids with `u<ordinal>.`; a form of one
 * unit keeps the stored ids, which are the ids the render serves.
 */

import { outlineDepthFor } from '../outline.js';

import type { LegalOutlineEntry } from '../types.js';

/** Provision kind word → the outline's grammar type code. */
const KIND_TO_TYPE: Readonly<Record<string, string>> = {
  carte: 'CRT',
  parte: 'PRT',
  titlu: 'TTL',
  capitol: 'CAP',
  subcapitol: 'SBC',
  sectiune: 'SEC',
  articol: 'ART',
  anexa: 'ANX',
  apendice: 'APN',
};

/**
 * A provision's `kind` is the parser node's kind word, or its type code when
 * the node has no kind (addresses.ts: `node.kind ?? node.type`); both map.
 */
export const outlineTypeOfKind = (kind: string): string | null => {
  if (Object.hasOwn(KIND_TO_TYPE, kind)) return KIND_TO_TYPE[kind] ?? null;
  return Object.values(KIND_TO_TYPE).includes(kind) ? kind : null;
};

export interface V2ProvisionRow {
  readonly provisionSeq: number;
  readonly kind: string;
  readonly citationPath: string | null;
  readonly address: string | null;
  readonly addressState: string;
  readonly labelRaw: string | null;
  readonly sourceElementId: string | null;
  readonly charStart: number;
  readonly charEnd: number;
}

export interface V2BlockRef {
  readonly id: string;
  readonly kind: string;
  readonly span: readonly [number, number];
  readonly sourceElementId?: string;
}

export interface V2OutlineUnit {
  readonly componentOrdinal: number;
  /** UTF-16 length of the unit's text (its last render chunk's end). */
  readonly textLength: number;
  readonly provisions: readonly V2ProvisionRow[];
  /** Every block of the unit's render, parents before children. */
  readonly blocks: readonly V2BlockRef[];
}

/**
 * The number from the PARSER's address only. Where the parser withheld the
 * address, the number stays null even when the older compiler rule wrote a
 * citation path: that path is not the authoritative numbering.
 */
const numberKeyOf = (p: V2ProvisionRow): string | null => {
  const path = p.address;
  if (path === null) return null;
  const last = path.split('/').pop() ?? '';
  const colon = last.indexOf(':');
  const key = colon === -1 ? last : last.slice(colon + 1);
  return key === '' ? null : key;
};

/** Without a parser address a number is never "parsed": ambiguous, or unstated. */
const numberStatusOf = (state: string): string | null =>
  state === 'ambiguous' ? 'ambiguous' : null;

/** Collect a block tree into `V2BlockRef`s, parents before children. */
export const flattenBlocks = (blocks: readonly unknown[]): V2BlockRef[] => {
  const out: V2BlockRef[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue;
      const b = raw as {
        id?: unknown;
        kind?: unknown;
        span?: unknown;
        source_element_id?: unknown;
        children?: unknown;
      };
      if (
        typeof b.id === 'string' &&
        typeof b.kind === 'string' &&
        Array.isArray(b.span) &&
        typeof b.span[0] === 'number' &&
        typeof b.span[1] === 'number'
      ) {
        out.push({
          id: b.id,
          kind: b.kind,
          span: [b.span[0], b.span[1]],
          ...(typeof b.source_element_id === 'string' && { sourceElementId: b.source_element_id }),
        });
      }
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
};

/**
 * Every provision of the form, in document order, as outline entries. The
 * caller filters to headings within the requested depth (`depth !== null`).
 */
export const composeV2Outline = (
  documentId: string,
  units: readonly V2OutlineUnit[]
): LegalOutlineEntry[] => {
  const ordered = [...units].sort((a, b) => a.componentOrdinal - b.componentOrdinal);
  const prefix = ordered.length > 1;
  const entries: LegalOutlineEntry[] = [];
  let offset = 0;
  for (const unit of ordered) {
    const bySpan = new Map<string, V2BlockRef[]>();
    for (const block of unit.blocks) {
      const key = `${String(block.span[0])}:${String(block.span[1])}`;
      const list = bySpan.get(key);
      if (list === undefined) bySpan.set(key, [block]);
      else list.push(block);
    }
    const provisions = [...unit.provisions].sort((a, b) =>
      a.charStart !== b.charStart ? a.charStart - b.charStart : a.provisionSeq - b.provisionSeq
    );
    for (const p of provisions) {
      const candidates = bySpan.get(`${String(p.charStart)}:${String(p.charEnd)}`) ?? [];
      const block =
        (p.sourceElementId !== null
          ? candidates.find((b) => b.sourceElementId === p.sourceElementId)
          : undefined) ??
        candidates.find((b) => b.kind === p.kind) ??
        candidates[0];
      const path =
        block === undefined
          ? `prov:${String(unit.componentOrdinal)}:${String(p.provisionSeq)}`
          : prefix
            ? `u${String(unit.componentOrdinal)}.${block.id}`
            : block.id;
      const type = outlineTypeOfKind(p.kind);
      entries.push({
        documentId,
        path,
        nodeKind: p.kind,
        label: p.labelRaw,
        numberKey: numberKeyOf(p),
        numberSystem: null,
        numberStatus: p.address !== null ? 'parsed' : numberStatusOf(p.addressState),
        depth: outlineDepthFor(type),
        orderIndex: entries.length,
        charStart: p.charStart + offset,
        charEnd: p.charEnd + offset,
      });
    }
    offset += unit.textLength;
  }
  return entries;
};
