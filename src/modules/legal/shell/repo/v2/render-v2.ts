/**
 * Both render surfaces read the form gate and its generation in one snapshot.
 * Index 0 holds a whole-unit envelope or a manifest. Each subsequent index
 * serves one stored chunk in (component ordinal, chunk_seq) order.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { documentFormPickSql, formReadableSql } from './v2-reads.js';
import { COMPONENT_BOUNDARY } from '../../../core/v2/composition.js';
import { formDocumentId, parseDocumentRef, versionKindOf } from '../../../core/v2/forms.js';
import {
  V2_HEAD_SUBSTITUTIONS,
  V2_RENDER_SOURCE,
  convertFormChunk,
  v2PhysicalChunkCount,
  type V2RenderComponent,
} from '../../../core/v2/tldf-unit.js';

import type { LegalRenderRepo, LegalRenderSource } from '../../../core/ports.js';
import type { LegalRenderInfo, LegalRenderStatus } from '../../../core/types.js';

type Db = Kysely<ProdDatabase>;

export interface V2ServedForm {
  readonly documentId: string;
  readonly versionKind: string;
  readonly versionDate: string | null;
  readonly caveat: string | null;
  readonly portalLabelRaw: string | null;
  readonly portalLabelDate: string | null;
  readonly sourceUrl: string | null;
}

interface HeadRow {
  form_id: string;
  status: LegalRenderStatus | 'restricted';
  form_kind: string;
  caveat: string | null;
  portal_label_raw: string | null;
  portal_label_date: string | null;
  portal_order_date: string | null;
  receipt_id: string | null;
  published_at: string | null;
  composition_digest: string;
  pair: boolean;
  public_chunks: number;
  source_url: string | null;
  text_sha256: string | null;
  compiler_version: string | null;
  body_sha256: string;
  parse_build_id: string;
  content_parser_version: string;
}

// A pair's folded SHA cannot be derived from two unit SHAs. Cache only that
// scalar, pin it to the published composition and recheck privacy on every read.
const MAX_PAIR_HASHES = 128;
const hashesByDb = new WeakMap<Db, Map<string, Record<string, string>>>();
const rememberHash = (db: Db, row: HeadRow): void => {
  if (!row.pair || row.status !== 'served' || row.text_sha256 === null) return;
  const hashes = hashesByDb.get(db) ?? new Map<string, Record<string, string>>();
  hashes.delete(row.form_id);
  hashes.set(row.form_id, { [row.composition_digest]: row.text_sha256 });
  if (hashes.size > MAX_PAIR_HASHES) {
    const oldest = hashes.keys().next().value;
    if (oldest !== undefined) hashes.delete(oldest);
  }
  hashesByDb.set(db, hashes);
};

const foldedPairHash = (db: Db): RawBuilder<unknown> => sql`coalesce(
  ${JSON.stringify(Object.fromEntries(hashesByDb.get(db) ?? []))}::jsonb -> f.form_id::text ->> gate.composition_digest,
  (select encode(sha256(convert_to(string_agg(part.unit_text, ${COMPONENT_BOUNDARY} order by part.ordinal), 'UTF8')), 'hex')
     from (
       select c.ordinal, string_agg(legal_v2.render_chunk_text(u.render_state, ur.body), '' order by ur.chunk_seq) as unit_text
         from legal_v2.form_components c
         join legal_v2.text_units u on u.unit_id = c.unit_id and u.privacy_class = 'public'
         join legal_v2.unit_render ur on ur.unit_id = u.unit_id and ur.privacy_class = 'public'
        where c.form_id = f.form_id and c.privacy_class = 'public'
        group by c.ordinal
     ) part))`;

const renderHeadSql = (db: Db, scope: RawBuilder<unknown>, includeTextHash: boolean) => sql`
  select f.form_id::text as form_id, f.form_kind, f.caveat, f.portal_label_raw,
         f.portal_label_date::text, f.portal_order_date::text,
         gate.status, gate.receipt_id::text, gate.public_chunks, gate.composition_digest, gate.source_url,
         to_json(r.published_at) #>> '{}' as published_at,
         coalesce(c.slot = 'body', false) as pair, u.compiler_version, u.parse_build_id, u.content_parser_version,
         case when c.slot = 'body' then gate.composition_digest else u.body_sha256 end as body_sha256,
         case when c.slot = 'body' then ${includeTextHash ? foldedPairHash(db) : sql`null`}
              else u.text_sha256 end as text_sha256
    from legal_v2.forms f
    join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
    cross join lateral (${formReadableSql(true)}) gate
    left join legal_v2.package_receipts r on r.receipt_id = gate.receipt_id and r.privacy_class = 'public'
    left join legal_v2.form_components c on gate.readable and c.form_id = f.form_id
          and c.slot in ('whole', 'body') and c.privacy_class = 'public'
    left join legal_v2.text_units u on u.unit_id = c.unit_id and u.privacy_class = 'public'
   where ${scope} and f.privacy_class = 'public'`;

const mapInfo = (row: HeadRow): LegalRenderInfo => {
  const served = row.status === 'served';
  return {
    documentId: formDocumentId(row.form_id),
    renderStatus: row.status === 'restricted' ? 'content_unavailable' : row.status,
    privacyClass: row.status === 'restricted' ? 'restricted' : 'public',
    runId: served ? (row.receipt_id ?? '') : '',
    textSha256: served ? (row.text_sha256 ?? '') : '',
    compilerVersion: served ? (row.compiler_version ?? 'text-only') : '',
    compiledAt: served ? (row.published_at ?? '') : '',
    chunkCount: served ? v2PhysicalChunkCount(row.public_chunks) : null,
  };
};

export const makeLegalRenderRepoV2 = (db: Db): LegalRenderRepo => {
  const renderInfoForDocuments = async (
    documentIds: readonly string[],
    includeTextHash = true
  ): Promise<Result<ReadonlyMap<string, LegalRenderInfo>, ApiError>> => {
    const formIds = new Map<string, string>();
    for (const id of documentIds) {
      const ref = parseDocumentRef(id);
      if (ref.kind === 'form') formIds.set(ref.formId, id);
    }
    if (formIds.size === 0) return ok(new Map());
    try {
      const scope = sql`f.form_id = any(${[...formIds.keys()]}::bigint[])`;
      const result = await sql<HeadRow>`${renderHeadSql(db, scope, includeTextHash)}`.execute(db);
      const map = new Map<string, LegalRenderInfo>();
      for (const row of result.rows) {
        rememberHash(db, row);
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
    renderInfo: async (id) => (await renderInfoForDocuments([id])).map((m) => m.get(id) ?? null),
    renderRow: () =>
      Promise.resolve(
        err(databaseError('legal_v2 has no physical render rows; use the v2 render source'))
      ),
  };
};

interface BodyComponent {
  ordinal: number;
  render_state: 'structured' | 'text_only';
  fidelity_flags: string[];
  chunks: { chunk_seq: number; char_start: number; char_end: number; body: string | null }[];
  links: {
    ordinal: number;
    href: string | null;
    target_fragment: string | null;
    target_act_id: string | null;
    target_form_id: string | null;
  }[];
  assets: { ordinal: number; sha256: string | null }[];
}
interface BodyRow {
  route_status: string;
  head: HeadRow | null;
  components: BodyComponent[];
}

/** Link and asset ordinals belong to the supplying unit. Links go in the envelope or manifest. */
const UNIT_LINKS_SQL = sql`
  select json_agg(json_build_object(
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
                and s.privacy_class = 'public' limit 1)))
    from legal_v2.unit_links l where l.unit_id = u.unit_id and l.privacy_class = 'public'`;

const UNIT_ASSETS_SQL = sql`
  select json_agg(json_build_object('ordinal', ua.ordinal,
                   'sha256', case when ac.bytes_held then ac.object_sha256 end))
    from legal_v2.unit_assets ua
    left join legal_v2.asset_custody ac on ac.asset_id = ua.asset_id and ac.privacy_class = 'public'
   where ua.unit_id = u.unit_id and ua.privacy_class = 'public'`;

const readBody = async (db: Db, documentId: string, wanted: number): Promise<BodyRow | null> => {
  const ref = parseDocumentRef(documentId);
  if (ref.kind === 'invalid') return null;
  const scope = sql`f.form_id = (select form_id from pick where route_status = 'bound')`;
  const result = await sql<BodyRow>`
    with pick as (${documentFormPickSql(ref)}), head as (${renderHeadSql(db, scope, true)}),
    units as (
      select c.ordinal, u.unit_id, u.render_state, u.fidelity_flags
        from head
        join legal_v2.form_components c on c.form_id = head.form_id::bigint and c.privacy_class = 'public'
        join legal_v2.text_units u on u.unit_id = c.unit_id and u.privacy_class = 'public'
       where head.status = 'served'
    ),
    chunks as (
      select u.unit_id, ur.chunk_seq, ur.char_start, ur.char_end,
             case when ${wanted}::int = 0 or
                   row_number() over (order by u.ordinal, ur.chunk_seq) = ${wanted}::int then ur.body end as body
        from units u join legal_v2.unit_render ur on ur.unit_id = u.unit_id and ur.privacy_class = 'public'
    ), parts as (
      select u.ordinal, u.render_state, u.fidelity_flags,
             (select json_agg(json_build_object(
                       'chunk_seq', ch.chunk_seq, 'char_start', ch.char_start,
                       'char_end', ch.char_end, 'body', ch.body) order by ch.chunk_seq)
                from chunks ch where ch.unit_id = u.unit_id) as chunks,
             case when ${wanted}::int = 0 then coalesce((${UNIT_LINKS_SQL}), '[]')
                  else '[]'::json end as links,
             coalesce((${UNIT_ASSETS_SQL}), '[]') as assets
        from units u
    )
    select pick.route_status, (select to_json(head) from head) as head,
           coalesce((select json_agg(parts order by parts.ordinal) from parts), '[]') as components
      from pick
  `.execute(db);
  return result.rows[0] ?? null;
};

const toComponent = (u: BodyComponent): V2RenderComponent => ({
  componentOrdinal: u.ordinal,
  renderState: u.render_state,
  chunks: u.chunks.map((c) => ({
    chunkSeq: c.chunk_seq,
    charStart: c.char_start,
    charEnd: c.char_end,
    body: c.body,
  })),
  links: new Map(
    u.links.map((l) => [
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
  publicAssets: new Map(u.assets.map((a) => [a.ordinal, a.sha256])),
});

export const makeLegalRenderSourceV2 = (db: Db): LegalRenderSource => ({
  read: async (documentId, chunkIndex) => {
    let row: BodyRow | null;
    try {
      row = await readBody(db, documentId, chunkIndex);
    } catch (error) {
      return err(databaseError('legal_v2 render read failed', error));
    }
    const notFound = { reason: 'render_not_found' as const, documentId };
    if (row === null || row.route_status === 'restricted') return err(notFound);
    if (row.route_status !== 'bound') {
      return err({ reason: 'render_unavailable', documentId, renderStatus: 'not_loaded' });
    }
    const head = row.head;
    if (head === null) return err(notFound);
    const info = mapInfo(head);
    const servedId = info.documentId;
    if (head.status === 'restricted')
      return err({ reason: 'render_restricted', documentId: servedId });
    if (head.status !== 'served') {
      return err({ reason: 'render_unavailable', documentId: servedId, renderStatus: head.status });
    }
    rememberHash(db, head);
    const converted = convertFormChunk(
      {
        documentId: servedId,
        runId: Number(head.receipt_id),
        compilerVersion: info.compilerVersion,
        textSha256: info.textSha256,
        bodySha256: head.body_sha256,
        parseBuildId: head.parse_build_id,
        contentParserVersion: head.content_parser_version,
        sourceUrl: head.source_url ?? '',
      },
      row.components.map(toComponent),
      chunkIndex
    );
    if (converted.isErr()) {
      return converted.error === 'not_found'
        ? err(notFound)
        : err({ reason: 'render_inconsistent', documentId: servedId, detail: converted.error });
    }
    const servedForm: V2ServedForm = {
      documentId: servedId,
      versionKind: versionKindOf(head.form_kind),
      versionDate: head.portal_order_date,
      caveat:
        head.caveat ?? (head.form_kind === 'consolidation' ? 'unofficial_consolidation' : null),
      portalLabelRaw: head.portal_label_raw,
      portalLabelDate: head.portal_label_date,
      sourceUrl: head.source_url,
    };
    return ok({
      kind: converted.value.kind,
      chunkIndex,
      info,
      tldf: converted.value.tldf as unknown as Record<string, unknown>,
      renderSource: V2_RENDER_SOURCE,
      cacheable: false,
      extraMeta: {
        servedForm,
        renderHead: head.pair
          ? {
              ...V2_HEAD_SUBSTITUTIONS,
              version: 2,
              'generation.body_sha256': 'form_current.composition_digest',
              'generation.structure_parser_version': 'body text_units.parse_build_id',
              'generation.content_parser_version': 'body text_units.content_parser_version',
              compiler_version: 'body text_units.compiler_version or text-only',
            }
          : V2_HEAD_SUBSTITUTIONS,
        fidelityFlags: [...new Set(row.components.flatMap((u) => u.fidelity_flags))],
      },
    });
  },
});
