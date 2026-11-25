/**
 * Shared legal_v2 reads for the v2 repos. Every relation of legal_v2 carries
 * `privacy_class`; every read here filters `= 'public'` on EVERY legal_v2
 * relation it touches (the views `form_states`, `page_targets`, `link_targets`
 * and `read_form` carry no privacy predicate, so they are not used).
 *
 * Bridged reads go to `legal.*` by act_id; the two schemas share act ids.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { legacyDocumentRenderPublic } from './gate.js';
import { v2DisplayCitation } from '../../../core/v2/display-citation.js';
import { parseDocumentRef, type V2DocumentRef, type V2FormState } from '../../../core/v2/forms.js';
import { asObject, toStatus } from '../mappers.js';

import type { LegalActSummary } from '../../../core/types.js';
import type { V2ActIdentity, V2LegacyFacts } from '../../../core/v2/bridge.js';

type Db = Kysely<ProdDatabase>;

export const ID_RE = /^\d{1,18}$/u;

/** Route preference for reading a page id (afis first: the old corpus compiled afis). */
export const ROUTE_ORDER_SQL = sql`array_position(array['afis','detail','detail_base','print']::text[], s.route)`;

export interface V2FormRow {
  form_id: string;
  act_id: string;
  act_ended: boolean;
  form_kind: string;
  form_key: string;
  portal_order_date: string | null;
  order_rank: number | null;
  accepted: boolean;
  body_resolved: boolean;
  ended: boolean;
  portal_label_raw: string | null;
  portal_label_date: string | null;
  caveat: string | null;
  gazette_number: string | null;
  gazette_part: number | null;
  gazette_date_reported: string | null;
  publication_raw: string | null;
  entry_into_force_reported: string | null;
  readable: boolean;
  held: boolean;
  source_url: string | null;
  portal_list_position: number | null;
  max_page_id: string | null;
}

export const toFormState = (r: V2FormRow): V2FormState => ({
  formId: r.form_id,
  actId: r.act_id,
  formKind: r.form_kind,
  formKey: r.form_key,
  portalOrderDate: r.portal_order_date,
  orderRank: r.order_rank,
  accepted: r.accepted,
  bodyResolved: r.body_resolved,
  ended: r.ended,
  readable: r.readable,
  held: r.held,
  portalListPosition: r.portal_list_position,
  maxPageId: r.max_page_id,
});

/** The capture which supplies this component, including its role in this form. */
export const BOUND_COMPONENT_SOURCE_SQL = sql`s.capture_ref_id = u.capture_ref_id
  and s.form_id = c.form_id and s.component_slot = c.slot
  and s.subject_kind = 'capture' and s.status = 'bound' and s.privacy_class = 'public'`;

/**
 * One lateral row per form (outer alias f). All components participate, including
 * reference slots. Decide privacy before availability and return the same verdict
 * to render, outline, version selection and search in their own read snapshots.
 *
 * Cost: each unit answers "any public chunk" and "any restricted chunk" with EXISTS, so a
 * default or list pass over an act with many pairs reads no chunk counts. Only the render info
 * asks for the count (`countChunks`), for its `chunkCount`; elsewhere `public_chunks` is null.
 *
 * Labels (LEG-X3AV): a header+body consolidation needs BOTH the Portal's literal label and its
 * date (the header supplies them); a whole consolidation keeps the earlier rule, label or date.
 */
export const formReadableSql = (countChunks: boolean) => sql`
  select verdict.status, verdict.status = 'served' as readable, x.public_chunks,
         x.source_url, fc.receipt_id, fc.composition_digest
    from (
      select count(u.unit_id) as units,
             count(*) = 1 and bool_and(c.slot = 'whole') as whole,
             count(*) = 2 and bool_or(c.ordinal = 0 and c.slot = 'header')
                          and bool_or(c.ordinal = 1 and c.slot = 'body') as pair,
             bool_or(c.privacy_class <> 'public' or u.privacy_class <> 'public'
                     or chunks.restricted) as restricted,
             bool_or(c.unit_id is not null and not chunks.any_public) as empty_unit,
             ${
               countChunks
                 ? sql`coalesce(sum((select count(*) from legal_v2.unit_render ur
                                      where ur.unit_id = u.unit_id
                                        and ur.privacy_class = 'public')), 0)::int`
                 : sql`null::int`
             } as public_chunks,
             bool_and(s.binding_id is not null) as bound,
             max(s.requested_url) filter (where c.slot in ('whole', 'header')) as source_url
        from legal_v2.form_components c
        left join legal_v2.text_units u on u.unit_id = c.unit_id
        left join legal_v2.form_sources s on ${BOUND_COMPONENT_SOURCE_SQL}
        cross join lateral (
          select exists (select 1 from legal_v2.unit_render ur
                          where ur.unit_id = u.unit_id and ur.privacy_class = 'public') as any_public,
                 exists (select 1 from legal_v2.unit_render ur
                          where ur.unit_id = u.unit_id and ur.privacy_class <> 'public') as restricted
        ) chunks
       where c.form_id = f.form_id
    ) x
    left join legal_v2.form_current fc on fc.form_id = f.form_id
    cross join lateral (select case
      when f.privacy_class <> 'public' or fc.privacy_class <> 'public' or x.restricted then 'restricted'
      when f.ended or fc.form_id is null or x.units = 0 or x.empty_unit then 'not_loaded'
      when not (x.whole or (f.form_kind = 'consolidation' and x.pair)) then 'composition_not_served'
      when f.form_kind = 'consolidation' and x.pair
           and (nullif(btrim(f.portal_label_raw), '') is null or f.portal_label_date is null)
        then 'label_missing'
      when f.form_kind = 'consolidation' and x.whole
           and f.portal_label_raw is null and f.portal_label_date is null then 'label_missing'
      when not x.bound then 'source_not_bound'
      else 'served' end as status) verdict`;

/** The readable gate without chunk counts: every caller but the render info. */
export const FORM_READABLE_SQL = formReadableSql(false);

/** All public forms of the given acts, with the facts the default rule reads. */
export const readFormsForActs = async (
  db: Db,
  actIds: readonly string[],
  formId?: string
): Promise<Result<V2FormRow[], ApiError>> => {
  const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
  if (ids.length === 0 && formId === undefined) return ok([]);
  const scope =
    formId !== undefined
      ? sql`f.form_id = ${formId}::bigint`
      : sql`f.act_id = any(${ids}::bigint[])`;
  try {
    const result = await sql<V2FormRow>`
      select f.form_id::text as form_id, f.act_id::text as act_id, a.ended as act_ended,
             f.form_kind, f.form_key, f.portal_order_date::text as portal_order_date,
             f.order_rank::int as order_rank, f.accepted, f.body_resolved, f.ended,
             f.portal_label_raw, f.portal_label_date::text as portal_label_date, f.caveat,
             f.portal_list_position::int as portal_list_position,
             -- the default rule's page-id tie-break (p2a_form_states.max_page_id)
             (select max(s.page_id::bigint) from legal_v2.form_sources s
               where s.form_id = f.form_id and s.page_id ~ '^[0-9]+$'
                 and s.privacy_class = 'public')::text as max_page_id,
             f.gazette_number, f.gazette_part::int as gazette_part,
             f.gazette_date_reported::text as gazette_date_reported, f.publication_raw,
             f.entry_into_force_reported::text as entry_into_force_reported,
             gate.readable,
             exists (
                select 1 from legal_v2.form_sources s
               where s.form_id = f.form_id and s.subject_kind = 'capture'
                 and s.status <> 'bound' and s.privacy_class = 'public') as held,
             -- A restricted verdict names no capture at all: the fallback could reach the
             -- restricted part's own page. Otherwise the form's source is its whole or header
             -- capture, a body capture only when nothing else is bound.
             case when gate.status = 'restricted' then null
                  when gate.source_url is not null then gate.source_url else (
               select s.requested_url from legal_v2.form_sources s
               where s.form_id = f.form_id and s.subject_kind = 'capture' and s.status = 'bound'
                 and s.is_latest and s.privacy_class = 'public'
               order by s.component_slot is not distinct from 'body', ${ROUTE_ORDER_SQL},
                        s.binding_id
               limit 1) end as source_url
        from legal_v2.forms f
        join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
        cross join lateral (${FORM_READABLE_SQL}) gate
       where ${scope} and f.privacy_class = 'public'
    `.execute(db);
    return ok(result.rows);
  } catch (error) {
    return err(databaseError('legal_v2 forms read failed', error));
  }
};

export interface V2FormRef {
  readonly formId: string;
  readonly actId: string;
}

/** A held or hidden preferred route must never fall through to another capture. */
export const documentFormPickSql = (ref: Exclude<V2DocumentRef, { kind: 'invalid' }>) =>
  ref.kind === 'form'
    ? sql`select ${ref.formId}::bigint as form_id, 'bound'::text as route_status`
    : sql`select s.form_id,
                 case when s.privacy_class <> 'public' then 'restricted' else s.status end as route_status
            from legal_v2.form_sources s
           where s.page_id = ${ref.pageId} and s.subject_kind = 'capture' and s.is_latest
           order by ${ROUTE_ORDER_SQL}, s.binding_id limit 1`;

/** The form named directly or by its preferred public page route. */
export const resolveFormRef = async (
  db: Db,
  documentId: string
): Promise<Result<V2FormRef | null, ApiError>> => {
  const ref = parseDocumentRef(documentId);
  if (ref.kind === 'invalid') return ok(null);
  try {
    const result = await sql<{ form_id: string; act_id: string }>`
      select f.form_id::text as form_id, f.act_id::text as act_id
        from (${documentFormPickSql(ref)}) pick
        join legal_v2.forms f on f.form_id = pick.form_id and f.privacy_class = 'public'
        join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
       where pick.route_status = 'bound'
    `.execute(db);
    const row = result.rows[0];
    return ok(row === undefined ? null : { formId: row.form_id, actId: row.act_id });
  } catch (error) {
    return err(databaseError('legal_v2 document reference failed', error));
  }
};

interface ActIdentityRow {
  act_id: string;
  act_natural_key: string;
  act_type: string;
  act_number: string | null;
  act_year: number | null;
  issuer_slug: string | null;
  display_citation: string;
  ended: boolean;
  bridged: boolean;
  status: string | null;
  status_evidence: unknown;
  entry_into_force: string | null;
  in_degree: number | null;
}

export const V2_ACT_SELECT = sql`
  v.act_id::text as act_id, v.act_natural_key, v.act_type, v.act_number,
  v.act_year::int as act_year, v.issuer_slug, v.display_citation, v.ended,
  (l.act_id is not null) as bridged, l.status,
  -- status_evidence names acts only in abrogated_by (prod/status.ts): keep
  -- the ones public in legal_v2, so the evidence never names a hidden act
  case when jsonb_typeof(l.status_evidence -> 'abrogated_by') = 'array'
       then jsonb_set(l.status_evidence, '{abrogated_by}', coalesce((
              select jsonb_agg(x.v order by x.o)
                from jsonb_array_elements(l.status_evidence -> 'abrogated_by')
                     with ordinality x(v, o)
               where jsonb_typeof(x.v) = 'number'
                 and exists (select 1 from legal_v2.acts gv
                              where gv.act_id = (x.v #>> '{}')::numeric::bigint
                                and gv.privacy_class = 'public')), '[]'::jsonb))
       else l.status_evidence end as status_evidence,
  l.entry_into_force::text as entry_into_force, l.in_degree
`;

export const V2_ACT_FROM = sql`
  legal_v2.acts v
  left join legal.acts l on l.act_id = v.act_id
`;

export const splitActRow = (
  r: ActIdentityRow
): { identity: V2ActIdentity; facts: V2LegacyFacts | null } => ({
  identity: {
    actId: r.act_id,
    actNaturalKey: r.act_natural_key,
    actType: r.act_type,
    actNumber: r.act_number,
    actYear: r.act_year,
    issuerSlug: r.issuer_slug,
    // The stored value is the natural key (raw v0 placeholder): format it.
    displayCitation: v2DisplayCitation({
      actNaturalKey: r.act_natural_key,
      actType: r.act_type,
      actNumber: r.act_number,
      actYear: r.act_year,
      issuerSlug: r.issuer_slug,
      storedCitation: r.display_citation,
    }),
    ended: r.ended,
  },
  facts: r.bridged
    ? {
        status: toStatus(r.status),
        statusEvidence: asObject(r.status_evidence),
        entryIntoForce: r.entry_into_force,
        inDegree: r.in_degree ?? 0,
      }
    : null,
});

export type { ActIdentityRow };

/** The old corpus's canonical-document title and summary per act (bridged). */
export interface V2BridgedDocFacts {
  readonly title: string | null;
  readonly den: string | null;
  readonly summary: LegalActSummary | null;
}

interface BridgedDocRow {
  act_id: string;
  title: string | null;
  den: string | null;
  document_id: string | null;
  description: string | null;
  summary: string | null;
  plain_language_summary: string | null;
  document_category: string | null;
  domains: string[] | null;
  affected_audiences: string[] | null;
  keywords: string[] | null;
  key_dates: unknown;
  penalties_mentioned: boolean | null;
  fiscal_impact: string | null;
  confidence: number | null;
  source_extraction_status: string | null;
}

export const readBridgedDocFacts = async (
  db: Db,
  actIds: readonly string[]
): Promise<Result<ReadonlyMap<string, V2BridgedDocFacts>, ApiError>> => {
  const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
  if (ids.length === 0) return ok(new Map());
  try {
    const result = await sql<BridgedDocRow>`
      select a.act_id::text as act_id, d.title, d.den, s.document_id, s.description, s.summary,
             s.plain_language_summary, s.document_category, s.domains, s.affected_audiences,
             s.keywords, s.key_dates, s.penalties_mentioned, s.fiscal_impact, s.confidence,
             s.source_extraction_status
        from legal.acts a
        join legal_v2.acts gv on gv.act_id = a.act_id and gv.privacy_class = 'public'
        left join legal.act_documents d
          on d.act_id = a.act_id and d.is_canonical
         and ${legacyDocumentRenderPublic(sql.ref('d.document_id'))}
        left join legal.document_summaries s on s.document_id = d.document_id
       where a.act_id = any(${ids}::bigint[])
    `.execute(db);
    const map = new Map<string, V2BridgedDocFacts>();
    for (const r of result.rows) {
      map.set(r.act_id, {
        title: r.title,
        den: r.den,
        summary:
          r.document_id === null
            ? null
            : {
                documentId: r.document_id,
                description: r.description,
                summary: r.summary,
                plainLanguageSummary: r.plain_language_summary,
                documentCategory: r.document_category,
                domains: r.domains ?? [],
                affectedAudiences: r.affected_audiences ?? [],
                keywords: r.keywords ?? [],
                keyDates: r.key_dates ?? null,
                penaltiesMentioned: r.penalties_mentioned,
                fiscalImpact: r.fiscal_impact,
                confidence: r.confidence,
                sourceExtractionStatus: r.source_extraction_status,
              },
      });
    }
    return ok(map);
  } catch (error) {
    return err(databaseError('bridged document facts read failed', error));
  }
};
