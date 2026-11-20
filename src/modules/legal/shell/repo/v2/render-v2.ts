/**
 * The legal_v2 render: availability for GraphQL (`LegalRenderRepo`) and the
 * REST body (`LegalRenderSource`), each read in ONE statement.
 *
 * Gates, in the legacy order: no public form → 404; no published text unit
 * → 409 `not_loaded`; several text units (header plus body) → 409
 * `composition_not_served` (not in this version, per the design); any
 * restricted component, unit or chunk → 403. Links and images join their
 * public rows only: a link whose row or target act is not public is served as
 * a plain reference with no target.
 *
 * The validator (ETag) is the form's `composition_digest` plus the identity
 * generation (`page_acts` / bound captures, which decide link targets, change
 * only in an identity publication) plus the converter version.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { resolveFormRef } from './v2-reads.js';
import { formDocumentId, parseDocumentRef } from '../../../core/v2/forms.js';
import {
  V2_RENDER_CONVERTER_VERSION,
  V2_RENDER_SOURCE,
  convertUnitRender,
  v2PhysicalChunkCount,
  type V2LinkTarget,
} from '../../../core/v2/tldf-unit.js';

import type { LegalRenderRepo, LegalRenderSource } from '../../../core/ports.js';
import type {
  LegalRenderError,
  LegalRenderInfo,
  LegalRenderPayload,
  LegalRenderStatus,
} from '../../../core/types.js';

type Db = Kysely<ProdDatabase>;

const TEXT_ONLY_COMPILER = 'text-only';

interface InfoRow {
  form_id: string;
  receipt_id: string | null;
  published_at: string | null;
  current_public: boolean | null;
  units: number;
  whole_units: number;
  missing_body: number;
  restricted: boolean | null;
  text_sha256: string | null;
  compiler_version: string | null;
  chunks: number;
  chunk_restricted: boolean | null;
}

/**
 * Served only when ONE text unit makes the whole form (`slot = 'whole'`) and no
 * component says its body is missing. A header without its body, or a header
 * plus a body, is a composition this version does not serve: answering it as a
 * complete text would be a partial reading. A whole unit beside linked annexes
 * is served (the annexes' text lives on their own pages).
 */
export const v2RenderStatus = (row: {
  receipt_id: string | null;
  units: number;
  whole_units: number;
  missing_body: number;
}): LegalRenderStatus =>
  row.receipt_id === null || row.units === 0
    ? 'not_loaded'
    : row.units === 1 && row.whole_units === 1 && row.missing_body === 0
      ? 'served'
      : 'composition_not_served';

const mapInfo = (row: InfoRow): LegalRenderInfo => {
  const status = v2RenderStatus(row);
  const restricted =
    row.current_public === false || row.restricted === true || row.chunk_restricted === true;
  return {
    documentId: formDocumentId(row.form_id),
    renderStatus: status,
    privacyClass: restricted ? 'restricted' : 'public',
    runId: row.receipt_id ?? '',
    textSha256: status === 'served' ? (row.text_sha256 ?? '') : '',
    compilerVersion: row.compiler_version ?? TEXT_ONLY_COMPILER,
    compiledAt: row.published_at ?? '',
    chunkCount: status === 'served' ? v2PhysicalChunkCount(row.chunks) : null,
  };
};

export const v2Etag = (compositionDigest: string, generationSeq: string): string =>
  `W/"${V2_RENDER_CONVERTER_VERSION}-${compositionDigest.slice(0, 32)}-g${generationSeq}"`;

export const makeLegalRenderRepoV2 = (db: Db): LegalRenderRepo => {
  const renderInfoForDocuments = async (
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalRenderInfo>, ApiError>> => {
    const formIds = new Map<string, string>();
    for (const id of documentIds) {
      const ref = parseDocumentRef(id);
      if (ref.kind === 'form') formIds.set(ref.formId, id);
    }
    if (formIds.size === 0) return ok(new Map());
    try {
      const result = await sql<InfoRow>`
        select f.form_id::text as form_id, fc.receipt_id::text as receipt_id,
               to_json(r.published_at) #>> '{}' as published_at, fc.privacy_class = 'public' as current_public,
               x.units, x.whole_units, x.missing_body, x.restricted, x.text_sha256,
               x.compiler_version,
               coalesce((select count(*) from legal_v2.unit_render ur
                          where ur.unit_id = x.unit_id), 0)::int as chunks,
               (select bool_or(ur.privacy_class <> 'public') from legal_v2.unit_render ur
                 where ur.unit_id = x.unit_id) as chunk_restricted
          from legal_v2.forms f
          join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
          left join legal_v2.form_current fc on fc.form_id = f.form_id
          left join legal_v2.package_receipts r on r.receipt_id = fc.receipt_id
          cross join lateral (
            select count(u.unit_id)::int as units,
                   (count(*) filter (where c.slot = 'whole' and u.unit_id is not null))::int
                     as whole_units,
                   (count(*) filter (where c.slot = 'missing_body'))::int as missing_body,
                   bool_or(c.privacy_class <> 'public' or u.privacy_class <> 'public') as restricted,
                   min(u.unit_id) as unit_id, min(u.text_sha256) as text_sha256,
                   min(u.compiler_version) as compiler_version
              from legal_v2.form_components c
              left join legal_v2.text_units u on u.unit_id = c.unit_id
             where c.form_id = f.form_id) x
         where f.form_id = any(${[...formIds.keys()]}::bigint[]) and f.privacy_class = 'public'
      `.execute(db);
      const map = new Map<string, LegalRenderInfo>();
      for (const row of result.rows) {
        const key = formIds.get(row.form_id);
        if (key !== undefined) map.set(key, mapInfo(row));
      }
      return ok(map);
    } catch (error) {
      return err(databaseError('legal_v2 renderInfo failed', error));
    }
  };

  return {
    renderInfoForDocuments,
    renderInfo: async (documentId) => {
      const ref = await resolveFormRef(db, documentId);
      if (ref.isErr()) return err(ref.error);
      if (ref.value === null) return ok(null);
      const res = await renderInfoForDocuments([formDocumentId(ref.value.formId)]);
      return res.map((m) => m.get(formDocumentId(ref.value?.formId ?? '')) ?? null);
    },
    // The v2 body travels through `LegalRenderSource`; there are no physical rows.
    renderRow: () =>
      Promise.resolve(
        err(databaseError('legal_v2 has no physical render rows; use the v2 render source'))
      ),
  };
};

// ── the body ───────────────────────────────────────────────────────────────────

interface BodyHead {
  form_id: string;
  composition_digest: string | null;
  receipt_id: string | null;
  current_public: boolean | null;
  published_at: string | null;
  generation_seq: string;
}
interface BodyComponent {
  ordinal: number;
  slot: string;
  has_unit: boolean;
  public: boolean;
  render_state: 'structured' | 'text_only';
  text_sha256: string;
  compiler_version: string | null;
  body_sha256: string;
  parse_build_id: string;
  content_parser_version: string;
  requested_url: string;
}
interface BodyChunk {
  chunk_seq: number;
  char_start: number;
  char_end: number;
  public: boolean;
  body: string;
}
interface BodyLink {
  ordinal: number;
  href: string | null;
  target_fragment: string | null;
  target_act_id: string | null;
  target_form_id: string | null;
}
interface BodyAsset {
  ordinal: number;
  sha256: string | null;
}
interface BodyRow {
  head: BodyHead | null;
  components: BodyComponent[];
  chunks: BodyChunk[];
  links: BodyLink[];
  assets: BodyAsset[];
}

/**
 * Everything one render request needs, in ONE statement (one snapshot): the
 * form, its components, and — only when exactly one text unit serves it —
 * that unit's chunks, its public links with their read-time targets, and its
 * public images with the custody hash. `json`, not `jsonb`, so chunk bodies
 * are not re-parsed by the database.
 */
const readBody = async (db: Db, formId: string): Promise<BodyRow | undefined> => {
  const result = await sql<BodyRow>`
    with f as (
      select f.form_id
        from legal_v2.forms f
        join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
       where f.form_id = ${formId}::bigint and f.privacy_class = 'public'
    ),
    comps as (
      select c.ordinal, c.slot,
             (c.privacy_class = 'public' and coalesce(u.privacy_class = 'public', true)) as public,
             u.unit_id, u.render_state, u.text_sha256, u.compiler_version, u.body_sha256,
             u.parse_build_id, u.content_parser_version, u.requested_url
        from legal_v2.form_components c
        join f on f.form_id = c.form_id
        left join legal_v2.text_units u on u.unit_id = c.unit_id
    ),
    one as (
      select comps.unit_id from comps
       where comps.public and comps.slot = 'whole' and comps.unit_id is not null
         and (select count(*) from comps where comps.unit_id is not null) = 1
         and not exists (select 1 from comps where comps.slot = 'missing_body')
    )
    select
      (select json_build_object(
                'form_id', f.form_id::text,
                'composition_digest', fc.composition_digest,
                'receipt_id', fc.receipt_id::text,
                'current_public', fc.privacy_class = 'public',
                'published_at', to_json(r.published_at) #>> '{}',
                'generation_seq', (select p.generation_seq::text from legal_v2.identity_publication p))
         from f
         left join legal_v2.form_current fc on fc.form_id = f.form_id
         left join legal_v2.package_receipts r on r.receipt_id = fc.receipt_id) as head,
      (select coalesce(json_agg(json_build_object(
                'ordinal', c.ordinal, 'slot', c.slot, 'has_unit', c.unit_id is not null,
                'public', c.public, 'render_state', c.render_state,
                'text_sha256', c.text_sha256, 'compiler_version', c.compiler_version,
                'body_sha256', c.body_sha256, 'parse_build_id', c.parse_build_id,
                'content_parser_version', c.content_parser_version,
                'requested_url', c.requested_url) order by c.ordinal), '[]'::json)
         from comps c) as components,
      (select coalesce(json_agg(json_build_object(
                'chunk_seq', ur.chunk_seq, 'char_start', ur.char_start, 'char_end', ur.char_end,
                'public', ur.privacy_class = 'public', 'body', ur.body) order by ur.chunk_seq), '[]'::json)
         from legal_v2.unit_render ur join one on one.unit_id = ur.unit_id) as chunks,
      (select coalesce(json_agg(json_build_object(
                'ordinal', l.ordinal, 'href', l.href, 'target_fragment', l.target_fragment,
                'target_act_id', (
                   select ta.act_id::text from legal_v2.page_acts pa
                     join legal_v2.acts ta on ta.act_id = pa.act_id and ta.privacy_class = 'public'
                    where pa.page_id = l.target_page_id and pa.privacy_class = 'public'),
                'target_form_id', (
                   select tf.form_id::text from legal_v2.form_sources s
                     join legal_v2.forms tf on tf.form_id = s.form_id and tf.privacy_class = 'public'
                     join legal_v2.acts ta on ta.act_id = tf.act_id and ta.privacy_class = 'public'
                    where s.page_id = l.target_page_id and s.route = l.target_route
                      and s.subject_kind = 'capture' and s.is_latest and s.status = 'bound'
                      and s.privacy_class = 'public'
                    limit 1)) order by l.ordinal), '[]'::json)
         from legal_v2.unit_links l join one on one.unit_id = l.unit_id
        where l.privacy_class = 'public') as links,
      (select coalesce(json_agg(json_build_object(
                'ordinal', ua.ordinal,
                'sha256', case when ac.bytes_held then ac.object_sha256 end) order by ua.ordinal), '[]'::json)
         from legal_v2.unit_assets ua join one on one.unit_id = ua.unit_id
         left join legal_v2.asset_custody ac on ac.asset_id = ua.asset_id and ac.privacy_class = 'public'
        where ua.privacy_class = 'public') as assets
  `.execute(db);
  return result.rows[0];
};

export const makeLegalRenderSourceV2 = (db: Db): LegalRenderSource => ({
  read: async (
    documentId: string,
    chunkIndex: number
  ): Promise<Result<LegalRenderPayload, LegalRenderError | ApiError>> => {
    const ref = await resolveFormRef(db, documentId);
    if (ref.isErr()) return err(ref.error);
    if (ref.value === null) return err({ reason: 'render_not_found', documentId });
    // An old page id answers with the form it shows now, under the form's id.
    const servedId = formDocumentId(ref.value.formId);

    let row: BodyRow | undefined;
    try {
      row = await readBody(db, ref.value.formId);
    } catch (error) {
      return err(databaseError('legal_v2 render read failed', error));
    }
    const head = row?.head ?? null;
    if (row === undefined || head === null) return err({ reason: 'render_not_found', documentId });

    const units = row.components.filter((c) => c.has_unit);
    const status = v2RenderStatus({
      receipt_id: head.receipt_id,
      units: units.length,
      whole_units: units.filter((c) => c.slot === 'whole').length,
      missing_body: row.components.filter((c) => c.slot === 'missing_body').length,
    });
    if (status !== 'served') {
      return err({ reason: 'render_unavailable', documentId: servedId, renderStatus: status });
    }
    const unit = units[0];
    if (
      unit === undefined ||
      head.current_public !== true ||
      row.components.some((c) => !c.public) ||
      row.chunks.some((c) => !c.public)
    ) {
      return err({ reason: 'render_restricted', documentId: servedId });
    }
    if (row.chunks.length === 0) {
      return err({
        reason: 'render_inconsistent',
        documentId: servedId,
        detail: 'the served unit has no render chunks',
      });
    }

    const converted = convertUnitRender(
      {
        documentId: servedId,
        runId: Number(head.receipt_id),
        compilerVersion: unit.compiler_version ?? TEXT_ONLY_COMPILER,
        textSha256: unit.text_sha256,
        bodySha256: unit.body_sha256,
        parseBuildId: unit.parse_build_id,
        contentParserVersion: unit.content_parser_version,
        sourceUrl: unit.requested_url,
      },
      {
        renderState: unit.render_state,
        chunks: row.chunks.map((c) => ({
          chunkSeq: c.chunk_seq,
          charStart: c.char_start,
          charEnd: c.char_end,
          body: c.body,
        })),
        links: new Map<number, V2LinkTarget>(
          row.links.map((l) => [
            l.ordinal,
            {
              ordinal: l.ordinal,
              href: l.href,
              targetFragment: l.target_fragment,
              targetActId: l.target_act_id,
              targetFormId: l.target_form_id,
            },
          ])
        ),
        assetSha256: new Map(
          row.assets.flatMap((a) => (a.sha256 === null ? [] : [[a.ordinal, a.sha256] as const]))
        ),
      }
    );
    if (converted.isErr()) {
      return err({ reason: 'render_inconsistent', documentId: servedId, detail: converted.error });
    }
    const payloads = converted.value.payloads;

    const payload = payloads[chunkIndex];
    if (payload === undefined) return err({ reason: 'render_not_found', documentId });
    const info: LegalRenderInfo = {
      documentId: servedId,
      renderStatus: 'served',
      privacyClass: 'public',
      runId: head.receipt_id ?? '',
      textSha256: unit.text_sha256,
      compilerVersion: unit.compiler_version ?? TEXT_ONLY_COMPILER,
      compiledAt: head.published_at ?? '',
      chunkCount: payloads.length,
    };
    return ok({
      kind: payload.kind,
      chunkIndex,
      info,
      tldf: payload.tldf as unknown as Record<string, unknown>,
      etag: v2Etag(head.composition_digest ?? '', head.generation_seq),
      renderSource: V2_RENDER_SOURCE,
    });
  },
});
