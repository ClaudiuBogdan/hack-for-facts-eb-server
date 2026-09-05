/**
 * Legacy `executionAnalytics` aggregate over `budget.execution_line_items`
 * (docs/server-redesign/13 §3 rule 3: the fact path, pruning triple per period
 * year; an omitted `report_type` sums ALL SUPPORTED execution report types
 * through a parameterized `IN` over the three L2 partition literals).
 *
 * Port of the legacy `KyselyAnalyticsRepo.getAggregatedSeries` +
 * `infra/database/query-filters/*` builders onto the Chronos columns:
 *   year→reporting_year · month→reporting_month · quarter→quarter ·
 *   amount by frequency: MONTH→monthly_amount WHERE is_monthly,
 *   QUARTER→quarterly_amount WHERE is_quarterly, YEAR→ytd_amount WHERE is_yearly ·
 *   entities→core.public_entities (cui) · uats→core.territories via
 *   public_entities.territory_id · uat_id→core.territories.id ·
 *   funding_source_ids: phoenix ordinal → stored id via v_funding_sources_compat.
 *
 * Verified live 2026-09-02 (y2025_rt1_ch): 0 rows with `not is_monthly and
 * monthly_amount <> 0`, so the `is_monthly` predicate (legacy MONTH had no flag)
 * is sum-equivalent and selects the partial period-scope index.
 *
 * Every user value is a bound parameter (Kysely `sql` templates; `sql.ref` for
 * the trusted column names). No `sql.raw`. Statement timeout 30 s (legacy
 * `QUERY_TIMEOUT_MS`) via `SET LOCAL` inside a read transaction — the kernel
 * pool default is 15 s. The 10,000-point cap fetches one row over and reports
 * `capped` (the usecase logs it) instead of truncating silently.
 *
 * Intentional deltas from legacy (manifest "fix the bugs, document every
 * difference"):
 *  - `aggregate_min/max_amount` applied as HAVING on the period sum (legacy ignored);
 *  - all 16 `exclude.*` fields applied — main_creditor_cui, funding_source_ids,
 *    budget_sector_ids, expense_types, program_codes were ignored;
 *  - every exclusion on a NULLABLE column is NULL-safe (`col IS NULL OR col NOT IN`):
 *    legacy `economic_code NOT IN (…)` silently dropped NULL-economic-code rows
 *    (measured: 0 such rows in y2025_rt1_ch, so no live delta on expense);
 *  - `exclude.regions` alone works (legacy joined uats without entities → SQL error);
 *  - omitted `report_type` (codex 2026-09-02 finding 3): legacy emitted NO
 *    report_type predicate (`infra/database/query-filters/dimension-filter.ts:38-39`
 *    only when set) and summed whatever the phoenix table held. Here the omitted
 *    case is `report_type IN (<the three supported execution literals>)` — the
 *    same rows on today's data (the `_default` partitions are empty), but the
 *    planner prunes to the `_rtN_<cat>` leaves only, and an unexpected report
 *    type landing in a `_default` leaf is never summed into a chart silently.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  andConditions,
  databaseError,
  escapeLike,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { FUNDING_SOURCE_NO_MATCH } from './filter-helpers.js';
import { makeFundingSourceMap, type FundingSourceMapLoader } from './funding-source-map.js';
import { legacyEntityConditions } from './legacy-entity-predicates.js';
import {
  EXECUTION_AMOUNT_COLUMN,
  EXECUTION_REPORT_TYPE_LABELS,
  EXECUTION_REPORT_TYPES,
  FREQUENCY_FLAG_COLUMN,
} from '../../core/constants.js';
import {
  LEGACY_ANALYTICS_MAX_POINTS,
  type LegacyAggregateResult,
  type LegacyExecutionAggregateRepo,
} from '../../core/legacy-analytics/ports.js';

import type { LegacyAggregateQuery, LegacyFrequency } from '../../core/legacy-analytics/types.js';

type Db = Kysely<ProdDatabase>;
type Cond = RawBuilder<unknown>;

/** Legacy `QUERY_TIMEOUT_MS` (30 s). Static SQL text — SET LOCAL takes no bind. */
const STATEMENT_TIMEOUT_SQL = sql`set local statement_timeout = 30000`;

/**
 * The L2 partition literals an omitted `report_type` expands to: the three
 * supported execution report types (`EXECUTION_REPORT_TYPES`), so the planner
 * prunes to the `_rt1|_rt2|_rt3` × `<account_category>` leaves and never scans
 * a `_default` leaf.
 */
export const ALL_EXECUTION_REPORT_TYPE_LITERALS: readonly string[] = EXECUTION_REPORT_TYPES.map(
  (e) => EXECUTION_REPORT_TYPE_LABELS[e]
);

interface AggregatedRow {
  year: number;
  period_value: number;
  amount: string;
}

const periodColumn = (frequency: LegacyFrequency): RawBuilder<unknown> =>
  frequency === 'MONTH'
    ? sql.ref('eli.reporting_month')
    : frequency === 'QUARTER'
      ? sql.ref('eli.quarter')
      : sql.ref('eli.reporting_year');

const amountColumn = (frequency: LegacyFrequency): RawBuilder<unknown> =>
  sql.ref(`eli.${EXECUTION_AMOUNT_COLUMN[frequency]}`);

const flagColumn = (frequency: LegacyFrequency): RawBuilder<unknown> =>
  sql.ref(`eli.${FREQUENCY_FLAG_COLUMN[frequency]}`);

const inList = (col: RawBuilder<unknown>, values: readonly (string | number)[]): Cond =>
  sql`${col} in (${sql.join(values)})`;

const notInNullSafe = (col: RawBuilder<unknown>, values: readonly (string | number)[]): Cond =>
  sql`(${col} is null or ${col} not in (${sql.join(values)}))`;

const anyPrefix = (col: RawBuilder<unknown>, prefixes: readonly string[]): Cond =>
  sql`(${sql.join(
    prefixes.map((p) => sql`${col} like ${escapeLike(p) + '%'}`),
    sql` or `
  )})`;

const noPrefixNullSafe = (col: RawBuilder<unknown>, prefixes: readonly string[]): Cond =>
  sql`(${col} is null or (${sql.join(
    prefixes.map((p) => sql`${col} not like ${escapeLike(p) + '%'}`),
    sql` and `
  )}))`;

/** Whether the query needs the entity / territory joins (only when a predicate uses them). */
export const legacyJoinNeeds = (
  q: LegacyAggregateQuery
): { readonly entity: boolean; readonly territory: boolean } => {
  const ex = q.exclude;
  const territory =
    q.uatIds !== undefined ||
    q.countyCodes !== undefined ||
    q.regions !== undefined ||
    q.minPopulation !== undefined ||
    q.maxPopulation !== undefined ||
    ex?.uatIds !== undefined ||
    ex?.countyCodes !== undefined ||
    ex?.regions !== undefined;
  const entity =
    territory ||
    q.entityTypes !== undefined ||
    q.isUat !== undefined ||
    q.isTerritorialExecutive !== undefined ||
    q.search !== undefined ||
    q.tagFacets !== undefined ||
    ex?.entityTypes !== undefined ||
    ex?.tags !== undefined;
  return { entity, territory };
};

/** Build the WHERE conditions (order: pruning triple first, then the rest). */
export const legacyAggregateConditions = (
  q: LegacyAggregateQuery,
  toStoredFundingId: (publicId: number) => number | undefined
): Cond[] => {
  const conds: Cond[] = [];
  const year = sql.ref('eli.reporting_year');
  const period = periodColumn(q.frequency);
  const amount = amountColumn(q.frequency);

  // ── §0.3 pruning: L1 year(s), L2 report_type (literal, or IN over the three
  //    supported literals when omitted), L3 account_category ──
  if ('in' in q.period.years) conds.push(inList(year, q.period.years.in));
  else conds.push(sql`${year} between ${q.period.years.from} and ${q.period.years.to}`);
  const reportType = sql.ref('eli.report_type');
  if (q.reportType !== null) conds.push(sql`${reportType} = ${q.reportType}`);
  else conds.push(inList(reportType, ALL_EXECUTION_REPORT_TYPE_LITERALS));
  conds.push(sql`${sql.ref('eli.account_category')} = ${q.accountCategory}`);
  conds.push(sql`${flagColumn(q.frequency)} = true`);

  // ── period tuple / year-range / date-list predicates (legacy buildPeriodConditions) ──
  const p = q.period;
  if (p.tupleRange !== undefined) {
    conds.push(
      sql`(${year}, ${period}) >= (${p.tupleRange.start.year}, ${p.tupleRange.start.sub})`
    );
    conds.push(sql`(${year}, ${period}) <= (${p.tupleRange.end.year}, ${p.tupleRange.end.sub})`);
  }
  if (p.tupleList !== undefined) {
    conds.push(
      sql`(${sql.join(
        p.tupleList.map((t) => sql`(${year} = ${t.year} and ${period} = ${t.sub})`),
        sql` or `
      )})`
    );
  }
  if (p.yearList !== undefined) conds.push(inList(year, p.yearList));

  // ── dimensions (legacy buildDimensionConditions) ──
  if (q.mainCreditorCui !== undefined) {
    conds.push(sql`${sql.ref('eli.main_creditor_cui')} = ${q.mainCreditorCui}`);
  }
  if (q.reportIds !== undefined) conds.push(inList(sql.ref('eli.report_id'), q.reportIds));
  if (q.fundingSourceIds !== undefined) {
    // PUBLIC (phoenix ordinal) → STORED id; an unknown public id selects nothing.
    const stored = q.fundingSourceIds.map((id) => toStoredFundingId(id) ?? FUNDING_SOURCE_NO_MATCH);
    conds.push(inList(sql.ref('eli.funding_source_id'), stored));
  }
  if (q.budgetSectorIds !== undefined) {
    conds.push(inList(sql.ref('eli.budget_sector_id'), q.budgetSectorIds));
  }
  if (q.expenseTypes !== undefined) conds.push(inList(sql.ref('eli.expense_type'), q.expenseTypes));

  // ── classification codes (legacy buildCodeConditions) ──
  const functional = sql.ref('eli.functional_code');
  const economic = sql.ref('eli.economic_code');
  if (q.functionalCodes !== undefined) conds.push(inList(functional, q.functionalCodes));
  if (q.functionalPrefixes !== undefined) conds.push(anyPrefix(functional, q.functionalPrefixes));
  if (q.economicCodes !== undefined) conds.push(inList(economic, q.economicCodes));
  if (q.economicPrefixes !== undefined) conds.push(anyPrefix(economic, q.economicPrefixes));
  if (q.programCodes !== undefined) conds.push(inList(sql.ref('eli.program_code'), q.programCodes));

  conds.push(...legacyEntityConditions(q, 'eli.entity_cui'));

  // ── row-level amount thresholds (legacy buildAmountConditions) ──
  if (q.itemMinAmount !== undefined) conds.push(sql`${amount} >= ${q.itemMinAmount}::numeric`);
  if (q.itemMaxAmount !== undefined) conds.push(sql`${amount} <= ${q.itemMaxAmount}::numeric`);

  // ── exclusions (legacy buildExclusionConditions + the 5 previously ignored) ──
  const ex = q.exclude;
  if (ex !== undefined) {
    if (ex.reportIds !== undefined) {
      conds.push(sql`${sql.ref('eli.report_id')} not in (${sql.join(ex.reportIds)})`);
    }
    if (ex.mainCreditorCui !== undefined) {
      const col = sql.ref('eli.main_creditor_cui');
      conds.push(sql`(${col} is null or ${col} <> ${ex.mainCreditorCui})`);
    }
    if (ex.functionalCodes !== undefined) {
      conds.push(sql`${functional} not in (${sql.join(ex.functionalCodes)})`);
    }
    if (ex.functionalPrefixes !== undefined) {
      conds.push(
        sql`(${sql.join(
          ex.functionalPrefixes.map((p) => sql`${functional} not like ${escapeLike(p) + '%'}`),
          sql` and `
        )})`
      );
    }
    // Economic exclusions apply to the expense side only (legacy: `accountCategory !== 'vn'`).
    if (q.accountCategory !== 'vn') {
      if (ex.economicCodes !== undefined) conds.push(notInNullSafe(economic, ex.economicCodes));
      if (ex.economicPrefixes !== undefined) {
        conds.push(noPrefixNullSafe(economic, ex.economicPrefixes));
      }
    }
    if (ex.fundingSourceIds !== undefined) {
      // Unknown public ids exclude nothing (there is no stored row to exclude).
      const stored = ex.fundingSourceIds
        .map(toStoredFundingId)
        .filter((id): id is number => id !== undefined);
      if (stored.length > 0) {
        conds.push(sql`${sql.ref('eli.funding_source_id')} not in (${sql.join(stored)})`);
      }
    }
    if (ex.budgetSectorIds !== undefined) {
      conds.push(sql`${sql.ref('eli.budget_sector_id')} not in (${sql.join(ex.budgetSectorIds)})`);
    }
    if (ex.expenseTypes !== undefined) {
      conds.push(notInNullSafe(sql.ref('eli.expense_type'), ex.expenseTypes));
    }
    if (ex.programCodes !== undefined) {
      conds.push(notInNullSafe(sql.ref('eli.program_code'), ex.programCodes));
    }
  }

  return conds;
};

/** HAVING on the period sum — `aggregate_min/max_amount` (legacy ignored; applied here). */
const havingClause = (q: LegacyAggregateQuery): RawBuilder<unknown> => {
  const total = sql`coalesce(sum(${amountColumn(q.frequency)}), 0)`;
  const parts: Cond[] = [];
  if (q.aggregateMinAmount !== undefined)
    parts.push(sql`${total} >= ${q.aggregateMinAmount}::numeric`);
  if (q.aggregateMaxAmount !== undefined)
    parts.push(sql`${total} <= ${q.aggregateMaxAmount}::numeric`);
  if (parts.length === 0) return sql``;
  return sql`having ${sql.join(parts, sql` and `)}`;
};

/** The full aggregate statement (exported so tests can EXPLAIN the real SQL). */
export const legacyAggregateSql = (
  q: LegacyAggregateQuery,
  toStoredFundingId: (publicId: number) => number | undefined
): RawBuilder<AggregatedRow> => {
  const year = sql.ref('eli.reporting_year');
  const period = periodColumn(q.frequency);
  const amount = amountColumn(q.frequency);
  const joins = legacyJoinNeeds(q);
  const entityJoin = joins.entity
    ? sql`left join core.public_entities as e on e.cui = eli.entity_cui`
    : sql``;
  const territoryJoin = joins.territory
    ? sql`left join core.territories as t on t.id = e.territory_id`
    : sql``;
  const where = andConditions(legacyAggregateConditions(q, toStoredFundingId));
  // YEAR: the period column IS the year (legacy grouped by year alone).
  const groupBy = q.frequency === 'YEAR' ? sql`${year}` : sql`${year}, ${period}`;
  const orderBy = q.frequency === 'YEAR' ? sql`${year} asc` : sql`${year} asc, ${period} asc`;
  return sql<AggregatedRow>`
    select
      ${year} as year,
      ${period} as period_value,
      coalesce(sum(${amount}), 0)::text as amount
    from budget.execution_line_items as eli
    ${entityJoin}
    ${q.search === undefined ? sql`` : sql`left join core.organizations as o on o.cui = eli.entity_cui`}
    ${territoryJoin}
    where ${where}
    group by ${groupBy}
    ${havingClause(q)}
    order by ${orderBy}
    limit ${LEGACY_ANALYTICS_MAX_POINTS + 1}
  `;
};

const isStatementTimeout = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014') return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes('statement timeout');
};

export interface LegacyAnalyticsRepoOptions {
  /** Injectable for tests; defaults to the compat-view loader over `db`. */
  readonly fundingSourceMap?: FundingSourceMapLoader;
}

export const makeLegacyAnalyticsRepo = (
  db: Db,
  options?: LegacyAnalyticsRepoOptions
): LegacyExecutionAggregateRepo => {
  const fundingSourceMap = options?.fundingSourceMap ?? makeFundingSourceMap(db);

  const legacyExecutionAggregate = async (
    q: LegacyAggregateQuery
  ): Promise<Result<LegacyAggregateResult, ApiError>> => {
    try {
      const needsFundingMap =
        q.fundingSourceIds !== undefined || q.exclude?.fundingSourceIds !== undefined;
      const toStoredId = needsFundingMap
        ? (await fundingSourceMap.load()).toStoredId
        : (): number | undefined => undefined;
      const statement = legacyAggregateSql(q, toStoredId);

      const rows = await db.transaction().execute(async (trx) => {
        await STATEMENT_TIMEOUT_SQL.execute(trx);
        return (await statement.execute(trx)).rows;
      });

      const capped = rows.length > LEGACY_ANALYTICS_MAX_POINTS;
      const kept = capped ? rows.slice(0, LEGACY_ANALYTICS_MAX_POINTS) : rows;
      return ok({
        rows: kept.map((r) => ({ year: r.year, periodValue: r.period_value, amount: r.amount })),
        capped,
      });
    } catch (error) {
      if (isStatementTimeout(error)) {
        return err(timeoutError('Analytics query timed out'));
      }
      return err(
        databaseError(
          `Analytics query failed: ${error instanceof Error ? error.message : String(error)}`,
          error
        )
      );
    }
  };

  return { legacyExecutionAggregate };
};
