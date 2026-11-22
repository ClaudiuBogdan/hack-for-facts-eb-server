/**
 * `LegalOutlineRepo` over legal_v2: `unit_provisions` of the form's public
 * text units, composed by `composeV2Outline`, keyset-paged on `orderIndex`.
 * One statement reads the components, their provisions and (structured units
 * only) the render bodies whose block ids become the outline paths.
 */

import { sql, type Kysely } from 'kysely';
import { err, fromThrowable, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  filterHash,
} from '@/modules/shared/index.js';

import { resolveFormRef } from './v2-reads.js';
import { formDocumentId } from '../../../core/v2/forms.js';
import {
  composeV2Outline,
  flattenBlocks,
  type V2BlockRef,
  type V2OutlineUnit,
} from '../../../core/v2/outline.js';

import type { LegalOutlineOptions, LegalOutlineRepo } from '../../../core/ports.js';
import type { LegalOutlineEntry } from '../../../core/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_OUTLINE_PAGE = 500;
const parseJson = fromThrowable(JSON.parse as (text: string) => unknown);
const OUTLINE_SORT = 'order_index';

interface OutlineRow {
  ordinal: number;
  render_state: string;
  text_length: number;
  /** The privacy key, read in the SAME snapshot as the provisions it keys. */
  restricted_provisions: string | null;
  composition_digest: string;
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
  composition_digest: string;
  unit_id: string;
  restricted_provisions: string | null;
}

interface FormOutline {
  readonly entries: LegalOutlineEntry[];
  readonly blocks: readonly V2BlockRef[];
}

/** TLDF 1.1's presentation families (no grammar rank, no provision row). */
const PRESENTATION_KINDS = new Set([
  'tabel',
  'rand',
  'celula',
  'imagine',
  'lista',
  'element_lista',
]);

/** Outlines kept per process, keyed by form, composition and withheld provisions. */
const OUTLINE_CACHE_SIZE = 64;

export const makeLegalOutlineRepoV2 = (db: Db): LegalOutlineRepo => {
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
    const ref = await resolveFormRef(db, documentId);
    if (ref.isErr()) return err(ref.error);
    if (ref.value === null) return ok(null);
    const formId = ref.value.formId;
    try {
      // 1. The gate, every request (privacy can flip in place without the
      //    composition changing): the SAME gate as the render body — public
      //    act, form and published composition, every component public, one
      //    public whole unit, no missing body, no restricted chunk. Cheap: no
      //    bodies. Its answer keys the cache.
      const gate = await sql<OutlineGateRow>`
        with f as (
          select f.form_id, fc.composition_digest
            from legal_v2.forms f
            join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
            join legal_v2.form_current fc on fc.form_id = f.form_id and fc.privacy_class = 'public'
           where f.form_id = ${formId}::bigint and f.privacy_class = 'public'
        ),
        comps as (
          select c.slot, c.unit_id,
                 (c.privacy_class = 'public' and coalesce(u.privacy_class = 'public', true)) as public,
                 exists (select 1 from legal_v2.unit_render ur
                          where ur.unit_id = c.unit_id and ur.privacy_class <> 'public') as chunk_restricted
            from legal_v2.form_components c
            join f on f.form_id = c.form_id
            left join legal_v2.text_units u on u.unit_id = c.unit_id
        )
        select f.composition_digest, c.unit_id::text as unit_id,
               (select string_agg(p.provision_seq::text, ',' order by p.provision_seq)
                  from legal_v2.unit_provisions p
                 where p.unit_id = c.unit_id and p.privacy_class <> 'public') as restricted_provisions
          from f join comps c on c.slot = 'whole' and c.unit_id is not null
         where (select count(*) from comps where comps.unit_id is not null) = 1
           and not exists (select 1 from comps where comps.slot = 'missing_body')
           and not exists (select 1 from comps where not comps.public or comps.chunk_restricted)
      `.execute(db);
      const g = gate.rows[0];
      if (g === undefined) return ok({ entries: [], blocks: [] });
      const key = `${formId}:${g.composition_digest}:${g.restricted_provisions ?? ''}`;
      const cached = cache.get(key);
      if (cached !== undefined) return ok(cached);

      // 2. On a miss: the unit's public provisions and its bodies, only while
      //    the composition is still the one the gate saw.
      const result = await sql<OutlineRow>`
        select 0 as ordinal, u.render_state,
               (select fc.composition_digest from legal_v2.form_current fc
                 where fc.form_id = ${formId}::bigint) as composition_digest,
               (select string_agg(p.provision_seq::text, ',' order by p.provision_seq)
                  from legal_v2.unit_provisions p
                 where p.unit_id = u.unit_id and p.privacy_class <> 'public') as restricted_provisions,
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
          from legal_v2.text_units u
         where u.unit_id = ${g.unit_id}::bigint and u.privacy_class = 'public'
           and exists (select 1 from legal_v2.form_current fc
                        where fc.form_id = ${formId}::bigint and fc.privacy_class = 'public'
                          and fc.composition_digest = ${g.composition_digest})
      `.execute(db);
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
        blocks: r.bodies.flatMap((body) =>
          parseJson(body)
            .map((parsed) => {
              const blocks = (parsed as { blocks?: unknown } | null)?.blocks;
              return Array.isArray(blocks) ? flattenBlocks(blocks) : [];
            })
            .unwrapOr([])
        ),
      }));
      if (result.rows.length === 0) return ok({ entries: [], blocks: [] });
      const value: FormOutline = {
        entries: composeV2Outline(formDocumentId(formId), units),
        blocks: units.flatMap((u) => u.blocks),
      };
      // Cached under the key read WITH these entries, so a privacy flip between
      // the gate and this read can never file entries under the older key.
      const row = result.rows[0];
      if (row !== undefined) {
        remember(`${formId}:${row.composition_digest}:${row.restricted_provisions ?? ''}`, value);
      }
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
    const block = all.value.blocks.find((b) => b.id === path && PRESENTATION_KINDS.has(b.kind));
    if (block === undefined) return ok(null);
    return ok({
      documentId: all.value.entries[0]?.documentId ?? documentId,
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

  return { outline, entryByPath };
};
