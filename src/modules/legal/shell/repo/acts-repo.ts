/**
 * Legal module — `LegalActsRepo` (extends `LegalRepoBase`) over live `legal.*`
 * (plan §3.1–§3.2). The ONLY place reading `legal.acts`/`act_documents`/
 * `document_summaries`/`act_citation_keys`/`act_aliases`/`act_status_events`.
 *
 * Identity (`LegalRepoBase`): `resolveActRef` resolves a numeric `actId` or a
 * free-text `citation` (parsed → act_citation_keys; else act_aliases exact; else
 * display_citation trigram). Ambiguous aliases ("codul fiscal" → 2 acts) pick the
 * highest-`in_degree` act deterministically; `resolveActCandidates` returns the
 * full set so the user-facing path can surface ambiguity (Codex finding).
 *
 * List (`listActs`): the FIXED canonical-join FROM (acts a / canonical doc d /
 * summary s) + the kernel-composed WHERE + the `(sortExpr, act_id)` keyset cursor.
 * `act_id` is the bigint tiebreaker (compared `::bigint`, not text). All sorts use
 * `NULLS LAST` in both directions so the cursor's null-section logic is stable.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type ProdDatabase,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
} from '@/modules/shared/index.js';

import { parseCitation } from './citation.js';
import {
  actsListFrom,
  clampLimit,
  kernelConditions,
  keysetCursor,
  type SortCast,
} from './filter-helpers.js';
import {
  mapAct,
  mapCitationKey,
  mapDocument,
  mapStatusEvent,
  mapSummary,
  type ActRow,
  type StatusEventRow,
  type SummaryRow,
} from './mappers.js';
import {
  AMENDMENT_RELATIONS,
  type LegalAct,
  type LegalActCard,
  type LegalActSummary,
  type LegalCitationKey,
  type LegalDocument,
  type LegalEventSource,
  type LegalStatusEvent,
} from '../../core/types.js';
import { legalActsSpec } from '../filters/legal-acts.spec.js';

import type { LegalActListOptions, LegalActsRepo } from '../../core/ports.js';
import type { LegalActRef } from '../../core/repo-base.js';

type Db = Kysely<ProdDatabase>;

const MAX_LIST = 100;
const ID_RE = /^\d+$/u;

/** The raw select list for `legal.acts a` (used in the sql`` list query). */
const ACT_SELECT = sql`
  a.act_id, a.act_natural_key, a.act_type, a.act_number, a.act_year,
  a.issuer_slug, a.canonical_document_id, a.display_citation, a.status,
  a.status_evidence, a.entry_into_force::text as entry_into_force, a.in_degree
`;

/** Sort column expression + value cast per allowed sort key. act_id always tiebreaks. */
const SORT_EXPR: Record<string, { expr: RawBuilder<unknown>; cast: SortCast }> = {
  in_degree: { expr: sql`a.in_degree`, cast: 'int' },
  act_year: { expr: sql`a.act_year`, cast: 'int' },
  entry_into_force: { expr: sql`a.entry_into_force`, cast: 'date' },
  display_citation: { expr: sql`a.display_citation`, cast: 'text' },
};

/** Read a sort value off a mapped act for cursor encoding (NULL → '' sentinel). */
const sortValueOf = (act: LegalAct, sort: string): string => {
  switch (sort) {
    case 'in_degree':
      return String(act.inDegree);
    case 'act_year':
      return act.actYear === null ? '' : String(act.actYear);
    case 'entry_into_force':
      return act.entryIntoForce ?? '';
    case 'display_citation':
      return act.displayCitation;
    default:
      return '';
  }
};

export const makeLegalActsRepo = (db: Db): LegalActsRepo => {
  const selectActs = () =>
    db
      .selectFrom('legal.acts as a')
      .select([
        'a.act_id',
        'a.act_natural_key',
        'a.act_type',
        'a.act_number',
        'a.act_year',
        'a.issuer_slug',
        'a.canonical_document_id',
        'a.display_citation',
        'a.status',
        'a.status_evidence',
        sql<string | null>`a.entry_into_force::text`.as('entry_into_force'),
        'a.in_degree',
      ]);

  const selectDocuments = () =>
    db
      .selectFrom('legal.act_documents as d')
      .select([
        'd.document_id',
        'd.act_id',
        'd.version_kind',
        sql<string | null>`d.version_date::text`.as('version_date'),
        'd.is_canonical',
        'd.den',
        'd.title',
        'd.issuer_raw',
        'd.publication_raw',
        sql<string | null>`d.entry_into_force::text`.as('entry_into_force'),
        sql<string | null>`d.first_publication_date::text`.as('first_publication_date'),
        'd.status_markers',
        'd.extraction_status',
        'd.compatibility_tier',
        'd.mo_part',
        'd.mo_number',
        sql<string | null>`d.mo_date::text`.as('mo_date'),
      ]);

  const selectSummaries = () =>
    db
      .selectFrom('legal.document_summaries as s')
      .select([
        's.document_id',
        's.description',
        's.summary',
        's.plain_language_summary',
        's.document_category',
        's.domains',
        's.affected_audiences',
        's.keywords',
        's.key_dates',
        's.penalties_mentioned',
        's.fiscal_impact',
        's.confidence',
        's.source_extraction_status',
      ]);

  // ── identity (LegalRepoBase) ────────────────────────────────────────────────

  const findActById = async (actId: string): Promise<Result<LegalAct | null, ApiError>> => {
    if (!ID_RE.test(actId)) return ok(null);
    try {
      const row = await selectActs().where('a.act_id', '=', actId).limit(1).executeTakeFirst();
      return ok(row === undefined ? null : mapAct(row as unknown as ActRow));
    } catch (error) {
      return err(databaseError('findActById failed', error));
    }
  };

  const findActsByIds = async (
    actIds: readonly string[]
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok([]);
    try {
      const rows = await selectActs().where('a.act_id', 'in', ids).execute();
      return ok(rows.map((r) => mapAct(r as unknown as ActRow)));
    } catch (error) {
      return err(databaseError('findActsByIds failed', error));
    }
  };

  const findActsByCitationKey = async (
    k: LegalCitationKey
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    try {
      const rows = await selectActs()
        .innerJoin('legal.act_citation_keys as ck', 'ck.act_id', 'a.act_id')
        .where('ck.act_type', '=', k.actType)
        .where('ck.act_number', '=', k.actNumber)
        .where('ck.act_year', '=', k.actYear)
        .where('ck.issuer_slug', '=', k.issuerSlug)
        .orderBy('a.in_degree', 'desc')
        .limit(25)
        .execute();
      return ok(rows.map((r) => mapAct(r as unknown as ActRow)));
    } catch (error) {
      return err(databaseError('findActsByCitationKey failed', error));
    }
  };

  const searchActsByName = async (
    q: string,
    limit: number
  ): Promise<Result<readonly LegalAct[], ApiError>> => {
    const trimmed = q.trim();
    if (trimmed === '') return ok([]);
    const capped = clampLimit(limit, 50);
    const pattern = `%${trimmed.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
    try {
      const rows = await selectActs()
        .where(sql<boolean>`a.display_citation ilike ${pattern} escape '\\'`)
        .orderBy('a.in_degree', 'desc')
        .limit(capped)
        .execute();
      return ok(rows.map((r) => mapAct(r as unknown as ActRow)));
    } catch (error) {
      return err(databaseError('searchActsByName failed', error));
    }
  };

  /**
   * Resolve a citation to ALL candidate acts (in_degree desc): citation-key
   * candidates first (joint orders, multi-issuer numbers), then exact alias
   * candidates, then a trigram fallback. A numeric `actId` ref → at most one.
   */
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
      // citation key match ignores issuer_slug ('' here) → match on type/number/year.
      try {
        const rows = await selectActs()
          .innerJoin('legal.act_citation_keys as ck', 'ck.act_id', 'a.act_id')
          .where('ck.act_type', '=', parsed.actType)
          .where('ck.act_number', '=', parsed.actNumber)
          .where('ck.act_year', '=', parsed.actYear)
          .orderBy('a.in_degree', 'desc')
          .limit(25)
          .execute();
        if (rows.length > 0) return ok(rows.map((r) => mapAct(r as unknown as ActRow)));
      } catch (error) {
        return err(databaseError('resolveActCandidates key failed', error));
      }
    }

    try {
      const aliasRows = await selectActs()
        .innerJoin('legal.act_aliases as al', 'al.act_id', 'a.act_id')
        .where('al.alias', '=', citation.toLowerCase())
        .orderBy('a.in_degree', 'desc')
        .limit(25)
        .execute();
      if (aliasRows.length > 0) return ok(aliasRows.map((r) => mapAct(r as unknown as ActRow)));
    } catch (error) {
      return err(databaseError('resolveActCandidates alias failed', error));
    }

    return searchActsByName(citation, 5);
  };

  const resolveActRef = async (ref: LegalActRef): Promise<Result<LegalAct | null, ApiError>> => {
    const candidates = await resolveActCandidates(ref);
    if (candidates.isErr()) return err(candidates.error);
    return ok(candidates.value[0] ?? null);
  };

  const getStatusEvents = async (
    actId: string,
    eventSource?: LegalEventSource
  ): Promise<Result<readonly LegalStatusEvent[], ApiError>> => {
    if (!ID_RE.test(actId)) return ok([]);
    try {
      let q = db
        .selectFrom('legal.act_status_events as e')
        .select([
          'e.event_id',
          'e.act_id',
          'e.event_kind',
          sql<string | null>`e.effective_date::text`.as('effective_date'),
          'e.source_act_id',
          'e.evidence',
          'e.event_source',
        ])
        .where('e.act_id', '=', actId);
      if (eventSource !== undefined) q = q.where('e.event_source', '=', eventSource);
      const rows = await q
        .orderBy(sql`e.effective_date asc nulls last`)
        .limit(500)
        .execute();
      return ok(rows.map((r) => mapStatusEvent(r as unknown as StatusEventRow)));
    } catch (error) {
      return err(databaseError('getStatusEvents failed', error));
    }
  };

  // ── list / detail (LegalActsRepo) ───────────────────────────────────────────

  const listActs = async (
    o: LegalActListOptions
  ): Promise<Result<CursorPage<LegalAct>, ApiError>> => {
    const limit = clampLimit(o.page.first, MAX_LIST);
    const fhash = fhashFor(legalActsSpec, o.filter);
    const sortInfo = SORT_EXPR[o.sort];
    if (sortInfo === undefined) return err(invalidInput(`invalid sort '${o.sort}'`, 'sort'));

    let cursorVal: string | undefined;
    let cursorActId: string | undefined;
    if (o.page.after !== undefined) {
      const decoded = decodeCursor(o.page.after, { sort: o.sort, dir: o.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorVal = decoded.value.keys[0];
      cursorActId = decoded.value.keys[1];
    }

    const kernel = kernelConditions(legalActsSpec, o.filter);
    if (kernel.isErr()) return err(kernel.error);
    const conds: RawBuilder<unknown>[] = [kernel.value];
    if (cursorVal !== undefined && cursorActId !== undefined) {
      conds.push(keysetCursor(sortInfo.expr, sortInfo.cast, cursorVal, cursorActId, o.dir));
    }
    const where = sql.join(conds, sql` and `);
    // `dir` is a closed enum → branch to a fixed ORDER BY fragment (no sql.raw).
    const orderBy =
      o.dir === 'desc'
        ? sql`order by ${sortInfo.expr} desc nulls last, a.act_id desc`
        : sql`order by ${sortInfo.expr} asc nulls last, a.act_id asc`;

    try {
      const result = await sql<ActRow>`
        select ${ACT_SELECT}
        from ${actsListFrom}
        where ${where}
        ${orderBy}
        limit ${limit + 1}
      `.execute(db);

      const rows = result.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(mapAct);
      let next: string | null = null;
      if (hasMore) {
        const last = items[items.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: o.sort,
            dir: o.dir,
            fhash,
            lastKeys: [sortValueOf(last, o.sort), last.actId],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listActs failed', error));
    }
  };

  const getCanonicalDocument = async (
    actId: string
  ): Promise<Result<LegalDocument | null, ApiError>> => {
    if (!ID_RE.test(actId)) return ok(null);
    try {
      const row = await selectDocuments()
        .where('d.act_id', '=', actId)
        .where('d.is_canonical', '=', true)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapDocument(row));
    } catch (error) {
      return err(databaseError('getCanonicalDocument failed', error));
    }
  };

  const listDocuments = async (
    actId: string
  ): Promise<Result<readonly LegalDocument[], ApiError>> => {
    if (!ID_RE.test(actId)) return ok([]);
    try {
      const rows = await selectDocuments()
        .where('d.act_id', '=', actId)
        .orderBy(sql`d.is_canonical desc nulls last`)
        .orderBy(sql`d.version_date desc nulls last`)
        .limit(200)
        .execute();
      return ok(rows.map((r) => mapDocument(r)));
    } catch (error) {
      return err(databaseError('listDocuments failed', error));
    }
  };

  const getSummary = async (
    documentId: string
  ): Promise<Result<LegalActSummary | null, ApiError>> => {
    try {
      const row = await selectSummaries()
        .where('s.document_id', '=', documentId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapSummary(row as unknown as SummaryRow));
    } catch (error) {
      return err(databaseError('getSummary failed', error));
    }
  };

  const countAmendmentsAfter = async (actId: string): Promise<Result<number, ApiError>> => {
    if (!ID_RE.test(actId)) return ok(0);
    try {
      const row = await db
        .selectFrom('legal.act_references as r')
        .select(sql<string>`count(*)`.as('cnt'))
        .where('r.target_act_id', '=', actId)
        .where('r.relation', 'in', [...AMENDMENT_RELATIONS])
        .executeTakeFirst();
      return ok(Number(row?.cnt ?? 0));
    } catch (error) {
      return err(databaseError('countAmendmentsAfter failed', error));
    }
  };

  const canonicalDocumentsForActs = async (
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalDocument>, ApiError>> => {
    const ids = [...new Set(actIds.filter((id) => ID_RE.test(id)))];
    if (ids.length === 0) return ok(new Map());
    try {
      const rows = await selectDocuments()
        .where('d.act_id', 'in', ids)
        .where('d.is_canonical', '=', true)
        .execute();
      const map = new Map<string, LegalDocument>();
      for (const r of rows) map.set(r.act_id, mapDocument(r));
      return ok(map);
    } catch (error) {
      return err(databaseError('canonicalDocumentsForActs failed', error));
    }
  };

  const summariesForDocuments = async (
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalActSummary>, ApiError>> => {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return ok(new Map());
    try {
      const rows = await selectSummaries().where('s.document_id', 'in', ids).execute();
      const map = new Map<string, LegalActSummary>();
      for (const r of rows) map.set(r.document_id, mapSummary(r));
      return ok(map);
    } catch (error) {
      return err(databaseError('summariesForDocuments failed', error));
    }
  };

  const getActCard = async (ref: LegalActRef): Promise<Result<LegalActCard | null, ApiError>> => {
    const actRes = await resolveActRef(ref);
    if (actRes.isErr()) return err(actRes.error);
    const act = actRes.value;
    if (act === null) return ok(null);

    const [canonRes, aliasRows, keyRows, versionCountRow, amendedRes] = await Promise.all([
      getCanonicalDocument(act.actId),
      db
        .selectFrom('legal.act_aliases as al')
        .select('al.alias')
        .where('al.act_id', '=', act.actId)
        .execute(),
      db
        .selectFrom('legal.act_citation_keys as ck')
        .select(['ck.act_type', 'ck.act_number', 'ck.act_year', 'ck.issuer_slug'])
        .where('ck.act_id', '=', act.actId)
        .execute(),
      db
        .selectFrom('legal.act_documents as d')
        .select(sql<string>`count(*)`.as('cnt'))
        .where('d.act_id', '=', act.actId)
        .executeTakeFirst(),
      countAmendmentsAfter(act.actId),
    ]);
    if (canonRes.isErr()) return err(canonRes.error);
    if (amendedRes.isErr()) return err(amendedRes.error);

    const canonical = canonRes.value;
    let summary: LegalActSummary | null = null;
    if (canonical !== null) {
      const sRes = await getSummary(canonical.documentId);
      if (sRes.isErr()) return err(sRes.error);
      summary = sRes.value;
    }

    return ok({
      ...act,
      canonical,
      summary,
      aliases: aliasRows.map((r) => r.alias),
      citationKeys: keyRows.map((r) => mapCitationKey(r)),
      versionCount: Number(versionCountRow?.cnt ?? 0),
      amendedAfterPublication: amendedRes.value,
    });
  };

  return {
    // LegalRepoBase
    resolveActRef,
    resolveActCandidates,
    findActById,
    findActsByIds,
    findActsByCitationKey,
    searchActsByName,
    getStatusEvents,
    // LegalActsRepo
    listActs,
    getActCard,
    getCanonicalDocument,
    listDocuments,
    getSummary,
    countAmendmentsAfter,
    canonicalDocumentsForActs,
    summariesForDocuments,
  };
};
