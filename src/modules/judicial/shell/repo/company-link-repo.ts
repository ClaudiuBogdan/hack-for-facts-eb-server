/**
 * Judicial module — company-litigation links repo (plan 08 §4, JD-1). GATED:
 *
 *  - Filters `party_company_candidates.validation_status = 'published'` ONLY
 *    (the foundation "candidate ≠ fact" rule as an SQL predicate). v1 sets no row
 *    to `published`, so this is **empty by construction**.
 *  - Returns COUNTS + case ids + a publishable company name sourced from the GATED
 *    `PartyDictionaryRepo` (joined by name_key_id), NEVER `candidate_company_name`
 *    (that column is not even declared on the table type).
 *  - NEVER returns person rows: the join is keyed by name_key_id, and only
 *    company/public dictionary keys carry a publishable name.
 *
 * Empty result shape: `{ caseCount: 0, coverage: 0, caveats: [...] }`.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  invalidInput,
  normalizeCui,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { PUBLISHED_STATUS } from './constants.js';
import { clampLimit } from './filter-helpers.js';

import type {
  CompanyLitigationFilter,
  JudicialCompanyLinkRepo,
  PartyDictionaryRepo,
} from '../../core/ports.js';
import type {
  JudicialCaseLink,
  JudicialCompanyLitigation,
  JudicialCourtLevel,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;
const MAX_LIST = 50;
const LINK_CAVEAT = 'company-litigation links not yet published';

/**
 * The cursor fhash for the company-litigation case list — bound to the CUI AND
 * the active filter identity, so a cursor minted under one court/year/category
 * filter is rejected under another (codex P1). The resolver builds the SAME hash.
 */
export const companyCasesFhash = (cui: string, filter?: CompanyLitigationFilter): string => {
  const f = {
    courtLevels: [...(filter?.courtLevels ?? [])].sort(),
    categories: [...(filter?.categories ?? [])].sort(),
    yearFrom: filter?.yearFrom ?? null,
    yearTo: filter?.yearTo ?? null,
  };
  return `judicial_company_cases:${cui}:${JSON.stringify(f)}`;
};

/** Build the narrowing conditions for the published-link join. All optional. */
const filterConds = (filter: CompanyLitigationFilter | undefined) => {
  const conds = [] as ReturnType<typeof sql>[];
  if (filter === undefined) return conds;
  if (filter.courtLevels !== undefined && filter.courtLevels.length > 0) {
    conds.push(
      sql`co.court_level in (${sql.join(
        filter.courtLevels.map((l) => sql`${l}`),
        sql`, `
      )})`
    );
  }
  if (filter.categories !== undefined && filter.categories.length > 0) {
    conds.push(
      sql`c.category in (${sql.join(
        filter.categories.map((cat) => sql`${cat}`),
        sql`, `
      )})`
    );
  }
  if (filter.yearFrom !== undefined) conds.push(sql`c.source_opened_at >= make_date(${filter.yearFrom}, 1, 1)`);
  if (filter.yearTo !== undefined) conds.push(sql`c.source_opened_at < make_date(${filter.yearTo + 1}, 1, 1)`);
  return conds;
};

export const makeJudicialCompanyLinkRepo = (
  db: Db,
  dictionary: PartyDictionaryRepo
): JudicialCompanyLinkRepo => {
  /** The optional narrowing SQL fragment for the published-link join. */
  const linkFilterSql = (filter: CompanyLitigationFilter | undefined) => {
    const extra = filterConds(filter);
    return extra.length > 0 ? sql` and ${sql.join(extra, sql` and `)}` : sql``;
  };

  const summaryForCui = async (
    rawCui: string,
    filter?: CompanyLitigationFilter
  ): Promise<Result<JudicialCompanyLitigation, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const filterSql = linkFilterSql(filter);
    try {
      // published-only join: candidates(published) → case_parties(name_key) → cases
      // (+ courts for level). count(distinct case) + per-level + per-year breakdowns.
      const rows = await sql<{ court_level: string | null; year: number | null; cnt: string; name_key_id: string | null }>`
        select co.court_level as court_level,
               date_part('year', c.source_opened_at)::int as year,
               count(distinct c.case_id)::text as cnt,
               max(pcc.name_key_id)::text as name_key_id
        from justice.party_company_candidates pcc
        join justice.case_parties p on p.name_key_id = pcc.name_key_id
        join justice.cases c on c.case_id = p.case_id
        left join justice.courts co on co.institution_code = c.institution_code
        where pcc.validation_status = ${PUBLISHED_STATUS}
          and pcc.candidate_cui = ${cui}${filterSql}
        group by co.court_level, date_part('year', c.source_opened_at)
      `.execute(db);

      const byLevel = new Map<string, number>();
      const byYear = new Map<number, number>();
      let total = 0;
      let nameKeyId: string | null = null;
      for (const r of rows.rows) {
        const cnt = Number(r.cnt);
        total += cnt;
        if (r.court_level !== null) byLevel.set(r.court_level, (byLevel.get(r.court_level) ?? 0) + cnt);
        if (r.year !== null) byYear.set(r.year, (byYear.get(r.year) ?? 0) + cnt);
        if (r.name_key_id !== null) nameKeyId = r.name_key_id;
      }

      // Publishable company name ONLY via the gated dictionary (never candidate_company_name).
      let companyName: string | null = null;
      if (nameKeyId !== null) {
        const nameRes = await dictionary.getPublishableName(nameKeyId);
        if (nameRes.isErr()) return err(nameRes.error);
        companyName = nameRes.value?.displayName ?? null;
      }

      const courtLevels = [...byLevel.entries()].map(([courtLevel, count]) => ({
        courtLevel: courtLevel as JudicialCourtLevel,
        count,
      }));
      const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));

      return ok({
        cui,
        companyName,
        caseCount: total,
        courtLevels,
        years,
        // coverage = match rate; with no published rows in v1 it is 0 (empty by construction).
        coverage: total > 0 ? 1 : 0,
        caveats: total === 0 ? [LINK_CAVEAT] : [],
      });
    } catch (error) {
      return err(databaseError('companyLink.summaryForCui failed', error));
    }
  };

  const listCasesForCui = async (
    rawCui: string,
    page: CursorPageRequest,
    filter?: CompanyLitigationFilter
  ): Promise<Result<CursorPage<JudicialCaseLink>, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const limit = clampLimit(page.first, MAX_LIST);
    // The cursor fhash is the CUI + filter identity (stable across pages; rejects
    // a cursor minted under a different filter).
    const fhash = companyCasesFhash(cui, filter);
    let cursorCaseId: string | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'caseId', dir: 'desc', fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorCaseId = decoded.value.keys[0];
    }
    const filterSql = linkFilterSql(filter);
    const cursorSql = cursorCaseId !== undefined ? sql` and c.case_id < ${cursorCaseId}::bigint` : sql``;
    try {
      const rows = await sql<{
        case_id: string;
        institution_code: string;
        case_number: string;
        category: string | null;
        source_opened_at: string | null;
      }>`
        select distinct c.case_id::text as case_id, c.institution_code, c.case_number,
               c.category, to_char(c.source_opened_at, 'YYYY-MM-DD') as source_opened_at
        from justice.party_company_candidates pcc
        join justice.case_parties p on p.name_key_id = pcc.name_key_id
        join justice.cases c on c.case_id = p.case_id
        left join justice.courts co on co.institution_code = c.institution_code
        where pcc.validation_status = ${PUBLISHED_STATUS}
          and pcc.candidate_cui = ${cui}${filterSql}${cursorSql}
        order by c.case_id desc
        limit ${limit + 1}
      `.execute(db);
      const hasMore = rows.rows.length > limit;
      const items: JudicialCaseLink[] = (hasMore ? rows.rows.slice(0, limit) : rows.rows).map((r) => ({
        caseId: r.case_id,
        institutionCode: r.institution_code,
        caseNumber: r.case_number,
        category: r.category,
        sourceOpenedAt: r.source_opened_at,
      }));
      let next: string | null = null;
      if (hasMore) {
        const last = items[items.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({ sort: 'caseId', dir: 'desc', fhash, lastKeys: [last.caseId] });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('companyLink.listCasesForCui failed', error));
    }
  };

  return { summaryForCui, listCasesForCui };
};
