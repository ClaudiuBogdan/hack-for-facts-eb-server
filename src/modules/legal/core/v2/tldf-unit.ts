/**
 * legal_v2 `tldf-unit` v1 → the reader's TLDF 1.1 physical payloads (pure).
 *
 * What a legal_v2 text unit stores (unit-compiler/compile-unit.ts in the data
 * repo): render chunks whose body is `{format:'tldf-unit', format_version:'1',
 * offset_unit, contains_non_bmp, shape, blocks, marks}` on chunk 0 and
 * `{blocks, marks}` after it. The blocks ARE the TLDF 1.1 compiler's blocks,
 * byte-equal apart from images (checked on the compiler's three real fixtures,
 * 2026-11-20), with three changes this module undoes at read time:
 *
 * 1. A link mark carries only `link_ordinal`, the `unit_links` row of the
 *    occurrence. Its kind is re-derived from the href with the structure
 *    parser's classes, the Portal patterns ANCHORED and every scheme but http,
 *    https and mailto refused. The target act and form are joined at read time
 *    from public rows (`V2LinkTarget`); a link whose target act is not public
 *    is served as a reference with no locator at all.
 * 2. An image block names its `unit_assets` row (`asset_ordinal`). A public
 *    occurrence keeps its dimensions and alt text and takes the custody hash;
 *    a restricted one keeps the zero-character block and nothing else.
 * 3. The envelope head is not stored. It is rebuilt from the unit and form
 *    rows with named substitutions (`V2_HEAD_SUBSTITUTIONS`).
 *
 * Every stored chunk is validated (TypeBox) before use and the output is BUILT
 * from an allowlist of fields, never spread from storage, so nothing the
 * stored row carries beyond the TLDF 1.1 contract can reach a reader.
 *
 * A `text_only` unit is plain text, served as a `paragraph_stream` of one
 * `paragraf` block per line whose fold is exactly the text.
 *
 * Each request converts only what it serves: the single envelope, the
 * manifest (which needs every chunk for its index and marks), or one chunk.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, fromThrowable, ok, type Result } from 'neverthrow';

import {
  TLDF_KIND_VALUES,
  type TldfAsset,
  type TldfBlock,
  type TldfChunkIndexEntry,
  type TldfChunkPayload,
  type TldfEnvelope,
  type TldfLink,
  type TldfManifestPayload,
  type TldfMark,
  type TldfMarkKind,
  type TldfRun,
  type TldfShape,
} from '../tldf/types.js';

/** What the response's meta names as the source of a v2 render. */
export const V2_RENDER_SOURCE = 'legal_v2:tldf-unit/1';

/**
 * The head fields serving does not hold, and what stands in for them. Served
 * verbatim as `meta.renderHead` so no consumer mistakes a substitute for the
 * old compiler's value (versioned: bump on any change).
 */
export const V2_HEAD_SUBSTITUTIONS = {
  version: 1,
  'generation.run_id': 'form_current.receipt_id (the generation pin), not a structure run id',
  'generation.structure_parser_version':
    'text_units.parse_build_id, not a structure parser version',
  'accounting.emitted_chars': 'recomputed from the served blocks',
  'accounting.separator_chars': 'recomputed from the served blocks',
  'accounting.excluded_by_reason': 'not held in serving (raw keeps it); served empty',
  defects: 'not held in serving (raw keeps them); omitted',
} as const;

// ── stored-chunk contract (validated before any use) ─────────────────────────

const Span = Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })]);
const Lit = (values: readonly string[]): TSchema => Type.Union(values.map((v) => Type.Literal(v)));

const StoredRun = Type.Object({
  text: Type.String(),
  span: Span,
  role: Type.Optional(Lit(['ttl', 'den', 'bdy'])),
  sep: Type.Optional(Lit(['\n', ' '])),
  struck: Type.Optional(Lit(['partial', 'full'])),
});

const StoredBlock = Type.Recursive((self) =>
  Type.Object({
    id: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Lit(TLDF_KIND_VALUES),
    type: Type.String({ maxLength: 16 }),
    span: Span,
    content: Type.Array(StoredRun),
    children: Type.Optional(Type.Array(self)),
    source_element_id: Type.Optional(Type.String({ maxLength: 512 })),
    label: Type.Optional(Type.String()),
    number: Type.Optional(
      Type.Union([Type.Null(), Type.Object({ key: Type.String(), system: Type.String() })])
    ),
    origin: Type.Optional(Lit(['unmarked', 'facsimil'])),
    placement: Type.Optional(Type.Literal('positional')),
    grid: Type.Optional(
      Type.Object({
        cols: Type.Integer({ minimum: 1, maximum: 32767 }),
        rows: Type.Integer({ minimum: 1, maximum: 32767 }),
      })
    ),
    asset: Type.Optional(
      Type.Object({
        asset_ordinal: Type.Integer({ minimum: 0 }),
        width: Type.Optional(Type.Integer()),
        height: Type.Optional(Type.Integer()),
        alt: Type.Optional(Type.String()),
      })
    ),
    struck: Type.Optional(Lit(['partial', 'full'])),
    struck_repealed: Type.Optional(Type.Literal(true)),
    annotation_role: Type.Optional(Type.Literal('amendment_note')),
    changed_since_base_form: Type.Optional(Type.Boolean()),
  })
);

const MARK_KINDS: readonly TldfMarkKind[] = [
  'reference',
  'legal_ref',
  'ref',
  'italic',
  'underline',
  'bold',
  'struck',
];
const StoredMark = Type.Object({
  ordinal: Type.Integer({ minimum: 0 }),
  kind: Lit(MARK_KINDS),
  span: Span,
  link_ordinal: Type.Optional(Type.Integer({ minimum: 0 })),
});

const StoredChunkBody = Type.Object({
  blocks: Type.Array(StoredBlock),
  marks: Type.Array(StoredMark),
});
const StoredHead = Type.Object({
  format: Type.Literal('tldf-unit'),
  format_version: Type.Literal('1'),
  offset_unit: Type.Literal('utf16_code_unit'),
  contains_non_bmp: Type.Boolean(),
  shape: Lit(['standard_articles', 'paragraph_stream', 'facsimile']),
});

interface StoredRunT {
  readonly text: string;
  readonly span: readonly [number, number];
  readonly role?: string;
  readonly sep?: string;
  readonly struck?: string;
}
interface StoredBlockT {
  readonly id: string;
  readonly kind: string;
  readonly type: string;
  readonly span: readonly [number, number];
  readonly content: readonly StoredRunT[];
  readonly children?: readonly StoredBlockT[];
  readonly source_element_id?: string;
  readonly label?: string;
  readonly number?: { readonly key: string; readonly system: string } | null;
  readonly origin?: string;
  readonly placement?: 'positional';
  readonly grid?: { readonly cols: number; readonly rows: number };
  readonly asset?: {
    readonly asset_ordinal: number;
    readonly width?: number;
    readonly height?: number;
    readonly alt?: string;
  };
  readonly struck?: string;
  readonly struck_repealed?: true;
  readonly annotation_role?: 'amendment_note';
  readonly changed_since_base_form?: boolean;
}
interface StoredMarkT {
  readonly ordinal: number;
  readonly kind: string;
  readonly span: readonly [number, number];
  readonly link_ordinal?: number;
}
interface StoredHeadT {
  readonly contains_non_bmp: boolean;
  readonly shape: string;
}

const parseJson = fromThrowable(JSON.parse as (text: string) => unknown);

// ── links ───────────────────────────────────────────────────────────────────────

/**
 * A Portal act page as the corpus writes it: relative (`~/../../Public/...`,
 * `/Public/...`, `../Public/...`) or absolute on legislatie.just.ro. ANCHORED,
 * unlike the structure parser's ACT_LINK_RE (structure-parser.ts:1704). Groups:
 * the route, the page id, the query, the fragment.
 */
const PORTAL_PREFIX = String.raw`^(?:~|https?:\/\/(?:www\.)?legislatie\.just\.ro)?(?:\/?\.\.)*\/?Public\/`;
const ACT_LINK_RE = new RegExp(
  String.raw`${PORTAL_PREFIX}(DetaliiDocument(?:Afis)?)\/(\d{1,18})(\?[^#]*)?(?:#(.*))?$`,
  'iu'
);
const ACT_LINK_NO_ID_RE = new RegExp(
  String.raw`${PORTAL_PREFIX}DetaliiDocument(?:Afis)?\/(?:[?#].*)?$`,
  'iu'
);
/** The schemes a served href may carry (the compiler's isUnsafeTldfLink). */
const SAFE_SCHEME_RE = /^(?:https?|mailto):/iu;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
/** A fragment as served: the id characters the Portal uses, nothing else. */
const FRAGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/u;
/** A Portal query as served (`?isFormaDeBaza=true`); anything else is refused. */
const QUERY_RE = /^\?[A-Za-z0-9=&_.-]{0,256}$/u;

/** ASCII whitespace and control characters, which browsers drop inside a scheme. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_RE = /[\u0000- \u007f]/gu;

/** C0 controls and DEL (not the space), dropped from a served external href. */
// eslint-disable-next-line no-control-regex -- dropping control characters is the point
const C0_RE = /[\u0000-\u001f\u007f]/gu;

export type V2LinkKind = 'act' | 'act_missing_id' | 'internal' | 'external' | 'other';

/** The link kind of an href; any scheme but http, https and mailto is `other`. */
export const linkKindFromHref = (href: string): V2LinkKind => {
  const bare = href.replace(CONTROL_RE, '');
  if (ANY_SCHEME_RE.test(bare) && !SAFE_SCHEME_RE.test(bare)) return 'other';
  if (ACT_LINK_RE.test(bare)) return 'act';
  if (ACT_LINK_NO_ID_RE.test(bare)) return 'act_missing_id';
  if (bare.startsWith('#')) return 'internal';
  if (SAFE_SCHEME_RE.test(bare)) return 'external';
  return 'other';
};

/** One public `unit_links` occurrence with its read-time target. */
export interface V2LinkTarget {
  readonly ordinal: number;
  readonly href: string | null;
  readonly targetFragment: string | null;
  /** `page_acts.act_id` of the target page, only when that act is public. */
  readonly targetActId: string | null;
  /** The form the newest capture of the linked route is bound to (public). */
  readonly targetFormId: string | null;
}

const fragmentOf = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && FRAGMENT_RE.test(value) ? value : null;

/**
 * The TLDF link a mark carries, or null when the occurrence is not servable.
 * A Portal link keeps its validated route, page id and query, rebuilt on the
 * Portal host; an act link whose target act is not public keeps NO locator
 * (no href, no fragment, no document id). Only an external link keeps its href
 * as written.
 */
export const toTldfLink = (row: V2LinkTarget): TldfLink | null => {
  const href = row.href;
  if (href === null || href === '') return null;
  const bare = href.replace(CONTROL_RE, '');
  switch (linkKindFromHref(href)) {
    case 'act': {
      const actId = row.targetActId === null ? null : Number(row.targetActId);
      if (actId === null || !Number.isSafeInteger(actId)) return { kind: 'act' };
      const m = ACT_LINK_RE.exec(bare);
      const route = m?.[1];
      const page = m?.[2];
      const query = m?.[3];
      const fragment = fragmentOf(row.targetFragment ?? m?.[4]);
      const queryOk = query === undefined || QUERY_RE.test(query);
      const fragmentPart = fragment === null ? '' : `#${fragment}`;
      return {
        kind: 'act',
        target_act_id: actId,
        ...(row.targetFormId !== null && { target_document_id: `f${row.targetFormId}` }),
        ...(fragment !== null && { target_fragment: fragment }),
        ...(route !== undefined &&
          page !== undefined &&
          queryOk && {
            href: `https://legislatie.just.ro/Public/${route}/${page}${query ?? ''}${fragmentPart}`,
          }),
      };
    }
    case 'act_missing_id':
      return { kind: 'act_missing_id' };
    case 'internal': {
      const fragment = fragmentOf(row.targetFragment);
      return fragment === null
        ? { kind: 'internal' }
        : { kind: 'internal', href: `#${fragment}`, target_fragment: fragment };
    }
    case 'external': {
      // The scheme was judged on the stripped form; the served href keeps the
      // link as written, control characters dropped and spaces percent-encoded
      // (`Anexa 1.pdf` stays a file named with a space).
      const served = href.trim().replace(C0_RE, '').replace(/ /gu, '%20');
      return SAFE_SCHEME_RE.test(served) ? { kind: 'external', href: served } : null;
    }
    case 'other':
      return null;
  }
};

// ── conversion ──────────────────────────────────────────────────────────────────

export interface V2UnitChunk {
  readonly chunkSeq: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** As stored, or null when this request did not read it. */
  readonly body: string | null;
}

export interface V2RenderHeadInput {
  /** `f<form_id>`. */
  readonly documentId: string;
  /** The generation pin: the form's `form_current.receipt_id`. */
  readonly runId: number;
  readonly compilerVersion: string;
  readonly textSha256: string;
  readonly bodySha256: string;
  readonly parseBuildId: string;
  readonly contentParserVersion: string;
  readonly sourceUrl: string;
}

export interface V2UnitRenderInput {
  readonly renderState: 'structured' | 'text_only';
  /** Every stored chunk of the unit, in any order; bodies as the request read them. */
  readonly chunks: readonly V2UnitChunk[];
  /** Public link occurrences by ordinal (needed only for the envelope or manifest). */
  readonly links: ReadonlyMap<number, V2LinkTarget>;
  /** Public image occurrences: ordinal → custody hash (null when raw lacks the bytes). */
  readonly publicAssets: ReadonlyMap<number, string | null>;
}

export type V2PhysicalPayload =
  | { readonly kind: 'envelope'; readonly tldf: TldfEnvelope }
  | { readonly kind: 'manifest'; readonly tldf: TldfManifestPayload }
  | { readonly kind: 'chunk'; readonly tldf: TldfChunkPayload };

/** The physical payload count of a unit with `storedChunks` render chunks. */
export const v2PhysicalChunkCount = (storedChunks: number): number =>
  storedChunks <= 1 ? 1 : storedChunks + 1;

/** Which stored chunks a request for physical index `wanted` must read. */
export const storedChunksNeeded = (storedChunks: number, wanted: number): number[] => {
  if (storedChunks <= 1) return wanted === 0 ? [0] : [];
  if (wanted === 0) return Array.from({ length: storedChunks }, (_, i) => i);
  return wanted <= storedChunks ? [wanted - 1] : [];
};

const buildRun = (r: StoredRunT): TldfRun => ({
  text: r.text,
  span: [r.span[0], r.span[1]],
  ...(r.role !== undefined && { role: r.role as NonNullable<TldfRun['role']> }),
  ...(r.sep !== undefined && { sep: r.sep as NonNullable<TldfRun['sep']> }),
  ...(r.struck !== undefined && { struck: r.struck as NonNullable<TldfRun['struck']> }),
});

/** A TLDF block built field by field from a validated stored block. */
const buildBlock = (b: StoredBlockT, assets: ReadonlyMap<number, string | null>): TldfBlock => {
  let asset: TldfAsset | undefined;
  if (b.asset !== undefined && assets.has(b.asset.asset_ordinal)) {
    const sha = assets.get(b.asset.asset_ordinal) ?? null;
    asset = {
      ...(sha !== null && { sha256: sha }),
      ...(b.asset.width !== undefined && { width: b.asset.width }),
      ...(b.asset.height !== undefined && { height: b.asset.height }),
      ...(b.asset.alt !== undefined && { alt: b.asset.alt }),
    };
  }
  return {
    id: b.id,
    kind: b.kind as TldfBlock['kind'],
    type: b.type,
    span: [b.span[0], b.span[1]],
    ...(b.source_element_id !== undefined && { source_element_id: b.source_element_id }),
    ...(b.label !== undefined && { label: b.label }),
    ...(b.number !== undefined && {
      number: b.number === null ? null : { key: b.number.key, system: b.number.system },
    }),
    ...(b.origin !== undefined && { origin: b.origin as NonNullable<TldfBlock['origin']> }),
    ...(b.placement !== undefined && { placement: 'positional' as const }),
    ...(b.grid !== undefined && { grid: { cols: b.grid.cols, rows: b.grid.rows } }),
    ...(asset !== undefined && { asset }),
    ...(b.struck !== undefined && { struck: b.struck as NonNullable<TldfBlock['struck']> }),
    ...(b.struck_repealed !== undefined && { struck_repealed: true as const }),
    ...(b.annotation_role !== undefined && { annotation_role: 'amendment_note' as const }),
    ...(b.changed_since_base_form !== undefined && {
      changed_since_base_form: b.changed_since_base_form,
    }),
    content: b.content.map(buildRun),
    ...(b.children !== undefined && { children: b.children.map((c) => buildBlock(c, assets)) }),
  };
};

/** A TLDF mark built from a validated stored mark; an unresolvable link is dropped. */
const buildMark = (m: StoredMarkT, links: ReadonlyMap<number, V2LinkTarget>): TldfMark => {
  const target = m.link_ordinal === undefined ? undefined : links.get(m.link_ordinal);
  const link = target === undefined ? null : toTldfLink(target);
  return {
    ordinal: m.ordinal,
    kind: m.kind as TldfMarkKind,
    span: [m.span[0], m.span[1]],
    ...(m.kind === 'reference' && link !== null && { link }),
  };
};

/**
 * One paragraf block per line of ONE stored text-only chunk, the fold exactly
 * the chunk's text: each line after the chunk's first carries its `\n` as the
 * run separator; a line cut by the stored chunk boundary continues in the next
 * chunk's first block without one. Ids are `unmarked:<chunk * 65536 + line>`
 * (a stored chunk holds at most 32,768 UTF-16 units), so a chunk's ids need no
 * other chunk.
 */
export const textOnlyBlocks = (text: string, charStart = 0, chunkSeq = 0): TldfBlock[] => {
  const blocks: TldfBlock[] = [];
  let offset = charStart;
  for (const [i, line] of text.split('\n').entries()) {
    if (i > 0) offset += 1;
    const span = [offset, offset + line.length] as const;
    const run: TldfRun = { text: line, span, ...(i > 0 && { sep: '\n' as const }) };
    blocks.push({
      id: `unmarked:${String(chunkSeq * 65_536 + i)}`,
      kind: 'paragraf',
      type: 'PAR',
      span,
      content: [run],
    });
    offset += line.length;
  }
  return blocks;
};

interface ParsedChunk {
  readonly head: StoredHeadT | null;
  readonly blocks: TldfBlock[];
  readonly marks: TldfMark[];
}

const parseChunk = (
  unit: V2UnitRenderInput,
  chunk: V2UnitChunk,
  withMarks: boolean
): Result<ParsedChunk, string> => {
  const seq = String(chunk.chunkSeq);
  if (chunk.body === null) return err(`chunk ${seq} was not read`);
  if (unit.renderState === 'text_only') {
    return ok({
      head: null,
      blocks: textOnlyBlocks(chunk.body, chunk.charStart, chunk.chunkSeq),
      marks: [],
    });
  }
  const parsed = parseJson(chunk.body);
  if (parsed.isErr()) return err(`chunk ${seq} is not JSON`);
  if (!Value.Check(StoredChunkBody, parsed.value)) {
    return err(`chunk ${seq} breaks the tldf-unit contract`);
  }
  const body = parsed.value as unknown as {
    readonly blocks: readonly StoredBlockT[];
    readonly marks: readonly StoredMarkT[];
  };
  let head: StoredHeadT | null = null;
  if (chunk.chunkSeq === 0) {
    if (!Value.Check(StoredHead, parsed.value)) return err('chunk 0 carries no tldf-unit/1 head');
    head = parsed.value as unknown as Static<typeof StoredHead> & StoredHeadT;
  }
  return ok({
    head,
    blocks: body.blocks.map((b) => buildBlock(b, unit.publicAssets)),
    marks: withMarks ? body.marks.map((m) => buildMark(m, unit.links)) : [],
  });
};

const runChars = (blocks: readonly TldfBlock[]): { emitted: number; separators: number } => {
  let emitted = 0;
  let separators = 0;
  const walk = (list: readonly TldfBlock[]): void => {
    for (const block of list) {
      for (const run of block.content) {
        emitted += run.text.length;
        separators += run.sep?.length ?? 0;
      }
      walk(block.children ?? []);
    }
  };
  walk(blocks);
  return { emitted, separators };
};

const NON_BMP_RE = /[\u{10000}-\u{10FFFF}]/u;

/**
 * The ONE physical payload the request names: the envelope (a single stored
 * chunk), the manifest (index 0 of several; reads every chunk), or chunk group
 * `wanted` (reads only stored chunk `wanted - 1`). `not_found` when there is no
 * such index; any other error is a malformed stored row.
 */
export const convertUnitChunk = (
  head: V2RenderHeadInput,
  unit: V2UnitRenderInput,
  wanted: number
): Result<V2PhysicalPayload, string> => {
  const chunks = [...unit.chunks].sort((a, b) => a.chunkSeq - b.chunkSeq);
  const n = chunks.length;
  if (n === 0) return err('the unit has no render chunks');
  if (wanted < 0 || wanted >= v2PhysicalChunkCount(n)) return err('not_found');
  const generation = {
    run_id: head.runId,
    body_sha256: head.bodySha256,
    structure_parser_version: head.parseBuildId,
    content_parser_version: head.contentParserVersion,
  };

  if (n > 1 && wanted > 0) {
    const chunk = chunks[wanted - 1];
    if (chunk === undefined) return err('not_found');
    const parsed = parseChunk(unit, chunk, false);
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.blocks.length === 0) return err(`chunk ${String(wanted)} holds no blocks`);
    return ok({
      kind: 'chunk',
      tldf: {
        format: 'tldf',
        format_version: '1.1',
        document_id: head.documentId,
        generation,
        privacy_class: 'public',
        text_sha256: head.textSha256,
        physical: 'chunk',
        blocks: parsed.value.blocks,
      },
    });
  }

  // Envelope or manifest: every stored chunk, with marks.
  const groups: TldfBlock[][] = [];
  const marks: TldfMark[] = [];
  let storedHead: StoredHeadT | null = null;
  let nonBmp = false;
  for (const chunk of chunks) {
    const parsed = parseChunk(unit, chunk, true);
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value.head !== null) storedHead = parsed.value.head;
    if (unit.renderState === 'text_only' && NON_BMP_RE.test(chunk.body ?? '')) nonBmp = true;
    groups.push(parsed.value.blocks);
    marks.push(...parsed.value.marks);
  }
  if (unit.renderState === 'structured' && storedHead === null) {
    return err('chunk 0 carries no tldf-unit/1 head');
  }
  marks.sort((a, b) => a.ordinal - b.ordinal);
  const allBlocks = groups.flat();
  const counts = runChars(allBlocks);
  const shape: TldfShape =
    storedHead === null ? 'paragraph_stream' : (storedHead.shape as TldfShape);
  const envelopeHead = {
    format: 'tldf' as const,
    format_version: '1.1' as const,
    compiler_version: head.compilerVersion,
    document_id: head.documentId,
    generation,
    text_sha256: head.textSha256,
    offset_unit: 'utf16_code_unit' as const,
    contains_non_bmp: storedHead === null ? nonBmp : storedHead.contains_non_bmp,
    privacy_class: 'public' as const,
    source_url: head.sourceUrl,
    shape,
    accounting: {
      emitted_chars: counts.emitted,
      separator_chars: counts.separators,
      excluded_by_reason: {},
    },
    marks,
  };
  if (n === 1) return ok({ kind: 'envelope', tldf: { ...envelopeHead, blocks: allBlocks } });

  const index: TldfChunkIndexEntry[] = [];
  for (const [i, blocks] of groups.entries()) {
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    if (first === undefined || last === undefined) {
      return err('a stored chunk of a multi-chunk unit holds no blocks');
    }
    index.push({
      chunk_index: i + 1,
      block_id: first.id,
      block_count: blocks.length,
      span: [first.span[0], last.span[1]],
    });
  }
  return ok({ kind: 'manifest', tldf: { ...envelopeHead, physical: 'manifest', chunks: index } });
};

/** Every physical payload of a unit, in order (tests; the route reads one). */
export const convertWholeUnit = (
  head: V2RenderHeadInput,
  unit: V2UnitRenderInput
): Result<V2PhysicalPayload[], string> => {
  const total = v2PhysicalChunkCount(unit.chunks.length);
  const out: V2PhysicalPayload[] = [];
  for (let i = 0; i < total; i += 1) {
    const p = convertUnitChunk(head, unit, i);
    if (p.isErr()) return err(p.error);
    out.push(p.value);
  }
  return ok(out);
};
