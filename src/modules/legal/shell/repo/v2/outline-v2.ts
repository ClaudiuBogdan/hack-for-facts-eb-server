/**
 * `LegalOutlineRepo` over legal_v2: `unit_provisions` of the form's public
 * text units, composed by `composeV2Outline`, keyset-paged on `orderIndex`.
 * One statement reads the components, their provisions and (structured units
 * only) the render bodies whose block ids become the outline paths.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  filterHash,
} from '@/modules/shared/index.js';

import { FORM_READABLE_SQL, documentFormPickSql } from './v2-reads.js';
import { formDocumentId, parseDocumentRef } from '../../../core/v2/forms.js';
import {
  composePresentationBlocks,
  composeV2OutlineKeyed,
  flattenBlocks,
  type V2BlockRef,
  type V2OutlineUnit,
} from '../../../core/v2/outline.js';
import { storedOutlineBlocks } from '../../../core/v2/tldf-unit.js';

import type { LegalOutlineOptions, LegalOutlineRepo } from '../../../core/ports.js';
import type { LegalOutlineEntry } from '../../../core/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_OUTLINE_PAGE = 500;
const OUTLINE_SORT = 'order_index';

interface OutlineRow extends OutlineGateRow {
  text_length: number;
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
  bodies: string[];
}

interface OutlineGateRow {
  form_id: string;
  ordinal: number;
  composition_digest: string;
  unit_id: string;
  restricted_provisions: string | null;
}

interface FormOutline {
  readonly documentId: string;
  readonly entries: LegalOutlineEntry[];
  readonly blocks: readonly V2BlockRef[];
  /** `v2ProvisionKey(ordinal, seq)` → the outline path of that provision. */
  readonly paths: ReadonlyMap<string, string>;
  /** The composition these paths were read from (gate row). */
  readonly compositionDigest: string | null;
}

/** The provision paths of one readable form, with the composition they belong to. */
export interface V2ProvisionPaths {
  readonly compositionDigest: string | null;
  readonly paths: ReadonlyMap<string, string>;
}

/** The outline repo, and the provision paths search shares with it (one cache). */
export interface V2OutlineReader {
  readonly repo: LegalOutlineRepo;
  /** The outline path of each public provision of a readable form; null when not readable. */
  readonly provisionPaths: (
    documentId: string
  ) => Promise<Result<V2ProvisionPaths | null, ApiError>>;
}

// Both the cache lookup and the body read recheck the entire form in their
// own snapshot. A privacy flip or a rebind between statements cannot mix units.
const OUTLINE_COMPONENTS_SQL = sql`
  from legal_v2.forms f
  join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
  cross join lateral (${FORM_READABLE_SQL}) gate
  join legal_v2.form_components c on c.form_id = f.form_id and c.privacy_class = 'public'
  join legal_v2.text_units u on u.unit_id = c.unit_id and u.privacy_class = 'public'`;

const OUTLINE_KEY_SQL = sql`f.form_id::text as form_id, gate.composition_digest, c.ordinal, u.unit_id::text as unit_id,
  (select string_agg(p.provision_seq::text, ',' order by p.provision_seq)
     from legal_v2.unit_provisions p
    where p.unit_id = u.unit_id and p.privacy_class <> 'public') as restricted_provisions`;

const cacheKey = (rows: readonly OutlineGateRow[]): string =>
  JSON.stringify(
    rows.map((r) => [
      r.form_id,
      r.composition_digest,
      r.ordinal,
      r.unit_id,
      r.restricted_provisions,
    ])
  );

/** Outlines kept per process, keyed by form, composition and withheld provisions. */
const OUTLINE_CACHE_SIZE = 64;

export const makeLegalOutlineRepoV2 = (db: Db): LegalOutlineRepo => makeV2OutlineReader(db).repo;

export const makeV2OutlineReader = (db: Db): V2OutlineReader => {
  const cache = new Map<string, FormOutline>();
  const remember = (key: string, value: FormOutline): void => {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > OUTLINE_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const outlineFor = async (documentId: string): Promise<Result<FormOutline | null, ApiError>> => {
    const ref = parseDocumentRef(documentId);
    if (ref.kind === 'invalid') return ok(null);
    try {
      const scope = sql`where f.form_id = (select pick.form_id from (${documentFormPickSql(ref)}) pick
                                          where pick.route_status = 'bound')
                          and f.privacy_class = 'public' and gate.readable order by c.ordinal`;
      const gate = await sql<OutlineGateRow>`
        select ${OUTLINE_KEY_SQL} ${OUTLINE_COMPONENTS_SQL} ${scope}
      `.execute(db);
      if (gate.rows.length === 0) return ok(null);
      const cached = cache.get(cacheKey(gate.rows));
      if (cached !== undefined) return ok(cached);

      const result = await sql<OutlineRow>`
        select ${OUTLINE_KEY_SQL},
               coalesce((select max(ur.char_end) from legal_v2.unit_render ur
                          where ur.unit_id = u.unit_id and ur.privacy_class = 'public'), 0) as text_length,
               coalesce((select json_agg(json_build_object(
                          'provision_seq', p.provision_seq, 'kind', p.kind,
                          'citation_path', p.citation_path, 'address', p.address,
                          'address_state', p.address_state, 'label_raw', p.label_raw,
                          'source_element_id', p.source_element_id,
                          'char_start', p.char_start, 'char_end', p.char_end))
                          from legal_v2.unit_provisions p
                         where p.unit_id = u.unit_id and p.privacy_class = 'public'), '[]'::json)
                 as provisions,
               case when u.render_state = 'structured' then
                 coalesce((select json_agg(ur.body order by ur.chunk_seq)
                             from legal_v2.unit_render ur
                            where ur.unit_id = u.unit_id and ur.privacy_class = 'public'), '[]'::json)
               else '[]'::json end as bodies
          ${OUTLINE_COMPONENTS_SQL} ${scope}
      `.execute(db);
      const first = result.rows[0];
      if (first === undefined) return ok(null);
      const id = formDocumentId(first.form_id);
      const units: V2OutlineUnit[] = result.rows.map((r) => ({
        componentOrdinal: r.ordinal,
        textLength: r.text_length,
        provisions: r.provisions.map((p) => ({
          provisionSeq: p.provision_seq,
          kind: p.kind,
          citationPath: p.citation_path,
          address: p.address,
          addressState: p.address_state,
          labelRaw: p.label_raw,
          sourceElementId: p.source_element_id,
          charStart: p.char_start,
          charEnd: p.char_end,
        })),
        blocks: r.bodies.flatMap((body) => flattenBlocks(storedOutlineBlocks(body))),
      }));
      const keyed = composeV2OutlineKeyed(id, units);
      const value: FormOutline = {
        documentId: id,
        entries: keyed.map((k) => k.entry),
        blocks: composePresentationBlocks(units),
        paths: new Map(keyed.map((k) => [k.key, k.entry.path])),
        compositionDigest: first.composition_digest,
      };
      remember(cacheKey(result.rows), value);
      return ok(value);
    } catch (error) {
      return err(databaseError('legal_v2 outline failed', error));
    }
  };

  const entriesFor = async (
    documentId: string
  ): Promise<Result<LegalOutlineEntry[] | null, ApiError>> => {
    const res = await outlineFor(documentId);
    return res.map((o) => o?.entries ?? null);
  };

  const outline = async (
    options: LegalOutlineOptions
  ): Promise<Result<CursorPage<LegalOutlineEntry>, ApiError>> => {
    const limit = Math.min(Math.max(options.page.first, 1), MAX_OUTLINE_PAGE);
    const fhash = filterHash(`outline:${options.documentId}:${String(options.maxDepth)}`);
    let after = -1;
    if (options.page.after !== undefined) {
      const decoded = decodeCursor(options.page.after, { sort: OUTLINE_SORT, dir: 'asc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      const parsed = Number.parseInt(decoded.value.keys[0] ?? '', 10);
      if (Number.isNaN(parsed))
        return err(databaseError('outline cursor carries a non-numeric key'));
      after = parsed;
    }
    const all = await entriesFor(options.documentId);
    if (all.isErr()) return err(all.error);
    const headings = (all.value ?? []).filter(
      (e) => e.depth !== null && e.depth <= options.maxDepth && e.orderIndex > after
    );
    const items = headings.slice(0, limit);
    const last = items[items.length - 1];
    const next =
      headings.length > limit && last !== undefined
        ? buildNextCursor({
            sort: OUTLINE_SORT,
            dir: 'asc',
            fhash,
            lastKeys: [String(last.orderIndex)],
          })
        : null;
    return ok({ items, next });
  };

  const entryByPath = async (
    documentId: string,
    path: string
  ): Promise<Result<LegalOutlineEntry | null, ApiError>> => {
    const all = await outlineFor(documentId);
    if (all.isErr()) return err(all.error);
    if (all.value === null) return ok(null);
    const entry = all.value.entries.find((e) => e.path === path);
    if (entry !== undefined) return ok(entry);
    // A presentation node (a table cell, an image) has no provision row: it
    // answers from its render block, with no grammar depth and no number.
    // Presentation nodes only: a legal node without a public provision row
    // (a withheld provision) must not answer through its block.
    const block = all.value.blocks.find((b) => b.id === path);
    if (block === undefined) return ok(null);
    return ok({
      documentId: all.value.documentId,
      path: block.id,
      nodeKind: block.kind,
      label: null,
      numberKey: null,
      numberSystem: null,
      numberStatus: null,
      depth: null,
      orderIndex: -1,
      charStart: block.span[0],
      charEnd: block.span[1],
    });
  };

  const provisionPaths = async (
    documentId: string
  ): Promise<Result<V2ProvisionPaths | null, ApiError>> =>
    (await outlineFor(documentId)).map((o) =>
      o === null ? null : { compositionDigest: o.compositionDigest, paths: o.paths }
    );

  return { repo: { outline, entryByPath }, provisionPaths };
};
