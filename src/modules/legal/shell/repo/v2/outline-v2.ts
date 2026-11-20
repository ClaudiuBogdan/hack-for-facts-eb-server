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
import { composeV2Outline, flattenBlocks, type V2OutlineUnit } from '../../../core/v2/outline.js';

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

export const makeLegalOutlineRepoV2 = (db: Db): LegalOutlineRepo => {
  const entriesFor = async (
    documentId: string
  ): Promise<Result<LegalOutlineEntry[] | null, ApiError>> => {
    const ref = await resolveFormRef(db, documentId);
    if (ref.isErr()) return err(ref.error);
    if (ref.value === null) return ok(null);
    try {
      const result = await sql<OutlineRow>`
        select c.ordinal, u.render_state,
               coalesce((select max(ur.char_end) from legal_v2.unit_render ur
                          where ur.unit_id = u.unit_id), 0) as text_length,
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
          from legal_v2.form_components c
          join legal_v2.text_units u on u.unit_id = c.unit_id
          join legal_v2.forms f on f.form_id = c.form_id and f.privacy_class = 'public'
         where c.form_id = ${ref.value.formId}::bigint
           and c.privacy_class = 'public' and u.privacy_class = 'public'
         order by c.ordinal
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
      return ok(composeV2Outline(formDocumentId(ref.value.formId), units));
    } catch (error) {
      return err(databaseError('legal_v2 outline failed', error));
    }
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
    const all = await entriesFor(documentId);
    if (all.isErr()) return err(all.error);
    return ok((all.value ?? []).find((e) => e.path === path) ?? null);
  };

  return { outline, entryByPath };
};
