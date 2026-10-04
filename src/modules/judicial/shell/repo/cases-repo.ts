/**
 * Judicial module — cases repo (plan 08 §4). Reads `justice.cases` (+ a bounded
 * join to `justice.courts` for the `courtLevel` virtual + aggregate). NO PII:
 * `justice.cases` has no name column; `object` is the procedural subject, safe.
 *
 * BOUNDING RULE (§7.1): the case list + aggregate REQUIRE a court/period bound
 * (institutionCode | courtLevel | year* | modified*). An unbounded request over
 * the 6.16M-row table is `InvalidInput`. The `courtLevel` and `year` filter fields
 * are VIRTUAL (no native column) — the repo compiles them here.
 *
 * TIMESTAMPS (A1): the stored `timestamptz` columns are unrestricted (BC, expanded
 * years, ±infinity are all legal), so nothing here converts them through a JS
 * Date. Display text is rendered in SQL; the cursor carries a separate EXACT
 * value (full microseconds, explicit era, ±infinity) that casts back to the
 * identical native timestamp, built by this repo from each returned row.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { decodeOpaqueJson } from '@/common/canonical-json/index.js';
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
import { exactTimestampText, sessionDateDisplay, utcTimestampDisplay } from './temporal-sql.js';
import {
  sourceOpenedAtBasisFor,
  type JudicialAggregateGroup,
  type JudicialAsOf,
  type JudicialCase,
  type JudicialCaseAggregate,
  type JudicialCursorItem,
} from '../../core/types.js';
import { judicialCasesSpec } from '../filters/judicial.spec.js';

import type { CaseAggregateOptions, CaseListOptions, JudicialCaseRepo } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const MAX_LIST = 50;
const AGG_GROUP_CAP = 500;

const CASE_SELECT = sql`
  c.case_id::text as case_id, c.source_slug, c.institution_code, c.case_number,
  c.case_number_old, c.department, c.category, c.category_name, c.stage, c.stage_name,
  c.object, ${sessionDateDisplay(sql`c.source_opened_at`)} as source_opened_at,
  ${utcTimestampDisplay(sql`c.latest_source_modified_at`)} as latest_source_modified_at
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

/** A list row: the case plus its exact sort value (cursor only; never on the node). */
interface CaseListRow extends CaseRow {
  sort_key: string | null;
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
  sourceOpenedAtBasis: sourceOpenedAtBasisFor(r.source_slug),
  latestSourceModifiedAt: r.latest_source_modified_at,
});

/** The native timestamptz column behind each named case sort (ordering + keyset). */
const SORT_EXPR: Record<'modifiedAt' | 'openedAt', RawBuilder<unknown>> = {
  modifiedAt: sql`c.latest_source_modified_at`,
  openedAt: sql`c.source_opened_at`,
};

// ── cursor identity + validation ───────────────────────────────────────────────

/**
 * Module-local case-cursor format tag, folded into the filter identity. Earlier
 * case cursors carried a lossy date/millisecond display value, so they all fail
 * the identity check → typed InvalidInput "restart pagination" (a one-time
 * restart). The kernel envelope version stays 1.
 */
const CASE_CURSOR_FORMAT = 'judicial_cases:cursor-v2';
const caseCursorFhash = (filter: FilterInput): string =>
  `${CASE_CURSOR_FORMAT}:${fhashFor(judicialCasesSpec, filter)}`;

const malformedCursor = (): ApiError =>
  invalidInput('malformed cursor; restart pagination', 'cursor');

const ONE_STRING_KEY = Type.Object({ keys: Type.Tuple([Type.String()]) });
const TWO_STRING_KEYS = Type.Object({ keys: Type.Tuple([Type.String(), Type.String()]) });

type KeyCheck = (key: string) => boolean;

/**
 * Decode a judicial cursor, rejecting anything non-canonical BEFORE any SQL:
 * (1) safe base64url-JSON decode; (2) the ORIGINAL keys are exactly one/two JSON
 * strings (the kernel decoder coerces keys with String(), which would admit
 * nulls, objects, or numbers already rounded past 2^53); (3) the unchanged kernel
 * envelope + sort/dir/filter-identity check; (4) every key passes its canonical
 * check. Every failure is InvalidInput with restart guidance.
 */
export const decodeJudicialCursor = (
  raw: string,
  expected: { sort: string; dir: 'asc' | 'desc'; fhash: string },
  checks: readonly [KeyCheck] | readonly [KeyCheck, KeyCheck]
): Result<readonly string[], ApiError> => {
  const decoded = decodeOpaqueJson(raw);
  if (decoded.isErr()) return err(malformedCursor());
  const shape = checks.length === 1 ? ONE_STRING_KEY : TWO_STRING_KEYS;
  if (!Value.Check(shape, decoded.value)) return err(malformedCursor());
  const envelope = decodeCursor(raw, expected);
  if (envelope.isErr()) return err(envelope.error);
  const keys = envelope.value.keys;
  if (keys.length !== checks.length) return err(malformedCursor());
  for (const [index, check] of checks.entries()) {
    if (!check(keys[index] ?? '')) return err(malformedCursor());
  }
  return ok(keys);
};

const BIGINT_TEXT_RE = /^(?:0|-?[1-9][0-9]{0,18})$/u;
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

/** Canonical signed-bigint text (no `-0`, no leading zeros), range-checked without Number. */
export const isCanonicalBigintText = (text: string): boolean => {
  if (!BIGINT_TEXT_RE.test(text)) return false;
  const value = BigInt(text);
  return value >= BIGINT_MIN && value <= BIGINT_MAX;
};

// PostgreSQL's finite timestamptz range, pinned on Zeus PG 18.4
// (api-temporal-boundary-qualification.json): 4714-11-24 00:00:00 BC through
// 294276-12-31 23:59:59.999999 AD; year 0 does not exist.
const MIN_BC_YEAR = 4714;
const MIN_BC_MONTH = 11;
const MIN_BC_DAY = 24;
const MAX_AD_YEAR = 294_276;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const EXACT_TIMESTAMP_RE =
  /^(?<year>[0-9]{4,6})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})\.[0-9]{6}\+00 (?<era>AD|BC)$/u;

/** Proleptic Gregorian leap rule on the astronomical year (1 BC = year 0). */
const isLeapYear = (astronomicalYear: number): boolean =>
  astronomicalYear % 4 === 0 && (astronomicalYear % 100 !== 0 || astronomicalYear % 400 === 0);

/**
 * A case cursor sort key: '' (NULL), `infinity`, `-infinity`, or EXACTLY the
 * spelling `exactTimestampText` emits for a finite value — canonical year
 * (4 digits, or 5–6 without a leading zero), a real calendar date and time,
 * six fractional digits, `+00`, an explicit era, inside PostgreSQL's range.
 */
export const isCaseSortKey = (text: string): boolean => {
  if (text === '' || text === 'infinity' || text === '-infinity') return true;
  const groups = EXACT_TIMESTAMP_RE.exec(text)?.groups;
  if (groups === undefined) return false;
  const field = (name: string): number => Number.parseInt(groups[name] ?? '', 10);
  const yearText = groups['year'] ?? '';
  if (yearText.length > 4 && yearText.startsWith('0')) return false;
  const year = field('year');
  const bc = groups['era'] === 'BC';
  if (year < 1 || year > (bc ? MIN_BC_YEAR : MAX_AD_YEAR)) return false;
  const month = field('month');
  const day = field('day');
  const monthDays = DAYS_IN_MONTH[month - 1];
  if (monthDays === undefined) return false;
  const leapDay = month === 2 && isLeapYear(bc ? 1 - year : year) ? 1 : 0;
  if (day < 1 || day > monthDays + leapDay) return false;
  if (
    bc &&
    year === MIN_BC_YEAR &&
    (month < MIN_BC_MONTH || (month === MIN_BC_MONTH && day < MIN_BC_DAY))
  ) {
    return false;
  }
  return field('hour') <= 23 && field('minute') <= 59 && field('second') <= 59;
};

/**
 * Compile the `courtLevel` virtual into an `institution_code IN (subquery)` over
 * justice.courts (bounded by the small court reference). Returns null when absent.
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
  ): Promise<Result<CursorPage<JudicialCursorItem<JudicialCase>>, ApiError>> => {
    if (!hasBound(opts.filter)) {
      return err(invalidInput('judicial case list requires a court or period bound', 'filter'));
    }
    const limit = clampLimit(opts.page.first, MAX_LIST);
    const fhash = caseCursorFhash(opts.filter);
    const sortExpr = SORT_EXPR[opts.sort];

    let after: readonly string[] | undefined;
    if (opts.page.after !== undefined) {
      const decoded = decodeJudicialCursor(
        opts.page.after,
        { sort: opts.sort, dir: opts.dir, fhash },
        [isCaseSortKey, isCanonicalBigintText]
      );
      if (decoded.isErr()) return err(decoded.error);
      after = decoded.value;
    }

    const condsRes = buildCaseConditions(opts.filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const conds = condsRes.value;
    if (after !== undefined) {
      // The exact sort value casts back to the identical native timestamp; the
      // id compares ::bigint. NULLS LAST in both directions (keysetCursor).
      conds.push(keysetCursor(sortExpr, 'date', after[0] ?? '', after[1] ?? '', opts.dir));
    }
    const where = composeWhere(conds);
    const orderBy =
      opts.dir === 'desc'
        ? sql`order by ${sortExpr} desc nulls last, c.case_id desc`
        : sql`order by ${sortExpr} asc nulls last, c.case_id asc`;

    try {
      const result = await sql<CaseListRow>`
        select ${CASE_SELECT}, ${exactTimestampText(sortExpr)} as sort_key
        from justice.cases c
        where ${where}
        ${orderBy}
        limit ${limit + 1}
      `.execute(db);
      // Every item's cursor comes from ITS row's exact (sort value, id) tuple;
      // `next` is the last returned item's cursor when more rows exist.
      const items: JudicialCursorItem<JudicialCase>[] = result.rows.slice(0, limit).map((row) => ({
        node: mapCase(row),
        cursor: buildNextCursor({
          sort: opts.sort,
          dir: opts.dir,
          fhash,
          lastKeys: [row.sort_key, row.case_id],
        }),
      }));
      const next = result.rows.length > limit ? (items[items.length - 1]?.cursor ?? null) : null;
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

  const getAsOf = async (sourceSlug: string): Promise<Result<JudicialAsOf, ApiError>> => {
    try {
      // The stored MAX of ONE source (A2): a parameterized source filter, never
      // a global maximum borrowed across sources. Rendered in SQL (A1) so an
      // exceptional maximum (BC, expanded year, infinity) stays explicit text; a
      // source with no stored modification time yields NULL.
      const r = await sql<{ as_of: string | null }>`
        select ${utcTimestampDisplay(sql`m.max_modified`)} as as_of
        from (
          select max(c.latest_source_modified_at) as max_modified
          from justice.cases c
          where c.source_slug = ${sourceSlug}
        ) m
      `.execute(db);
      return ok({
        asOf: r.rows[0]?.as_of ?? null,
        estimated: true,
        sourceSlug,
        basis: 'max_stored_source_modified_at',
        // Not established by any stored evidence yet (A2): honest unknowns.
        captureFreshnessAt: null,
        loadFreshnessAt: null,
      });
    } catch (error) {
      return err(databaseError('cases.getAsOf failed', error));
    }
  };

  return { getById, getByNaturalKey, listCursor, aggregate, getAsOf };
};
