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
 *
 * A3: the case list selects the native `c.case_id AS case_id_sort` beside its
 * text id, so `SELECT DISTINCT` + numeric `ORDER BY c.case_id` is valid SQL
 * (the old text-only DISTINCT failed with 42P10 even on zero rows); duplicates
 * from several admitted joins collapse BEFORE the limit; the internal key never
 * reaches a node. Narrowing inputs are normalized once; years are validated and
 * compiled with the shared interval; the publication/CUI/join predicates are
 * unchanged.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  invalidInput,
  normalizeCui,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { decodeJudicialCursor, isCanonicalBigintText } from './cases-repo.js';
import { PUBLISHED_STATUS } from './constants.js';
import {
  clampLimit,
  intersectYearOperands,
  yearIntervalSql,
  type YearInterval,
} from './filter-helpers.js';
import { sessionDateDisplay } from './temporal-sql.js';
import {
  JUDICIAL_COURT_LEVELS,
  type JudicialCaseLink,
  type JudicialCompanyLitigation,
  type JudicialCourtLevel,
} from '../../core/types.js';

import type {
  CompanyLitigationFilter,
  JudicialCompanyLinkRepo,
  PartyDictionaryRepo,
} from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;
const MAX_LIST = 50;
const LINK_CAVEAT = 'company-litigation links not yet published';
/** Disclosed when published cases without a finite session calendar year exist. */
const YEARLESS_CAVEAT_SUFFIX =
  'with a null or infinite sourceOpenedAt are counted in caseCount and courtLevels but omitted from years';

/** The flat narrowing arguments as received from GraphQL or MCP (before normalization). */
export interface CompanyLitigationArgs {
  readonly courtLevel?: unknown;
  readonly category?: unknown;
  readonly yearFrom?: unknown;
  readonly yearTo?: unknown;
}

const COURT_LEVELS: ReadonlySet<string> = new Set(JUDICIAL_COURT_LEVELS);

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** A flat string list: null/omitted is absent; a null or non-string member is an error. */
const stringList = (
  value: unknown,
  name: string,
  allowed?: ReadonlySet<string>
): Result<string[] | undefined, ApiError> => {
  if (isAbsent(value)) return ok(undefined);
  if (!Array.isArray(value)) return err(invalidInput(`${name} must be a list`, name));
  for (const member of value as readonly unknown[]) {
    if (typeof member !== 'string' || (allowed !== undefined && !allowed.has(member))) {
      return err(
        invalidInput(
          allowed !== undefined
            ? `${name} members must be one of ${[...allowed].join(', ')}`
            : `${name} members must be strings`,
          name
        )
      );
    }
  }
  return ok([...(value as readonly string[])]);
};

/** Validate the optional company year bounds, each under its own name; null is absent. */
const companyYears = (yearFrom: unknown, yearTo: unknown): Result<YearInterval, ApiError> => {
  const lower = isAbsent(yearFrom) ? ok(null) : intersectYearOperands([yearFrom], [], 'yearFrom');
  if (lower.isErr()) return err(lower.error);
  const upper = isAbsent(yearTo) ? ok(null) : intersectYearOperands([], [yearTo], 'yearTo');
  if (upper.isErr()) return err(upper.error);
  return ok({ from: lower.value?.from ?? null, to: upper.value?.to ?? null });
};

/**
 * Normalize the flat company narrowing arguments ONCE (both adapters call this):
 * omitted and null mean absent; a non-list or a null/non-string member is
 * InvalidInput; an EMPTY list keeps the existing no-narrowing meaning; a year is
 * an original nonzero 32-bit integer number. Returns undefined when nothing
 * narrows, so the cursor filter identity of every valid input is unchanged.
 */
export const normalizeCompanyLitigationFilter = (
  args: CompanyLitigationArgs
): Result<CompanyLitigationFilter | undefined, ApiError> => {
  const levels = stringList(args.courtLevel, 'courtLevel', COURT_LEVELS);
  if (levels.isErr()) return err(levels.error);
  const categories = stringList(args.category, 'category');
  if (categories.isErr()) return err(categories.error);
  const years = companyYears(args.yearFrom, args.yearTo);
  if (years.isErr()) return err(years.error);
  const f: { courtLevels?: string[]; yearFrom?: number; yearTo?: number; categories?: string[] } =
    {};
  if (levels.value !== undefined) f.courtLevels = levels.value;
  if (categories.value !== undefined) f.categories = categories.value;
  if (years.value.from !== null) f.yearFrom = years.value.from;
  if (years.value.to !== null) f.yearTo = years.value.to;
  return ok(Object.keys(f).length > 0 ? f : undefined);
};

/** Re-validate a typed filter at the repo entry (direct callers bypass the adapters). */
const checkedFilter = (
  filter: CompanyLitigationFilter | undefined
): Result<CompanyLitigationFilter | undefined, ApiError> =>
  filter === undefined
    ? ok(undefined)
    : normalizeCompanyLitigationFilter({
        courtLevel: filter.courtLevels,
        category: filter.categories,
        yearFrom: filter.yearFrom,
        yearTo: filter.yearTo,
      });

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
  if (filter.yearFrom !== undefined || filter.yearTo !== undefined) {
    // The validated bounds, compiled by the SAME interval code as the case
    // filter: finite dates only, no make_date outside the ordinary AD window.
    conds.push(
      yearIntervalSql(sql`c.source_opened_at`, {
        from: filter.yearFrom ?? null,
        to: filter.yearTo ?? null,
      })
    );
  }
  return conds;
};

/** The summary year: finite native session calendar year, else NULL (one expression). */
const SUMMARY_YEAR = sql`(case
  when c.source_opened_at is not null and isfinite(c.source_opened_at)
    then extract(year from c.source_opened_at)::integer
end)`;

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
    const checked = checkedFilter(filter);
    if (checked.isErr()) return err(checked.error);
    const filterSql = linkFilterSql(checked.value);
    try {
      // published-only join: candidates(published) → case_parties(name_key) → cases
      // (+ courts for level). count(distinct case) + per-level + per-year breakdowns.
      // The year is the finite native session calendar year or NULL (null and
      // infinite dates), identical in SELECT and GROUP BY: no integer cast of an
      // infinity, and every case still counts in the total and the levels.
      const rows = await sql<{
        court_level: string | null;
        year: number | null;
        cnt: string;
        name_key_id: string | null;
      }>`
        select co.court_level as court_level,
               ${SUMMARY_YEAR} as year,
               count(distinct c.case_id)::text as cnt,
               max(pcc.name_key_id)::text as name_key_id
        from justice.party_company_candidates pcc
        join justice.case_parties p on p.name_key_id = pcc.name_key_id
        join justice.cases c on c.case_id = p.case_id
        left join justice.courts co on co.institution_code = c.institution_code
        where pcc.validation_status = ${PUBLISHED_STATUS}
          and pcc.candidate_cui = ${cui}${filterSql}
        group by co.court_level, ${SUMMARY_YEAR}
      `.execute(db);

      const byLevel = new Map<string, number>();
      const byYear = new Map<number, number>();
      let total = 0;
      let yearless = 0;
      let nameKeyId: string | null = null;
      for (const r of rows.rows) {
        const cnt = Number(r.cnt);
        total += cnt;
        if (r.court_level !== null)
          byLevel.set(r.court_level, (byLevel.get(r.court_level) ?? 0) + cnt);
        if (r.year !== null) byYear.set(r.year, (byYear.get(r.year) ?? 0) + cnt);
        else yearless += cnt;
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
      const years = [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([year, count]) => ({ year, count }));

      return ok({
        cui,
        companyName,
        caseCount: total,
        courtLevels,
        years,
        // coverage = match rate; with no published rows in v1 it is 0 (empty by construction).
        coverage: total > 0 ? 1 : 0,
        caveats:
          total === 0
            ? [LINK_CAVEAT]
            : yearless > 0
              ? [`${String(yearless)} published case(s) ${YEARLESS_CAVEAT_SUFFIX}`]
              : [],
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
    const checked = checkedFilter(filter);
    if (checked.isErr()) return err(checked.error);
    const limit = clampLimit(page.first, MAX_LIST);
    // The cursor fhash is the CUI + filter identity (stable across pages; rejects
    // a cursor minted under a different filter).
    const fhash = companyCasesFhash(cui, checked.value);
    let cursorCaseId: string | undefined;
    if (page.after !== undefined) {
      // The A1 strict decoder: exactly one ORIGINAL JSON string key, canonical
      // signed int8 text, checked before any SQL (the kernel decoder alone would
      // stringify a number already rounded past 2^53).
      const decoded = decodeJudicialCursor(page.after, { sort: 'caseId', dir: 'desc', fhash }, [
        isCanonicalBigintText,
      ]);
      if (decoded.isErr()) return err(decoded.error);
      cursorCaseId = decoded.value[0];
    }
    const filterSql = linkFilterSql(checked.value);
    const cursorSql =
      cursorCaseId !== undefined ? sql` and c.case_id < ${cursorCaseId}::bigint` : sql``;
    try {
      // case_id_sort: the native id in the DISTINCT select list (internal only).
      const rows = await sql<{
        case_id_sort: string;
        case_id: string;
        institution_code: string;
        case_number: string;
        category: string | null;
        source_opened_at: string | null;
      }>`
        select distinct c.case_id as case_id_sort, c.case_id::text as case_id,
               c.institution_code, c.case_number, c.category,
               ${sessionDateDisplay(sql`c.source_opened_at`)} as source_opened_at
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
      const items: JudicialCaseLink[] = (hasMore ? rows.rows.slice(0, limit) : rows.rows).map(
        (r) => ({
          caseId: r.case_id,
          institutionCode: r.institution_code,
          caseNumber: r.case_number,
          category: r.category,
          sourceOpenedAt: r.source_opened_at,
        })
      );
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
