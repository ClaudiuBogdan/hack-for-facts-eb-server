/**
 * Judicial module — cases repo (plan 08 §4). Reads `justice.cases` (+ a bounded
 * join to `justice.courts` for the `courtLevel` virtual + aggregate). NO PII:
 * `justice.cases` has no name column; `object` is the procedural subject, safe.
 *
 * BOUNDING RULE (§7.1): the case list + aggregate REQUIRE a court/period bound
 * (institutionCode | courtLevel | year* | modified*). An unbounded request over
 * the 6.16M-row table is `InvalidInput`. The `courtLevel` and `year` filter fields
 * are VIRTUAL (no native column) — the repo compiles them here.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  toConditionBuilders,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  clampLimit,
  composeWhere,
  fieldOf,
  hasRangeBound,
  inStrings,
  keysetCursor,
  yearBounds,
} from './filter-helpers.js';
import { judicialCasesSpec } from '../filters/judicial.spec.js';

import type { CaseAggregateOptions, CaseListOptions, JudicialCaseRepo } from '../../core/ports.js';
import type {
  JudicialAggregateGroup,
  JudicialAsOf,
  JudicialCase,
  JudicialCaseAggregate,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const MAX_LIST = 50;
const AGG_GROUP_CAP = 500;

const CASE_SELECT = sql`
  c.case_id::text as case_id, c.source_slug, c.institution_code, c.case_number,
  c.case_number_old, c.department, c.category, c.category_name, c.stage, c.stage_name,
  c.object, to_char(c.source_opened_at, 'YYYY-MM-DD') as source_opened_at,
  c.latest_source_modified_at
`;

interface CaseRow {
  case_id: string;
  source_slug: string;
  institution_code: string;
  case_number: string;
  case_number_old: string | null;
  department: string | null;
  category: string | null;
  category_name: string | null;
  stage: string | null;
  stage_name: string | null;
  object: string | null;
  source_opened_at: string | null;
  latest_source_modified_at: string | null;
}

const mapCase = (r: CaseRow): JudicialCase => ({
  caseId: r.case_id,
  sourceSlug: r.source_slug,
  institutionCode: r.institution_code,
  caseNumber: r.case_number,
  caseNumberOld: r.case_number_old,
  department: r.department,
  category: r.category,
  categoryName: r.category_name,
  stage: r.stage,
  stageName: r.stage_name,
  object: r.object,
  sourceOpenedAt: r.source_opened_at,
  latestSourceModifiedAt:
    r.latest_source_modified_at === null
      ? null
      : new Date(r.latest_source_modified_at).toISOString(),
});

/** The sort column expression + cursor cast for each named case sort. */
const SORT_EXPR: Record<'modifiedAt' | 'openedAt', { expr: RawBuilder<unknown>; cast: 'date' }> = {
  modifiedAt: { expr: sql`c.latest_source_modified_at`, cast: 'date' },
  openedAt: { expr: sql`c.source_opened_at`, cast: 'date' },
};

const sortValueOf = (c: JudicialCase, sort: 'modifiedAt' | 'openedAt'): string =>
  (sort === 'modifiedAt' ? c.latestSourceModifiedAt : c.sourceOpenedAt) ?? '';

/**
 * Compile the `courtLevel` virtual into an `institution_code IN (subquery)` over
 * justice.courts (bounded by the 246-row reference). Returns null when absent.
 */
const courtLevelCond = (input: FilterInput): RawBuilder<unknown> | null => {
  const levels = inStrings(fieldOf(input, 'courtLevel'));
  if (levels === undefined) return null;
  if (levels.length === 0) return sql`false`; // explicit empty IN → match nothing
  return sql`c.institution_code in (select co.institution_code from justice.courts co where co.court_level in (${sql.join(
    levels.map((l) => sql`${l}`),
    sql`, `
  )}))`;
};

/** Compile the `year` virtual into a half-open source_opened_at range. */
const yearCond = (input: FilterInput): RawBuilder<unknown> | null => {
  const b = yearBounds(fieldOf(input, 'year'));
  if (b === null) return null;
  const parts: RawBuilder<unknown>[] = [];
  if (b.from !== null) parts.push(sql`c.source_opened_at >= make_date(${b.from}, 1, 1)`);
  if (b.to !== null) parts.push(sql`c.source_opened_at < make_date(${b.to + 1}, 1, 1)`);
  if (parts.length === 0) return null;
  return sql.join(parts, sql` and `);
};

/**
 * True if the filter carries a REAL court/period bound (the §7.1 rule). An empty
 * value (`courtLevel:{in:[]}`, `year:{between:{}}`, `modified:{between:{}}`) does
 * NOT count — it compiles to no predicate, so it must not masquerade as a bound
 * (codex P1).
 */
const hasBound = (input: FilterInput): boolean => {
  const inst = inStrings(fieldOf(input, 'institutionCode'));
  if (inst !== undefined && inst.length > 0) return true;
  const levels = inStrings(fieldOf(input, 'courtLevel'));
  if (levels !== undefined && levels.length > 0) return true;
  if (yearBounds(fieldOf(input, 'year')) !== null) return true;
  if (hasRangeBound(fieldOf(input, 'modified'))) return true;
  return false;
};

/** Build the full WHERE: kernel-composed (non-virtual) + the two virtual conditions. */
const buildCaseConditions = (input: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
  const built = toConditionBuilders(judicialCasesSpec, input);
  if (built.isErr()) return err(built.error);
  const conds: RawBuilder<unknown>[] = [...built.value];
  const lvl = courtLevelCond(input);
  if (lvl !== null) conds.push(lvl);
  const yr = yearCond(input);
  if (yr !== null) conds.push(yr);
  return ok(conds);
};

export const makeJudicialCaseRepo = (db: Db): JudicialCaseRepo => {
  const getById = async (caseId: string): Promise<Result<JudicialCase | null, ApiError>> => {
    if (!/^\d+$/u.test(caseId)) return ok(null);
    try {
      const r =
        await sql<CaseRow>`select ${CASE_SELECT} from justice.cases c where c.case_id = ${caseId}::bigint limit 1`.execute(
          db
        );
      const row = r.rows[0];
      return ok(row === undefined ? null : mapCase(row));
    } catch (error) {
      return err(databaseError('cases.getById failed', error));
    }
  };

  const getByNaturalKey = async (
    institutionCode: string,
    caseNumber: string
  ): Promise<Result<JudicialCase | null, ApiError>> => {
    try {
      const r = await sql<CaseRow>`
        select ${CASE_SELECT} from justice.cases c
        where c.institution_code = ${institutionCode} and c.case_number = ${caseNumber}
        limit 1
      `.execute(db);
      const row = r.rows[0];
      return ok(row === undefined ? null : mapCase(row));
    } catch (error) {
      return err(databaseError('cases.getByNaturalKey failed', error));
    }
  };

  const listCursor = async (
    opts: CaseListOptions
  ): Promise<Result<CursorPage<JudicialCase>, ApiError>> => {
    if (!hasBound(opts.filter)) {
      return err(invalidInput('judicial case list requires a court or period bound', 'filter'));
    }
    const limit = clampLimit(opts.page.first, MAX_LIST);
    const fhash = fhashFor(judicialCasesSpec, opts.filter);
    const sortInfo = SORT_EXPR[opts.sort];

    let cursorVal: string | undefined;
    let cursorCaseId: string | undefined;
    if (opts.page.after !== undefined) {
      const decoded = decodeCursor(opts.page.after, { sort: opts.sort, dir: opts.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorVal = decoded.value.keys[0];
      cursorCaseId = decoded.value.keys[1];
    }

    const condsRes = buildCaseConditions(opts.filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const conds = condsRes.value;
    if (cursorVal !== undefined && cursorCaseId !== undefined) {
      conds.push(keysetCursor(sortInfo.expr, sortInfo.cast, cursorVal, cursorCaseId, opts.dir));
    }
    const where = composeWhere(conds);
    const orderBy =
      opts.dir === 'desc'
        ? sql`order by ${sortInfo.expr} desc nulls last, c.case_id desc`
        : sql`order by ${sortInfo.expr} asc nulls last, c.case_id asc`;

    try {
      const result = await sql<CaseRow>`
        select ${CASE_SELECT} from justice.cases c
        where ${where}
        ${orderBy}
        limit ${limit + 1}
      `.execute(db);
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(mapCase);
      let next: string | null = null;
      if (hasMore) {
        const last = items[items.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: opts.sort,
            dir: opts.dir,
            fhash,
            lastKeys: [sortValueOf(last, opts.sort), last.caseId],
          });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('cases.listCursor failed', error));
    }
  };

  const aggregate = async (
    opts: CaseAggregateOptions
  ): Promise<Result<JudicialCaseAggregate, ApiError>> => {
    if (!hasBound(opts.filter)) {
      return err(
        invalidInput('judicial caseload aggregate requires a court or period bound', 'filter')
      );
    }
    const condsRes = buildCaseConditions(opts.filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);

    // The group key expression per dimension. courtLevel needs the courts join.
    const needsCourtJoin = opts.groupBy === 'court' || opts.groupBy === 'courtLevel';
    const keyExpr: RawBuilder<unknown> =
      opts.groupBy === 'court'
        ? sql`c.institution_code`
        : opts.groupBy === 'courtLevel'
          ? sql`co.court_level`
          : opts.groupBy === 'category'
            ? sql`c.category`
            : sql`date_part('year', c.source_opened_at)::int::text`;
    const labelExpr: RawBuilder<unknown> =
      opts.groupBy === 'category' ? sql`max(c.category_name)` : sql`null::text`;
    const fromClause = needsCourtJoin
      ? sql`justice.cases c left join justice.courts co on co.institution_code = c.institution_code`
      : sql`justice.cases c`;

    try {
      // Groups (top AGG_GROUP_CAP by count) AND the TRUE denominator/named totals
      // over the WHOLE bounded set — computed independently of the group cap so a
      // >500-group result still reports the correct denominator/coverage (codex P1).
      const [result, totals] = await Promise.all([
        sql<{ key: string | null; label: string | null; cnt: string }>`
          select ${keyExpr} as key, ${labelExpr} as label, count(*)::text as cnt
          from ${fromClause}
          where ${where}
          group by ${keyExpr}
          order by count(*) desc
          limit ${AGG_GROUP_CAP}
        `.execute(db),
        sql<{ total: string; named: string }>`
          select count(*)::text as total,
                 count(*) filter (where ${keyExpr} is not null)::text as named
          from ${fromClause}
          where ${where}
        `.execute(db),
      ]);
      const groups: JudicialAggregateGroup[] = result.rows.map((r) => ({
        key: r.key ?? '(none)',
        label: r.label,
        caseCount: Number(r.cnt),
      }));
      const denominator = Number(totals.rows[0]?.total ?? 0);
      const named = Number(totals.rows[0]?.named ?? 0);
      // coverage = share of the bounded set carried by named (non-null-key) groups.
      const coverage = denominator === 0 ? 0 : named / denominator;
      return ok({ groups, denominator, coverage });
    } catch (error) {
      return err(databaseError('cases.aggregate failed', error));
    }
  };

  const getAsOf = async (): Promise<Result<JudicialAsOf, ApiError>> => {
    try {
      const r = await sql<{ as_of: string | null }>`
        select max(c.latest_source_modified_at) as as_of from justice.cases c
      `.execute(db);
      const asOf = r.rows[0]?.as_of ?? null;
      return ok({ asOf: asOf === null ? null : new Date(asOf).toISOString(), estimated: true });
    } catch (error) {
      return err(databaseError('cases.getAsOf failed', error));
    }
  };

  return { getById, getByNaturalKey, listCursor, aggregate, getAsOf };
};
