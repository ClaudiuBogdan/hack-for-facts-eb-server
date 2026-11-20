/**
 * The legal_v2 render: availability for GraphQL (`LegalRenderRepo`) and the
 * REST body (`LegalRenderSource`), each read in ONE statement.
 *
 * Privacy first, then shape (`decideV2Render`): a restricted act, form, page
 * route, published composition (`form_current`), component, unit or render
 * chunk answers 403 (or 404 when the form itself is not public) BEFORE any
 * composition status, hash, compiler, timestamp or count is projected.
 * Then:
 *  - no published public text unit, or no public chunk → 409 `not_loaded`;
 *  - anything but ONE whole unit with no missing body → `composition_not_served`;
 *  - a consolidation with neither the Portal's label nor its date →
 *    `label_missing` (LEG-X3AV: its text is never shown without the label);
 *  - the unit's capture not bound (public) to this form → `source_not_bound`.
 *
 * The source URL is the supplying capture's own bound `form_sources` row, never
 * the unit's copy. A v2 render is served `no-store` with no validator: link
 * targets and custody can change while the composition stays the same.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { ROUTE_ORDER_SQL } from './v2-reads.js';
import { formDocumentId, parseDocumentRef, versionKindOf } from '../../../core/v2/forms.js';
import {
  V2_HEAD_SUBSTITUTIONS,
  V2_RENDER_SOURCE,
  convertUnitChunk,
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

/** The facts the decision reads, from either statement. */
export interface V2RenderFacts {
  readonly published: boolean;
  readonly currentPublic: boolean;
  readonly anyComponentRestricted: boolean;
  readonly anyChunkRestricted: boolean;
  readonly units: number;
  readonly wholeUnits: number;
  readonly missingBody: number;
  readonly publicChunks: number;
  readonly formKind: string;
  readonly portalLabelRaw: string | null;
  readonly portalLabelDate: string | null;
  readonly sourceBound: boolean;
}

export type V2RenderDecision = 'restricted' | LegalRenderStatus;

/** Privacy, then shape, then the label and the binding. */
export const decideV2Render = (f: V2RenderFacts): V2RenderDecision => {
  if (f.published && !f.currentPublic) return 'restricted';
  if (f.anyComponentRestricted || f.anyChunkRestricted) return 'restricted';
  if (!f.published || f.units === 0 || f.publicChunks === 0) return 'not_loaded';
  if (f.units !== 1 || f.wholeUnits !== 1 || f.missingBody !== 0) return 'composition_not_served';
  if (f.formKind === 'consolidation' && f.portalLabelRaw === null && f.portalLabelDate === null) {
    return 'label_missing';
  }
  if (!f.sourceBound) return 'source_not_bound';
  return 'served';
};

/** The served form as every v2 text surface states it (LEG-X3AV). */
export interface V2ServedForm {
  readonly documentId: string;
  readonly versionKind: string;
  readonly versionDate: string | null;
  readonly caveat: string | null;
  readonly portalLabelRaw: string | null;
  readonly portalLabelDate: string | null;
  readonly sourceUrl: string | null;
}

/** Per-form facts, shared by the info and body statements. */
const formFactsSql = (formIdExpr: RawBuilder<unknown>): RawBuilder<unknown> => sql`
  select count(u.unit_id)::int as units,
         (count(*) filter (where c.slot = 'whole' and u.unit_id is not null))::int as whole_units,
         (count(*) filter (where c.slot = 'missing_body'))::int as missing_body,
         coalesce(bool_or(c.privacy_class <> 'public' or u.privacy_class <> 'public'), false)
           as component_restricted,
         min(u.unit_id) as unit_id
    from legal_v2.form_components c
    left join legal_v2.text_units u on u.unit_id = c.unit_id
   where c.form_id = ${formIdExpr}`;

interface InfoRow {
  form_id: string;
  form_kind: string;
  portal_label_raw: string | null;
  portal_label_date: string | null;
  receipt_id: string | null;
  published_at: string | null;
  current_public: boolean | null;
  units: number;
  whole_units: number;
  missing_body: number;
  component_restricted: boolean;
  text_sha256: string | null;
  compiler_version: string | null;
  public_chunks: number;
  chunk_restricted: boolean;
  source_bound: boolean;
}

const infoFacts = (r: InfoRow): V2RenderFacts => ({
  published: r.receipt_id !== null,
  currentPublic: r.current_public === true,
  anyComponentRestricted: r.component_restricted,
  anyChunkRestricted: r.chunk_restricted,
  units: r.units,
  wholeUnits: r.whole_units,
  missingBody: r.missing_body,
  publicChunks: r.public_chunks,
  formKind: r.form_kind,
  portalLabelRaw: r.portal_label_raw,
  portalLabelDate: r.portal_label_date,
  sourceBound: r.source_bound,
});

/** Availability as GraphQL serves it: nothing beyond the verdict unless served. */
const mapInfo = (row: InfoRow): LegalRenderInfo => {
  const decision = decideV2Render(infoFacts(row));
  const served = decision === 'served';
  return {
    documentId: formDocumentId(row.form_id),
    renderStatus: decision === 'restricted' ? 'content_unavailable' : decision,
    privacyClass: decision === 'restricted' ? 'restricted' : 'public',
    runId: served ? (row.receipt_id ?? '') : '',
    textSha256: served ? (row.text_sha256 ?? '') : '',
    compilerVersion: served ? (row.compiler_version ?? TEXT_ONLY_COMPILER) : '',
    compiledAt: served ? (row.published_at ?? '') : '',
    chunkCount: served ? v2PhysicalChunkCount(row.public_chunks) : null,
  };
};

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
        select f.form_id::text as form_id, f.form_kind, f.portal_label_raw,
               f.portal_label_date::text as portal_label_date,
               fc.receipt_id::text as receipt_id,
               case when r.privacy_class = 'public' then to_json(r.published_at) #>> '{}' end
                 as published_at,
               fc.privacy_class = 'public' as current_public,
               x.units, x.whole_units, x.missing_body, x.component_restricted,
               u.text_sha256, u.compiler_version,
               coalesce((select count(*) from legal_v2.unit_render ur
                          where ur.unit_id = x.unit_id and ur.privacy_class = 'public'), 0)::int
                 as public_chunks,
               exists (select 1 from legal_v2.unit_render ur
                        where ur.unit_id = x.unit_id and ur.privacy_class <> 'public')
                 as chunk_restricted,
               exists (select 1 from legal_v2.form_sources s
                        where s.capture_ref_id = u.capture_ref_id and s.form_id = f.form_id
                          and s.subject_kind = 'capture' and s.status = 'bound'
                          and s.privacy_class = 'public') as source_bound
          from legal_v2.forms f
          join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
          left join legal_v2.form_current fc on fc.form_id = f.form_id
          left join legal_v2.package_receipts r on r.receipt_id = fc.receipt_id
          cross join lateral (${formFactsSql(sql.ref('f.form_id'))}) x
          left join legal_v2.text_units u on u.unit_id = x.unit_id and u.privacy_class = 'public'
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
      const ref = parseDocumentRef(documentId);
      if (ref.kind !== 'form') return ok(null);
      const res = await renderInfoForDocuments([documentId]);
      return res.map((m) => m.get(documentId) ?? null);
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
  form_kind: string;
  caveat: string | null;
  portal_label_raw: string | null;
  portal_label_date: string | null;
  portal_order_date: string | null;
  receipt_id: string | null;
  current_public: boolean | null;
  published_at: string | null;
}
interface BodyUnit {
  public: boolean;
  render_state: 'structured' | 'text_only';
  text_sha256: string;
  compiler_version: string | null;
  body_sha256: string;
  parse_build_id: string;
  content_parser_version: string;
  fidelity_flags: string[];
}
interface BodyFacts {
  units: number;
  whole_units: number;
  missing_body: number;
  component_restricted: boolean;
}
interface BodyChunk {
  chunk_seq: number;
  char_start: number;
  char_end: number;
  public: boolean;
  body: string | null;
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
  route_status: string | null;
  head: BodyHead | null;
  facts: BodyFacts | null;
  unit: BodyUnit | null;
  source_url: string | null;
  chunks: BodyChunk[];
  links: BodyLink[];
  assets: BodyAsset[];
}

/**
 * Everything one render request needs, in ONE statement (one snapshot): the
 * page route (for an old page id: its preferred route's NEWEST capture, held
 * or not, so a held route never falls through to another route's form), the
 * form, its composition facts, the whole unit, the supplying capture's bound
 * source row, chunk metadata with only the bodies this request serves, the
 * public links (for an envelope or manifest only) and the public images.
 */
const readBody = async (db: Db, documentId: string, wanted: number): Promise<BodyRow | null> => {
  const ref = parseDocumentRef(documentId);
  if (ref.kind === 'invalid') return null;
  const pick =
    ref.kind === 'form'
      ? sql`select ${ref.formId}::bigint as form_id, 'bound'::text as route_status`
      : sql`select s.form_id,
                   case when s.privacy_class <> 'public' then 'restricted' else s.status end
                     as route_status
              from legal_v2.form_sources s
             where s.page_id = ${ref.pageId} and s.subject_kind = 'capture' and s.is_latest
             order by ${ROUTE_ORDER_SQL}, s.binding_id
             limit 1`;
  const result = await sql<BodyRow>`
    with pick as (${pick}),
    f as (
      select f.form_id, f.form_kind, f.caveat, f.portal_label_raw, f.portal_label_date,
             f.portal_order_date
        from pick
        join legal_v2.forms f on f.form_id = pick.form_id and f.privacy_class = 'public'
        join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
       where pick.route_status = 'bound'
    ),
    x as (${formFactsSql(sql`(select f.form_id from f)`)}),
    one as (
      select u.* from x join legal_v2.text_units u on u.unit_id = x.unit_id
       where x.units = 1 and x.whole_units = 1 and x.missing_body = 0
         and not x.component_restricted
    )
    select
      (select route_status from pick) as route_status,
      (select json_build_object(
                'form_id', f.form_id::text, 'form_kind', f.form_kind, 'caveat', f.caveat,
                'portal_label_raw', f.portal_label_raw,
                'portal_label_date', f.portal_label_date::text,
                'portal_order_date', f.portal_order_date::text,
                'receipt_id', fc.receipt_id::text,
                'current_public', fc.privacy_class = 'public',
                'published_at',
                  case when r.privacy_class = 'public' then to_json(r.published_at) #>> '{}' end)
         from f
         left join legal_v2.form_current fc on fc.form_id = f.form_id
         left join legal_v2.package_receipts r on r.receipt_id = fc.receipt_id) as head,
      (select json_build_object('units', x.units, 'whole_units', x.whole_units,
                                'missing_body', x.missing_body,
                                'component_restricted', x.component_restricted)
         from x where exists (select 1 from f)) as facts,
      (select json_build_object(
                'public', one.privacy_class = 'public', 'render_state', one.render_state,
                'text_sha256', one.text_sha256, 'compiler_version', one.compiler_version,
                'body_sha256', one.body_sha256, 'parse_build_id', one.parse_build_id,
                'content_parser_version', one.content_parser_version,
                'fidelity_flags', one.fidelity_flags)
         from one) as unit,
      (select s.requested_url from one
         join legal_v2.form_sources s on s.capture_ref_id = one.capture_ref_id
        where s.form_id = (select f.form_id from f) and s.subject_kind = 'capture'
          and s.status = 'bound' and s.privacy_class = 'public'
        order by s.binding_id limit 1) as source_url,
      (select coalesce(json_agg(json_build_object(
                'chunk_seq', ur.chunk_seq, 'char_start', ur.char_start, 'char_end', ur.char_end,
                'public', ur.privacy_class = 'public',
                'body', case when ur.privacy_class = 'public'
                              and (${wanted}::int = 0 or ur.chunk_seq = ${wanted}::int - 1)
                             then ur.body end) order by ur.chunk_seq), '[]'::json)
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
        where l.privacy_class = 'public' and ${wanted}::int = 0) as links,
      (select coalesce(json_agg(json_build_object(
                'ordinal', ua.ordinal,
                'sha256', case when ac.bytes_held then ac.object_sha256 end) order by ua.ordinal), '[]'::json)
         from legal_v2.unit_assets ua join one on one.unit_id = ua.unit_id
         left join legal_v2.asset_custody ac on ac.asset_id = ua.asset_id and ac.privacy_class = 'public'
        where ua.privacy_class = 'public') as assets
  `.execute(db);
  return result.rows[0] ?? null;
};

export const makeLegalRenderSourceV2 = (db: Db): LegalRenderSource => ({
  read: async (
    documentId: string,
    chunkIndex: number
  ): Promise<Result<LegalRenderPayload, LegalRenderError | ApiError>> => {
    let row: BodyRow | null;
    try {
      row = await readBody(db, documentId, chunkIndex);
    } catch (error) {
      return err(databaseError('legal_v2 render read failed', error));
    }
    const notFound = { reason: 'render_not_found' as const, documentId };
    const routeStatus = row?.route_status ?? null;
    if (row === null || routeStatus === null || routeStatus === 'restricted') {
      return err(notFound);
    }
    if (routeStatus !== 'bound') {
      // The page's preferred route is held: never another route's form.
      return err({ reason: 'render_unavailable', documentId, renderStatus: 'not_loaded' });
    }
    const head = row.head;
    const facts = row.facts;
    if (head === null || facts === null) return err(notFound);
    // An old page id answers with the form it shows now, under the form's id.
    const servedId = formDocumentId(head.form_id);
    const decision = decideV2Render({
      published: head.receipt_id !== null,
      currentPublic: head.current_public === true,
      anyComponentRestricted: facts.component_restricted || row.unit?.public === false,
      anyChunkRestricted: row.chunks.some((c) => !c.public),
      units: facts.units,
      wholeUnits: facts.whole_units,
      missingBody: facts.missing_body,
      publicChunks: row.chunks.filter((c) => c.public).length,
      formKind: head.form_kind,
      portalLabelRaw: head.portal_label_raw,
      portalLabelDate: head.portal_label_date,
      sourceBound: row.source_url !== null,
    });
    if (decision === 'restricted')
      return err({ reason: 'render_restricted', documentId: servedId });
    if (decision !== 'served') {
      return err({ reason: 'render_unavailable', documentId: servedId, renderStatus: decision });
    }
    const unit = row.unit;
    if (unit === null) return err({ reason: 'render_restricted', documentId: servedId });
    const sourceUrl = row.source_url ?? '';
    const converted = convertUnitChunk(
      {
        documentId: servedId,
        runId: Number(head.receipt_id),
        compilerVersion: unit.compiler_version ?? TEXT_ONLY_COMPILER,
        textSha256: unit.text_sha256,
        bodySha256: unit.body_sha256,
        parseBuildId: unit.parse_build_id,
        contentParserVersion: unit.content_parser_version,
        sourceUrl,
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
        publicAssets: new Map(row.assets.map((a) => [a.ordinal, a.sha256])),
      },
      chunkIndex
    );
    if (converted.isErr()) {
      return converted.error === 'not_found'
        ? err({ reason: 'render_not_found', documentId })
        : err({ reason: 'render_inconsistent', documentId: servedId, detail: converted.error });
    }
    const payload = converted.value;
    const servedForm: V2ServedForm = {
      documentId: servedId,
      versionKind: versionKindOf(head.form_kind),
      versionDate: head.portal_order_date,
      caveat:
        head.caveat ?? (head.form_kind === 'consolidation' ? 'unofficial_consolidation' : null),
      portalLabelRaw: head.portal_label_raw,
      portalLabelDate: head.portal_label_date,
      sourceUrl: sourceUrl === '' ? null : sourceUrl,
    };
    const info: LegalRenderInfo = {
      documentId: servedId,
      renderStatus: 'served',
      privacyClass: 'public',
      runId: head.receipt_id ?? '',
      textSha256: unit.text_sha256,
      compilerVersion: unit.compiler_version ?? TEXT_ONLY_COMPILER,
      compiledAt: head.published_at ?? '',
      chunkCount: v2PhysicalChunkCount(row.chunks.length),
    };
    return ok({
      kind: payload.kind,
      chunkIndex,
      info,
      tldf: payload.tldf as unknown as Record<string, unknown>,
      renderSource: V2_RENDER_SOURCE,
      cacheable: false,
      extraMeta: {
        servedForm,
        renderHead: V2_HEAD_SUBSTITUTIONS,
        fidelityFlags: unit.fidelity_flags,
      },
    });
  },
});
