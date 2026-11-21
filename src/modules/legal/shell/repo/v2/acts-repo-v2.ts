/**
 * `LegalActsRepo` over legal_v2 with the bridge (LEGAL_SOURCE=v2).
 *
 * Identity (acts, citation keys, aliases), versions (forms) and the default
 * form come from legal_v2, public rows only. Status, its evidence, in-degree,
 * entry into force, the summary, the title, the amendment count, the status
 * events and the changes feed are BRIDGED from `legal.*` by act_id through the
 * legacy repo or `v2-reads.ts`.
 *
 * The directory (`listActs`/`countActs`/`countActsBy`) keeps the kernel filter
 * spec unchanged by giving it the same aliases it compiles against: `a` is
 * legal_v2's current public acts joined to `legal.acts` for the bridged
 * columns, `d`/`s` the old canonical document and its summary. An act the old
 * corpus does not hold has no status there; for the filter and the status
 * grid it counts as `necunoscut` (its status IS unknown), so the STATUS
 * buckets keep partitioning the directory; its own `status` field is null.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
} from '@/modules/shared/index.js';

import { legacyDocumentRenderPublic } from './gate.js';
import {
  ID_RE,
  ROUTE_ORDER_SQL,
  V2_ACT_FROM,
  V2_ACT_SELECT,
  readBridgedDocFacts,
  readFormsForActs,
  resolveFormRef,
  splitActRow,
  toFormState,
  type ActIdentityRow,
  type V2BridgedDocFacts,
  type V2FormRow,
} from './v2-reads.js';
import { normalizeAlias, parseCitation } from '../../../core/citation.js';
import { mergeBridgedAct } from '../../../core/v2/bridge.js';
import {
  computeDefaultForm,
  formDocumentId,
  parseDocumentRef,
  versionKindOf,
  type V2DefaultForm,
} from '../../../core/v2/forms.js';
import { legalActsSpec } from '../../filters/legal-acts.spec.js';
import { validateActsCursorKeys } from '../acts-repo.js';
import { clampLimit, kernelConditions, keysetCursor, type SortCast } from '../filter-helpers.js';
import { mapCitationKey } from '../mappers.js';

import type { LegalActListOptions, LegalActsRepo, V2ActSelection } from '../../../core/ports.js';
import type { LegalActRef } from '../../../core/repo-base.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActSummary,
  LegalCitationKey,
  LegalCountBucket,
  LegalCountDimension,
  LegalDocument,
  LegalVersionProvenance,
} from '../../../core/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_LIST = 100;
const CANDIDATE_LIMIT = 25;
const DOCUMENTS_LIST_CAP = 1000;

export interface MakeLegalActsRepoV2Deps {
  readonly db: Db;
  /** The legacy repo: the bridge for status events, the feed and amendment counts. */
  readonly legacy: LegalActsRepo;
  /** The day the default form is computed for (tests pin it). */
  /**
   * The day the default form reads the act as of. Default null: every known
   * form, future-dated ones included (owner decision 2026-11-12).
   */
  readonly today?: () => string | null;
}

/** Filter fields compiled against the old summary (`s`) or the old act (`a.status`). */
const SUMMARY_FIELDS = new Set(['domain', 'category', 'penaltiesMentioned', 'fiscalImpactNull']);
const LEGACY_FIELDS = new Set(['status']);

const filterUses = (filter: FilterInput, fields: ReadonlySet<string>): boolean =>
  Object.entries(filter).some(
    ([key, value]) =>
      fields.has(key) ||
      (key === 'exclude' && typeof value === 'object' && filterUses(value as FilterInput, fields))
  );

/**
 * The directory FROM: the kernel spec's aliases (`a`, `d`, `s`) over public,
 * current legal_v2 acts, joining the old corpus ONLY when the filter, sort or
 * grouping reads it (15 s statement limit). An act the old corpus lacks has
 * an unknown status: it filters and groups as `necunoscut`, and sorts with
 * in-degree 0.
 */
export const v2ActsFrom = (o: { readonly legacy: boolean; readonly summary: boolean }) => sql`
  (select v.act_id, v.act_natural_key, v.act_type, v.act_number, v.act_year, v.issuer_slug,
          v.display_citation,
          ${
            o.legacy
              ? sql`coalesce(l.status, 'necunoscut') as status, coalesce(l.in_degree, 0) as in_degree,
                    l.entry_into_force`
              : sql`null::text as status, 0 as in_degree, null::date as entry_into_force`
          }
     from legal_v2.acts v
     ${o.legacy ? sql`left join legal.acts l on l.act_id = v.act_id` : sql``}
    where v.privacy_class = 'public' and not v.ended) a
  ${
    o.summary
      ? sql`left join legal.act_documents d
              on d.act_id = a.act_id and d.is_canonical
             and ${legacyDocumentRenderPublic(sql.ref('d.document_id'))}
            left join legal.document_summaries s on s.document_id = d.document_id`
      : sql``
  }
`;

const SORT_EXPR: Record<string, { expr: RawBuilder<unknown>; cast: SortCast; legacy: boolean }> = {
  in_degree: { expr: sql`a.in_degree`, cast: 'int', legacy: true },
  act_year: { expr: sql`a.act_year`, cast: 'int', legacy: false },
  entry_into_force: { expr: sql`a.entry_into_force`, cast: 'date', legacy: true },
  display_citation: { expr: sql`a.display_citation`, cast: 'text', legacy: false },
};

const DIM_SQL: Record<
  LegalCountDimension,
  {
    key: RawBuilder<unknown>;
    count: RawBuilder<unknown>;
    lateral?: RawBuilder<unknown>;
    legacy?: boolean;
  }
> = {
  domain: {
    key: sql`dom.domain`,
    count: sql`count(distinct a.act_id)`,
    lateral: sql`cross join lateral unnest(s.domains) as dom(domain)`,
  },
  act_type: { key: sql`a.act_type`, count: sql`count(*)` },
  status: { key: sql`a.status`, count: sql`count(*)`, legacy: true },
  issuer: { key: sql`a.issuer_slug`, count: sql`count(*)` },
  year: { key: sql`a.act_year::text`, count: sql`count(*)` },
};

/** A form row → the `LegalDocument` contract (`documentId` = `f<form_id>`). */
export const mapFormDocument = (
  r: V2FormRow,
  isCanonical: boolean,
  bridged: V2BridgedDocFacts | undefined
): LegalDocument => ({
  documentId: formDocumentId(r.form_id),
  actId: r.act_id,
  versionKind: versionKindOf(r.form_kind),
  versionDate: r.portal_order_date,
  isCanonical,
  den: bridged?.den ?? null,
  title: bridged?.title ?? null,
  issuerRaw: null,
  publicationRaw: r.publication_raw,
  entryIntoForce: r.entry_into_force_reported,
  firstPublicationDate: r.gazette_date_reported,
  statusMarkers: [],
  extractionStatus: null,
  compatibilityTier: null,
  moPart: r.gazette_part,
  moNumber: r.gazette_number,
  moDate: r.gazette_date_reported,
  readable: r.readable,
  caveat: r.caveat ?? (r.form_kind === 'consolidation' ? 'unofficial_consolidation' : null),
  portalLabelRaw: r.portal_label_raw,
  portalLabelDate: r.portal_label_date,
  held: r.held,
  formKey: r.form_key,
  sourceUrl: r.source_url,
});

interface ActForms {
  readonly rows: readonly V2FormRow[];
  readonly def: V2DefaultForm;
}

export const makeLegalActsRepoV2 = (deps: MakeLegalActsRepoV2Deps): LegalActsRepo => {
  const { db, legacy } = deps;
  const today = deps.today ?? ((): string | null => null);

  // ── identity ────────────────────────────────────────────────────────────────

  const toAct = (r: ActIdentityRow, canonical: string | null = null): LegalAct => {
    const { identity, facts } = splitActRow(r);
    return mergeBridgedAct(identity, facts, canonical);
  };

  const selectActs = async (
    where: RawBuilder<unknown>,
    limit: number,
    label: string
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    try {
      const result = await sql<ActIdentityRow>`
        select ${V2_ACT_SELECT}
          from ${V2_ACT_FROM}
         where v.privacy_class = 'public' and ${where}
         order by coalesce(l.in_degree, 0) desc, v.act_id asc
         limit ${limit}
      `.execute(db);
      return ok(result.rows.map((r) => toAct(r)));
    } catch (error) {
      return err(databaseError(`${label} failed`, error));
    }
  };

  const findActById = async (actId: string): Promise<Result<LegalAct | null, ApiError>> => {
    if (!ID_RE.test(actId)) return ok(null);
    // Ended acts stay addressable by id: links from other sources keep working.
    const res = await selectActs(sql`v.act_id = ${actId}::bigint`, 1, 'findActById');
    return res.map((rows) => rows[0] ?? null);
  };

  const findActsByIds = async (
    actIds: readonly string[]
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok([]);
    return selectActs(sql`v.act_id = any(${ids}::bigint[])`, ids.length, 'findActsByIds');
  };

  const findActsByCitationKey = (k: LegalCitationKey) =>
    selectActs(
      sql`not v.ended and exists (
        select 1 from legal_v2.act_citation_keys ck
         where ck.act_id = v.act_id and ck.privacy_class = 'public'
           and ck.act_type = ${k.actType} and ck.act_number = ${k.actNumber}
           and ck.act_year = ${k.actYear} and ck.issuer_slug = ${k.issuerSlug})`,
      CANDIDATE_LIMIT,
      'findActsByCitationKey'
    );

  const findActsByCitationNumber = (k: Omit<LegalCitationKey, 'issuerSlug'>, limit: number) =>
    selectActs(
      sql`not v.ended and exists (
        select 1 from legal_v2.act_citation_keys ck
         where ck.act_id = v.act_id and ck.privacy_class = 'public'
           and ck.act_type = ${k.actType} and ck.act_number = ${k.actNumber}
           and ck.act_year = ${k.actYear})`,
      limit + 1,
      'findActsByCitationNumber'
    );

  const findActsByAlias = (alias: string, limit: number) =>
    selectActs(
      sql`not v.ended and exists (
        select 1 from legal_v2.act_aliases al
         where al.act_id = v.act_id and al.privacy_class = 'public'
           and al.alias = ${normalizeAlias(alias)})`,
      limit + 1,
      'findActsByAlias'
    );

  const searchActsByName = async (q: string, limit: number) => {
    const trimmed = q.trim();
    if (trimmed === '') return ok([]);
    const pattern = `%${trimmed.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
    return selectActs(
      sql`not v.ended and v.display_citation ilike ${pattern} escape '\\'`,
      clampLimit(limit, 50),
      'searchActsByName'
    );
  };

  /** The legacy resolution order, over legal_v2 identity. */
  const resolveActCandidates = async (
    ref: LegalActRef
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    if (ref.actId !== undefined && ref.actId !== '') {
      const one = await findActById(ref.actId);
      if (one.isErr()) return err(one.error);
      return ok(one.value === null ? [] : [one.value]);
    }
    const citation = (ref.citation ?? '').trim();
    if (citation === '') return ok([]);
    const parsed = parseCitation(citation);
    if (parsed !== null) {
      const held = await findActsByCitationNumber(parsed, CANDIDATE_LIMIT);
      if (held.isErr()) return err(held.error);
      if (held.value.length > 0) return ok(held.value.slice(0, CANDIDATE_LIMIT));
    }
    const named = await findActsByAlias(citation, CANDIDATE_LIMIT);
    if (named.isErr()) return err(named.error);
    if (named.value.length > 0) return ok(named.value.slice(0, CANDIDATE_LIMIT));
    return searchActsByName(citation, 5);
  };

  const resolveActRef = async (ref: LegalActRef): Promise<Result<LegalAct | null, ApiError>> => {
    const candidates = await resolveActCandidates(ref);
    if (candidates.isErr()) return err(candidates.error);
    return ok(candidates.value[0] ?? null);
  };

  // ── forms and the default form ─────────────────────────────────────────────

  const formsForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ActForms>, ApiError>> => {
    const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok(new Map());
    const [rowsRes, actsRes] = await Promise.all([
      readFormsForActs(db, ids),
      // Every requested PUBLIC act gets a default result, formless ones too
      // (`default_forms()` answers them with zero counts).
      sql<{ act_id: string; ended: boolean }>`
        select v.act_id::text as act_id, v.ended from legal_v2.acts v
         where v.act_id = any(${ids}::bigint[]) and v.privacy_class = 'public'
      `
        .execute(db)
        .then(
          (r) => ok(r.rows),
          (error: unknown) => err(databaseError('legal_v2 acts read failed', error))
        ),
    ]);
    if (rowsRes.isErr()) return err(rowsRes.error);
    if (actsRes.isErr()) return err(actsRes.error);
    const byAct = new Map<string, V2FormRow[]>();
    for (const r of rowsRes.value) {
      const list = byAct.get(r.act_id);
      if (list === undefined) byAct.set(r.act_id, [r]);
      else list.push(r);
    }
    const day = today();
    const out = new Map<string, ActForms>();
    for (const act of actsRes.value) {
      const rows = byAct.get(act.act_id) ?? [];
      out.set(act.act_id, {
        rows,
        def: computeDefaultForm(act.act_id, rows.map(toFormState), day),
      });
    }
    return ok(out);
  };

  const defaultFormsForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, V2DefaultForm>, ApiError>> => {
    const res = await formsForActs(actIds);
    if (res.isErr()) return err(res.error);
    return ok(new Map([...res.value].map(([id, f]) => [id, f.def])));
  };

  const defaultSelectionsForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, V2ActSelection>, ApiError>> => {
    const [formsRes, bridgedRes] = await Promise.all([
      formsForActs(actIds),
      readBridgedDocFacts(db, actIds),
    ]);
    if (formsRes.isErr()) return err(formsRes.error);
    if (bridgedRes.isErr()) return err(bridgedRes.error);
    const map = new Map<string, V2ActSelection>();
    for (const [actId, forms] of formsRes.value) {
      const row = forms.rows.find((r) => r.form_id === forms.def.defaultFormId);
      map.set(actId, {
        defaultForm: forms.def,
        canonical:
          row === undefined ? null : mapFormDocument(row, true, bridgedRes.value.get(actId)),
      });
    }
    return ok(map);
  };

  const canonicalDocumentsForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalDocument>, ApiError>> => {
    const res = await defaultSelectionsForActs(actIds);
    if (res.isErr()) return err(res.error);
    const map = new Map<string, LegalDocument>();
    for (const [actId, sel] of res.value) if (sel.canonical !== null) map.set(actId, sel.canonical);
    return ok(map);
  };

  const getCanonicalDocument = async (
    actId: string
  ): Promise<Result<LegalDocument | null, ApiError>> => {
    const res = await canonicalDocumentsForActs([actId]);
    return res.map((m) => m.get(actId) ?? null);
  };

  const listDocuments = async (
    actId: string
  ): Promise<Result<readonly LegalDocument[], ApiError>> => {
    if (!ID_RE.test(actId)) return ok([]);
    const [formsRes, bridgedRes] = await Promise.all([
      formsForActs([actId]),
      readBridgedDocFacts(db, [actId]),
    ]);
    if (formsRes.isErr()) return err(formsRes.error);
    if (bridgedRes.isErr()) return err(bridgedRes.error);
    const forms = formsRes.value.get(actId);
    if (forms === undefined) return ok([]);
    const bridged = bridgedRes.value.get(actId);
    const docs = forms.rows
      .filter((r) => !r.ended)
      .map((r) => mapFormDocument(r, r.form_id === forms.def.defaultFormId, bridged))
      .sort((a, b) => {
        if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
        const da = a.versionDate ?? '';
        const dbb = b.versionDate ?? '';
        if (da !== dbb) return da < dbb ? 1 : -1;
        return BigInt(a.documentId.slice(1)) < BigInt(b.documentId.slice(1)) ? 1 : -1;
      });
    return ok(docs.slice(0, DOCUMENTS_LIST_CAP));
  };

  const countDocuments = async (actId: string): Promise<Result<number, ApiError>> => {
    if (!ID_RE.test(actId)) return ok(0);
    try {
      const result = await sql<{ cnt: string }>`
        select count(*) as cnt from legal_v2.forms f
          join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
         where f.act_id = ${actId}::bigint and f.privacy_class = 'public' and not f.ended
      `.execute(db);
      return ok(Number(result.rows[0]?.cnt ?? 0));
    } catch (error) {
      return err(databaseError('countDocuments failed', error));
    }
  };

  const documentActId = async (documentId: string): Promise<Result<string | null, ApiError>> => {
    const res = await resolveFormRef(db, documentId);
    return res.map((ref) => ref?.actId ?? null);
  };

  /**
   * A page id or form id → this act's form, loaded or not (the act-scoped
   * alias lookup), by the SAME selection as the REST render: the preferred
   * route's newest capture (held → null), advertisements only for a page with
   * no current capture, and the form must belong to the act.
   */
  const resolveDocumentForAct = async (
    actId: string,
    documentId: string
  ): Promise<Result<string | null, ApiError>> => {
    const ref = parseDocumentRef(documentId);
    if (!ID_RE.test(actId) || ref.kind === 'invalid') return ok(null);
    try {
      const result =
        ref.kind === 'form'
          ? await sql<{ form_id: string }>`
              select f.form_id::text as form_id from legal_v2.forms f
                join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
               where f.form_id = ${ref.formId}::bigint and f.act_id = ${actId}::bigint
                 and f.privacy_class = 'public'
            `.execute(db)
          : await sql<{ form_id: string }>`
              -- The REST rule: the page's PREFERRED route's newest capture,
              -- whatever its status (held answers nothing, never another
              -- route); an advertisement of this act counts only when the page
              -- has no current capture at all. Then the act must own the form.
              with cap as (
                select s.form_id, s.status, s.privacy_class
                  from legal_v2.form_sources s
                 where s.page_id = ${ref.pageId} and s.subject_kind = 'capture' and s.is_latest
                 order by ${ROUTE_ORDER_SQL}, s.binding_id
                 limit 1
              ),
              ad as (
                select s.form_id
                  from legal_v2.form_sources s
                 where s.page_id = ${ref.pageId} and s.subject_kind = 'advertisement'
                   and s.status = 'bound' and s.privacy_class = 'public'
                   and s.act_id = ${actId}::bigint
                   and not exists (select 1 from cap)
                 order by s.binding_id
                 limit 1
              ),
              pick as (
                select cap.form_id from cap where cap.status = 'bound' and cap.privacy_class = 'public'
                union all
                select ad.form_id from ad
              )
              select f.form_id::text as form_id
                from pick
                join legal_v2.forms f on f.form_id = pick.form_id and f.privacy_class = 'public'
                join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
               where f.act_id = ${actId}::bigint
               limit 1
            `.execute(db);
      const row = result.rows[0];
      return ok(row === undefined ? null : formDocumentId(row.form_id));
    } catch (error) {
      return err(databaseError('resolveDocumentForAct failed', error));
    }
  };

  // ── bridged: summary, amendments, provenance ──────────────────────────────────

  /** A v2 document id → its act → the old corpus's canonical summary. */
  const summariesForDocuments = async (
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalActSummary>, ApiError>> => {
    // Form ids resolve in one statement; an old page id (rare here) one by one.
    const unique = [...new Set(documentIds)];
    const formIdOf = new Map<string, string>();
    const pages: string[] = [];
    for (const id of unique) {
      const ref = parseDocumentRef(id);
      if (ref.kind === 'form') formIdOf.set(ref.formId, id);
      else if (ref.kind === 'page') pages.push(id);
    }
    const actOf = new Map<string, string>();
    if (formIdOf.size > 0) {
      try {
        const rows = await sql<{ form_id: string; act_id: string }>`
          select f.form_id::text as form_id, f.act_id::text as act_id
            from legal_v2.forms f
            join legal_v2.acts a on a.act_id = f.act_id and a.privacy_class = 'public'
           where f.form_id = any(${[...formIdOf.keys()]}::bigint[]) and f.privacy_class = 'public'
        `.execute(db);
        for (const r of rows.rows) {
          const docId = formIdOf.get(r.form_id);
          if (docId !== undefined) actOf.set(docId, r.act_id);
        }
      } catch (error) {
        return err(databaseError('summariesForDocuments failed', error));
      }
    }
    for (const id of pages) {
      const r = await resolveFormRef(db, id);
      if (r.isErr()) return err(r.error);
      if (r.value !== null) actOf.set(id, r.value.actId);
    }
    const bridged = await readBridgedDocFacts(db, [...actOf.values()]);
    if (bridged.isErr()) return err(bridged.error);
    const map = new Map<string, LegalActSummary>();
    for (const [docId, actId] of actOf) {
      const summary = bridged.value.get(actId)?.summary ?? null;
      if (summary !== null) map.set(docId, summary);
    }
    return ok(map);
  };

  /** By act id: the bridged summary, whether or not the act's default form has text. */
  const summariesForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalActSummary>, ApiError>> => {
    const bridged = await readBridgedDocFacts(db, actIds);
    if (bridged.isErr()) return err(bridged.error);
    const map = new Map<string, LegalActSummary>();
    for (const [actId, facts] of bridged.value) {
      if (facts.summary !== null) map.set(actId, facts.summary);
    }
    return ok(map);
  };

  const getSummary = async (
    documentId: string
  ): Promise<Result<LegalActSummary | null, ApiError>> => {
    const res = await summariesForDocuments([documentId]);
    return res.map((m) => m.get(documentId) ?? null);
  };

  const provenanceOf = (
    forms: ActForms | undefined,
    amended: number | null,
    formId?: string
  ): LegalVersionProvenance => {
    const chosenId = formId ?? forms?.def.defaultFormId ?? null;
    const row = forms?.rows.find((r) => r.form_id === chosenId);
    const latestCons = (forms?.rows ?? [])
      .filter((r) => r.form_kind === 'consolidation' && !r.ended && r.portal_order_date !== null)
      .sort((a, b) => ((a.portal_order_date ?? '') < (b.portal_order_date ?? '') ? 1 : -1))[0];
    return {
      versionKind: row === undefined ? '' : versionKindOf(row.form_kind),
      versionDate: row?.portal_order_date ?? null,
      sourceUrl: row?.source_url ?? null,
      amendedAfterPublication: amended,
      latestConsolidationDate: latestCons?.portal_order_date ?? null,
      latestConsolidationLoaded: latestCons?.readable ?? false,
      // The served form itself (LEG-X3AV): kind above, and its caveat and label.
      documentId: row === undefined ? null : formDocumentId(row.form_id),
      caveat:
        row === undefined
          ? null
          : (row.caveat ?? (row.form_kind === 'consolidation' ? 'unofficial_consolidation' : null)),
      portalLabelRaw: row?.portal_label_raw ?? null,
      portalLabelDate: row?.portal_label_date ?? null,
    };
  };

  const versionProvenanceForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalVersionProvenance>, ApiError>> => {
    const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok(new Map());
    const [formsRes, legacyRes] = await Promise.all([
      formsForActs(ids),
      legacy.versionProvenanceForActs(ids),
    ]);
    if (formsRes.isErr()) return err(formsRes.error);
    if (legacyRes.isErr()) return err(legacyRes.error);
    const map = new Map<string, LegalVersionProvenance>();
    for (const id of ids) {
      const forms = formsRes.value.get(id);
      if (forms === undefined) continue;
      // The legacy map holds only acts the old corpus has: absent = unknown, not 0.
      map.set(id, provenanceOf(forms, legacyRes.value.get(id)?.amendedAfterPublication ?? null));
    }
    return ok(map);
  };

  const versionProvenanceForDocument = async (
    documentId: string
  ): Promise<Result<LegalVersionProvenance | null, ApiError>> => {
    const ref = await resolveFormRef(db, documentId);
    if (ref.isErr()) return err(ref.error);
    if (ref.value === null) return ok(null);
    const { actId, formId } = ref.value;
    const [formsRes, legacyRes] = await Promise.all([
      formsForActs([actId]),
      legacy.versionProvenanceForActs([actId]),
    ]);
    if (formsRes.isErr()) return err(formsRes.error);
    if (legacyRes.isErr()) return err(legacyRes.error);
    return ok(
      provenanceOf(
        formsRes.value.get(actId),
        legacyRes.value.get(actId)?.amendedAfterPublication ?? null,
        formId
      )
    );
  };

  // ── the act card ─────────────────────────────────────────────────────────────

  const getActCard = async (ref: LegalActRef): Promise<Result<LegalActCard | null, ApiError>> => {
    const actRes = await resolveActRef(ref);
    if (actRes.isErr()) return err(actRes.error);
    const act = actRes.value;
    if (act === null) return ok(null);
    try {
      const [formsRes, bridgedRes, amendedRes, aliasRows, keyRows] = await Promise.all([
        formsForActs([act.actId]),
        readBridgedDocFacts(db, [act.actId]),
        act.bridged === false
          ? Promise.resolve(ok<number | null, ApiError>(null))
          : legacy.countAmendmentsAfter(act.actId),
        sql<{ alias: string }>`
          select al.alias from legal_v2.act_aliases al
           where al.act_id = ${act.actId}::bigint and al.privacy_class = 'public'
           order by al.alias
        `.execute(db),
        sql<{ act_type: string; act_number: string; act_year: number; issuer_slug: string }>`
          select ck.act_type, ck.act_number, ck.act_year::int as act_year, ck.issuer_slug
            from legal_v2.act_citation_keys ck
           where ck.act_id = ${act.actId}::bigint and ck.privacy_class = 'public'
        `.execute(db),
      ]);
      if (formsRes.isErr()) return err(formsRes.error);
      if (bridgedRes.isErr()) return err(bridgedRes.error);
      if (amendedRes.isErr()) return err(amendedRes.error);
      const forms = formsRes.value.get(act.actId);
      const bridged = bridgedRes.value.get(act.actId);
      const defRow = forms?.rows.find((r) => r.form_id === forms.def.defaultFormId);
      const canonical = defRow === undefined ? null : mapFormDocument(defRow, true, bridged);
      return ok({
        ...act,
        canonicalDocumentId: canonical?.documentId ?? null,
        canonical,
        summary: bridged?.summary ?? null,
        aliases: aliasRows.rows.map((r) => r.alias),
        citationKeys: keyRows.rows.map((r) => mapCitationKey(r)),
        versionCount: (forms?.rows ?? []).filter((r) => !r.ended).length,
        amendedAfterPublication: amendedRes.value,
        newerNotAvailable: forms?.def.newerNotAvailable ?? null,
        defaultBasis: forms?.def.posture ?? null,
        defaultOrderReviewed: forms?.def.orderReviewed ?? null,
        latestDocumentId:
          forms?.def.chosenFormId == null ? null : formDocumentId(forms.def.chosenFormId),
        latestAvailableDocumentId:
          forms?.def.latestAvailableFormId == null
            ? null
            : formDocumentId(forms.def.latestAvailableFormId),
      });
    } catch (error) {
      return err(databaseError('getActCard failed', error));
    }
  };

  // ── the directory ────────────────────────────────────────────────────────────

  const listActs = async (
    o: LegalActListOptions
  ): Promise<Result<CursorPage<LegalAct>, ApiError>> => {
    const limit = clampLimit(o.page.first, MAX_LIST);
    const fhash = fhashFor(legalActsSpec, o.filter);
    const sortInfo = SORT_EXPR[o.sort];
    if (sortInfo === undefined) return err(invalidInput(`invalid sort '${o.sort}'`, 'sort'));
    const kernel = kernelConditions(legalActsSpec, o.filter);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (o.page.after !== undefined) {
      const decoded = decodeCursor(o.page.after, { sort: o.sort, dir: o.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      const keys = validateActsCursorKeys(decoded.value.keys, sortInfo.cast);
      if (keys.isErr()) return err(keys.error);
      conds.push(
        keysetCursor(sortInfo.expr, sortInfo.cast, keys.value.sortKey, keys.value.actId, o.dir)
      );
    }
    const orderBy =
      o.dir === 'desc'
        ? sql`order by ${sortInfo.expr} desc nulls last, a.act_id desc`
        : sql`order by ${sortInfo.expr} asc nulls last, a.act_id asc`;
    const from = v2ActsFrom({
      legacy: sortInfo.legacy || filterUses(o.filter, LEGACY_FIELDS),
      summary: filterUses(o.filter, SUMMARY_FIELDS),
    });
    try {
      // The page of ids first, over only the joins it needs; the acts after.
      const page = await sql<{ act_id: string; sort_key: string | null }>`
        select a.act_id::text as act_id, ${sortInfo.expr}::text as sort_key
          from ${from}
         where ${sql.join(conds, sql` and `)}
         ${orderBy}
         limit ${limit + 1}
      `.execute(db);
      const rows = page.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const found = await findActsByIds(pageRows.map((r) => r.act_id));
      if (found.isErr()) return err(found.error);
      const byId = new Map(found.value.map((a) => [a.actId, a]));
      const items = pageRows.flatMap((r) => byId.get(r.act_id) ?? []);
      const last = pageRows[pageRows.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: o.sort,
              dir: o.dir,
              fhash,
              lastKeys: [last.sort_key ?? '', last.act_id],
            })
          : null;
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listActs (legal_v2) failed', error));
    }
  };

  const countActs = async (filter: FilterInput): Promise<Result<number, ApiError>> => {
    const kernel = kernelConditions(legalActsSpec, filter);
    if (kernel.isErr()) return err(kernel.error);
    const from = v2ActsFrom({
      legacy: filterUses(filter, LEGACY_FIELDS),
      summary: filterUses(filter, SUMMARY_FIELDS),
    });
    try {
      const result = await sql<{ cnt: string }>`
        select count(*) as cnt from ${from} where ${kernel.value}
      `.execute(db);
      return ok(Number(result.rows[0]?.cnt ?? 0));
    } catch (error) {
      return err(databaseError('countActs (legal_v2) failed', error));
    }
  };

  const countActsBy = async (
    dim: LegalCountDimension,
    filter: FilterInput
  ): Promise<Result<readonly LegalCountBucket[], ApiError>> => {
    const dimSql = DIM_SQL[dim] as (typeof DIM_SQL)[LegalCountDimension] | undefined;
    if (dimSql === undefined) return err(invalidInput(`invalid dimension '${dim}'`, 'groupBy'));
    const kernel = kernelConditions(legalActsSpec, filter);
    if (kernel.isErr()) return err(kernel.error);
    const base = v2ActsFrom({
      legacy: dimSql.legacy === true || filterUses(filter, LEGACY_FIELDS),
      summary: dimSql.lateral !== undefined || filterUses(filter, SUMMARY_FIELDS),
    });
    const from = dimSql.lateral === undefined ? base : sql`${base} ${dimSql.lateral}`;
    try {
      const result = await sql<{ key: string | null; cnt: string }>`
        select ${dimSql.key} as key, ${dimSql.count} as cnt
          from ${from}
         where ${kernel.value} and ${dimSql.key} is not null
         group by ${dimSql.key}
         order by ${dimSql.count} desc, ${dimSql.key} asc
      `.execute(db);
      return ok(
        result.rows
          .filter((r): r is { key: string; cnt: string } => r.key !== null)
          .map((r) => ({
            key: r.key,
            label: dim === 'issuer' ? r.key.replace(/-/gu, ' ') : null,
            count: Number(r.cnt),
          }))
      );
    } catch (error) {
      return err(databaseError('countActsBy (legal_v2) failed', error));
    }
  };

  return {
    resolveActRef,
    resolveActCandidates,
    findActById,
    findActsByIds,
    findActsByCitationKey,
    findActsByCitationNumber,
    findActsByAlias,
    searchActsByName,
    // bridged straight through the legacy repo
    getStatusEvents: (actId, source) => legacy.getStatusEvents(actId, source),
    listRecentChanges: (q) => legacy.listRecentChanges(q),
    countRecentChanges: (f) => legacy.countRecentChanges(f),
    countAmendmentsAfter: (actId) => legacy.countAmendmentsAfter(actId),
    listActs,
    countActs,
    countActsBy,
    getActCard,
    getCanonicalDocument,
    listDocuments,
    documentActId,
    countDocuments,
    getSummary,
    versionProvenanceForActs,
    versionProvenanceForDocument,
    canonicalDocumentsForActs,
    summariesForDocuments,
    summariesForActs,
    defaultSelectionsForActs,
    defaultFormsForActs,
    resolveDocumentForAct,
  };
};
