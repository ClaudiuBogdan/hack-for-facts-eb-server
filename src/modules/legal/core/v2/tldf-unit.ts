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
 *    occurrence. The link's KIND is not stored; it is re-derived from the href
 *    as written by the structure parser's classes (act, act_missing_id, `#`,
 *    http/mailto), with the act patterns ANCHORED and every other scheme
 *    refused. The target act and form come from `page_acts` / `page_targets`
 *    at read time (`V2LinkTarget`); only an external link keeps its raw href.
 * 2. An image block names its `unit_assets` row (`asset_ordinal`); the content
 *    hash comes from `asset_custody` when raw holds the bytes.
 * 3. The envelope head is not stored: compiler label, generation, document id,
 *    source URL, privacy class, accounting and defects. The head is rebuilt
 *    from the unit and form rows; the parser's exclusion counts and defect
 *    ledger are NOT held by serving (raw keeps them), so `accounting.
 *    excluded_by_reason` is served empty and `defects` is omitted. The reader
 *    uses neither; `generation.run_id` and `text_sha256` are the chunk pin.
 *
 * A `text_only` unit (no structure compiled) is plain text; it is served as a
 * `paragraph_stream` of one `paragraf` block per line, ids `unmarked:<n>`, whose
 * fold is exactly the text (each line after the first carries its `\n` as the
 * run separator).
 *
 * The fold of what this module emits equals the unit's text: the unit tests
 * prove it with the server's own `reassembleTldf` + `provenFold` gate. A
 * malformed stored chunk is an error (`render_inconsistent` upstream).
 */

import { err, fromThrowable, ok, type Result } from 'neverthrow';

import type {
  TldfBlock,
  TldfChunkIndexEntry,
  TldfChunkPayload,
  TldfEnvelope,
  TldfLink,
  TldfManifestPayload,
  TldfMark,
  TldfRun,
  TldfShape,
} from '../tldf/types.js';

/** Bump when the conversion's output changes: it is part of the v2 ETag. */
export const V2_RENDER_CONVERTER_VERSION = 'v2c1';

/** What the response's meta names as the source of a v2 render. */
export const V2_RENDER_SOURCE = 'legal_v2:tldf-unit/1';

/**
 * A Portal act page as the corpus writes it: relative (`~/../../Public/...`,
 * `/Public/...`, `../Public/...`) or absolute on legislatie.just.ro. ANCHORED,
 * unlike the structure parser's ACT_LINK_RE (structure-parser.ts:1704), so a
 * `javascript:` or `data:` href that merely contains the path is never an act
 * link (security review, 2026-11-20).
 */
const PORTAL_PREFIX = String.raw`^(?:~|https?:\/\/(?:www\.)?legislatie\.just\.ro)?(?:\/?\.\.)*\/?Public\/DetaliiDocument(?:Afis)?\/`;
const ACT_LINK_RE = new RegExp(`${PORTAL_PREFIX}(\\d+)(?:[?#].*)?$`, 'iu');
const ACT_LINK_NO_ID_RE = new RegExp(`${PORTAL_PREFIX}(?:[?#].*)?$`, 'iu');
/** The schemes a served href may carry (the compiler's isUnsafeTldfLink). */
const SAFE_SCHEME_RE = /^(?:https?|mailto):/iu;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/iu;
/** A fragment as served: the id characters the Portal uses, nothing else. */
const FRAGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/u;

export type V2LinkKind = 'act' | 'act_missing_id' | 'internal' | 'external' | 'other';

/**
 * The link kind of an href. Browsers ignore ASCII whitespace and control
 * characters inside a scheme (`java\tscript:`), so those are removed before
 * the scheme is read; any scheme but http, https and mailto is `other`.
 */
export const linkKindFromHref = (href: string): V2LinkKind => {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const bare = href.replace(/[\u0000-\u0020\u007f]/gu, '');
  if (ANY_SCHEME_RE.test(bare) && !SAFE_SCHEME_RE.test(bare)) return 'other';
  if (ACT_LINK_RE.test(bare)) return 'act';
  if (ACT_LINK_NO_ID_RE.test(bare)) return 'act_missing_id';
  if (bare.startsWith('#')) return 'internal';
  if (SAFE_SCHEME_RE.test(bare)) return 'external';
  return 'other';
};

/** One `unit_links` occurrence with its read-time target (public rows only). */
export interface V2LinkTarget {
  readonly ordinal: number;
  readonly href: string | null;
  readonly targetFragment: string | null;
  /** `page_acts.act_id` of the target page, only when that act is public. */
  readonly targetActId: string | null;
  /** The form the newest capture of the linked route is bound to (public). */
  readonly targetFormId: string | null;
}

const PORTAL_AFIS = 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/';

/**
 * The TLDF link a mark carries, or null when the occurrence is not servable.
 * Only an `external` link keeps its raw href (http, https or mailto); a Portal
 * link is rebuilt from its page id, an internal one from its fragment.
 */
export const toTldfLink = (row: V2LinkTarget): TldfLink | null => {
  const href = row.href;
  if (href === null || href === '') return null;
  const kind = linkKindFromHref(href);
  const fragment =
    row.targetFragment !== null && FRAGMENT_RE.test(row.targetFragment) ? row.targetFragment : null;
  switch (kind) {
    case 'act': {
      // eslint-disable-next-line no-control-regex -- same normalisation as the classifier
      const page = ACT_LINK_RE.exec(href.replace(/[\u0000-\u0020\u007f]/gu, ''))?.[1] ?? null;
      const actId = row.targetActId === null ? null : Number(row.targetActId);
      return {
        kind: 'act',
        ...(actId !== null && Number.isSafeInteger(actId) && { target_act_id: actId }),
        ...(row.targetFormId !== null && { target_document_id: `f${row.targetFormId}` }),
        ...(fragment !== null && { target_fragment: fragment }),
        ...(page !== null && {
          href: `${PORTAL_AFIS}${page}${fragment === null ? '' : `#${fragment}`}`,
        }),
      };
    }
    case 'act_missing_id':
      return { kind: 'act_missing_id' };
    case 'internal':
      return fragment === null
        ? { kind: 'internal' }
        : { kind: 'internal', href: `#${fragment}`, target_fragment: fragment };
    case 'external':
      return { kind: 'external', href };
    case 'other':
      // Never a link a reader may follow (the compiler drops these too).
      return null;
  }
};

export interface V2UnitChunk {
  readonly chunkSeq: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** As stored: TLDF-unit JSON text, or plain text for a text-only unit. */
  readonly body: string;
}

export interface V2RenderHeadInput {
  /** `f<form_id>`. */
  readonly documentId: string;
  /** The generation pin: the form's `form_current.receipt_id`. */
  readonly runId: number;
  readonly compilerVersion: string;
  readonly textSha256: string;
  readonly bodySha256: string;
  /** No structure parser version is held in serving; the parse build stands in. */
  readonly parseBuildId: string;
  readonly contentParserVersion: string;
  readonly sourceUrl: string;
}

export interface V2UnitRenderInput {
  readonly renderState: 'structured' | 'text_only';
  readonly chunks: readonly V2UnitChunk[];
  readonly links: ReadonlyMap<number, V2LinkTarget>;
  /** asset ordinal → content sha256 when raw holds the bytes. */
  readonly assetSha256: ReadonlyMap<number, string>;
}

export type V2PhysicalPayload =
  | { readonly kind: 'envelope'; readonly tldf: TldfEnvelope }
  | { readonly kind: 'manifest'; readonly tldf: TldfManifestPayload }
  | { readonly kind: 'chunk'; readonly tldf: TldfChunkPayload };

export interface V2ConvertedRender {
  readonly payloads: readonly V2PhysicalPayload[];
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;

const parseJson = fromThrowable(JSON.parse as (text: string) => unknown);

interface UnitBlockAsset {
  readonly asset_ordinal?: number;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

/** A stored block → a TLDF block; a malformed one is named in `problems`. */
const convertBlock = (
  raw: unknown,
  assets: ReadonlyMap<number, string>,
  problems: string[]
): TldfBlock | null => {
  const block = asRecord(raw);
  if (block === null) {
    problems.push('a render block is not an object');
    return null;
  }
  const { asset, children, ...rest } = block as Json & {
    asset?: UnitBlockAsset;
    children?: unknown[];
  };
  let tldfAsset: TldfBlock['asset'];
  if (asset !== undefined) {
    const sha = asset.asset_ordinal === undefined ? undefined : assets.get(asset.asset_ordinal);
    tldfAsset = {
      ...(sha !== undefined && { sha256: sha }),
      ...(asset.width !== undefined && { width: asset.width }),
      ...(asset.height !== undefined && { height: asset.height }),
      ...(asset.alt !== undefined && { alt: asset.alt }),
    };
  }
  const kids = Array.isArray(children)
    ? children.flatMap((child) => convertBlock(child, assets, problems) ?? [])
    : undefined;
  return {
    ...(rest as unknown as Omit<TldfBlock, 'asset' | 'children'>),
    ...(tldfAsset !== undefined && { asset: tldfAsset }),
    ...(kids !== undefined && { children: kids }),
  };
};

const convertMark = (
  raw: unknown,
  links: ReadonlyMap<number, V2LinkTarget>,
  problems: string[]
): TldfMark | null => {
  const mark = asRecord(raw);
  if (mark === null) {
    problems.push('a render mark is not an object');
    return null;
  }
  const { link_ordinal: linkOrdinal, ...rest } = mark as Json & { link_ordinal?: number };
  const target = linkOrdinal === undefined ? undefined : links.get(linkOrdinal);
  const link = target === undefined ? null : toTldfLink(target);
  return {
    ...(rest as unknown as Omit<TldfMark, 'link'>),
    ...(link !== null && { link }),
  };
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

interface Group {
  readonly blocks: readonly TldfBlock[];
}

/**
 * One paragraf block per line of ONE stored text-only chunk, the fold exactly
 * the chunk's text: each line after the chunk's first carries its `\n` as the
 * run separator. A line cut by the stored chunk boundary (every 32,768 UTF-16
 * units) continues in the next chunk's first block, without a separator, so
 * the fold stays exact; the reader shows the cut as a paragraph break.
 * Ids are `unmarked:<n>`, numbered across the unit from `firstId`.
 */
export const textOnlyBlocks = (text: string, charStart = 0, firstId = 0): TldfBlock[] => {
  const blocks: TldfBlock[] = [];
  let offset = charStart;
  for (const [i, line] of text.split('\n').entries()) {
    if (i > 0) offset += 1; // the '\n' this line's run carries as its separator
    const span = [offset, offset + line.length] as const;
    const run: TldfRun = { text: line, span, ...(i > 0 && { sep: '\n' as const }) };
    blocks.push({
      id: `unmarked:${String(firstId + i)}`,
      kind: 'paragraf',
      type: 'PAR',
      span,
      content: [run],
    });
    offset += line.length;
  }
  return blocks;
};

/**
 * Convert one served unit into the physical payloads the REST route serves:
 * a single envelope when the unit has one stored chunk, else a manifest
 * (index 0) followed by one chunk payload per stored chunk — so the physical
 * count is `chunks === 1 ? 1 : chunks + 1` (`v2PhysicalChunkCount`).
 */
export const convertUnitRender = (
  head: V2RenderHeadInput,
  unit: V2UnitRenderInput
): Result<V2ConvertedRender, string> => {
  const chunks = [...unit.chunks].sort((a, b) => a.chunkSeq - b.chunkSeq);
  let shape: TldfShape = 'paragraph_stream';
  let containsNonBmp = false;
  const groups: Group[] = [];
  let marks: TldfMark[] = [];
  const problems: string[] = [];

  if (unit.renderState === 'text_only') {
    // One group per stored chunk, so the physical layout (and chunkCount) is
    // known from the chunk count alone.
    let nextId = 0;
    for (const chunk of chunks) {
      if (/[\u{10000}-\u{10FFFF}]/u.test(chunk.body)) containsNonBmp = true;
      const blocks = textOnlyBlocks(chunk.body, chunk.charStart, nextId);
      nextId += blocks.length;
      groups.push({ blocks });
    }
  } else {
    for (const [i, chunk] of chunks.entries()) {
      const parsed = parseJson(chunk.body).map(asRecord).unwrapOr(null);
      const seq = String(chunk.chunkSeq);
      if (parsed === null) return err(`chunk ${seq} is not a JSON object`);
      if (i === 0) {
        if (parsed['format'] !== 'tldf-unit' || parsed['format_version'] !== '1') {
          return err(
            `chunk 0 is ${String(parsed['format'])}/${String(parsed['format_version'])}, not tldf-unit/1`
          );
        }
        if (parsed['offset_unit'] !== 'utf16_code_unit') {
          return err('chunk 0 does not count UTF-16 code units');
        }
        const s = parsed['shape'];
        if (s !== 'standard_articles' && s !== 'paragraph_stream' && s !== 'facsimile') {
          return err(`chunk 0 has an unknown shape ${String(s)}`);
        }
        shape = s;
        containsNonBmp = parsed['contains_non_bmp'] === true;
      }
      const rawBlocks = parsed['blocks'];
      const rawMarks = parsed['marks'];
      if (!Array.isArray(rawBlocks) || !Array.isArray(rawMarks)) {
        return err(`chunk ${seq} lacks blocks or marks`);
      }
      groups.push({
        blocks: rawBlocks.flatMap((b) => convertBlock(b, unit.assetSha256, problems) ?? []),
      });
      marks = marks.concat(rawMarks.flatMap((m) => convertMark(m, unit.links, problems) ?? []));
    }
  }
  if (problems.length > 0) return err(problems[0] ?? 'malformed render');
  if (groups.length === 0) groups.push({ blocks: [] });
  marks.sort((a, b) => a.ordinal - b.ordinal);

  const allBlocks = groups.flatMap((g) => g.blocks);
  const counts = runChars(allBlocks);
  const generation = {
    run_id: head.runId,
    body_sha256: head.bodySha256,
    structure_parser_version: head.parseBuildId,
    content_parser_version: head.contentParserVersion,
  };
  const envelopeHead = {
    format: 'tldf' as const,
    format_version: '1.1' as const,
    compiler_version: head.compilerVersion,
    document_id: head.documentId,
    generation,
    text_sha256: head.textSha256,
    offset_unit: 'utf16_code_unit' as const,
    contains_non_bmp: containsNonBmp,
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

  if (groups.length === 1) {
    return ok({ payloads: [{ kind: 'envelope', tldf: { ...envelopeHead, blocks: allBlocks } }] });
  }
  const index: TldfChunkIndexEntry[] = [];
  for (const [i, g] of groups.entries()) {
    const first = g.blocks[0];
    const last = g.blocks[g.blocks.length - 1];
    if (first === undefined || last === undefined) {
      return err('a stored chunk of a multi-chunk unit holds no blocks');
    }
    index.push({
      chunk_index: i + 1,
      block_id: first.id,
      block_count: g.blocks.length,
      span: [first.span[0], last.span[1]],
    });
  }
  const manifest: TldfManifestPayload = { ...envelopeHead, physical: 'manifest', chunks: index };
  const chunkPayloads: V2PhysicalPayload[] = groups.map((g) => ({
    kind: 'chunk',
    tldf: {
      format: 'tldf',
      format_version: '1.1',
      document_id: head.documentId,
      generation,
      privacy_class: 'public',
      text_sha256: head.textSha256,
      physical: 'chunk',
      blocks: g.blocks,
    },
  }));
  return ok({ payloads: [{ kind: 'manifest', tldf: manifest }, ...chunkPayloads] });
};

/** The physical payload count of a unit with `storedChunks` render chunks. */
export const v2PhysicalChunkCount = (storedChunks: number): number =>
  storedChunks <= 1 ? 1 : storedChunks + 1;
