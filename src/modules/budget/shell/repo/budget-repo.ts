/**
 * Budget module — repository over the live `budget.*` schema (plan §3).
 *
 * The ONLY place that reads `budget.*`. Reads through the kernel's typed Kysely
 * instance (`Kysely<ProdDatabase>` augmented by `shell/db/schema.ts`). Two
 * load-bearing invariants:
 *
 *  1. PARTITION PRUNING (§0.3): every FACT query supplies the literals
 *     `(reporting_year, report_type, account_category)` (commitments: the pair) as
 *     the FIRST predicates so the planner prunes to ONE leaf. Clean enums are
 *     mapped to partition literals here (constants.ts); the literal NEVER leaks to
 *     the surface but the SQL always uses it. `resolveExecutionGate` enforces it,
 *     and the gate fields are repo-intercepted (the kernel composer never compiles
 *     them with the clean-enum value — the R1 review fix).
 *  2. MV-FIRST ROLLUP (§0.4): summaries/rankings/timeseries/heatmap read the 6 MVs,
 *     never the 126M fact rows. The execution MVs pre-pivot vn/ch into
 *     total_income/total_expense/budget_balance, so an MV read filters only on
 *     (year, report_type) and picks the COLUMN from the metric — NO
 *     `account_category` predicate (it does not exist on the MV).
 *
 * Money is `::text` at the SQL boundary (precision-safe strings, never floats);
 * bigint ids stay strings. Cursor lists use the kernel envelope; the `fhash` binds
 * the cursor to the active filter set (§14.3). No COUNT(*) on the fact tables.
 * Transfer exclusions are baked into the MVs — NEVER re-applied on MV reads.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
  type SourcePresence,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  normalizeCui,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { factorCaseExpr, isPerCapita, yearMultiplier } from './analytics.js';
import {
  fieldOf,
  intIn,
  omitFields,
  prepareFundingFactFilter,
  resolveCommitmentGate,
  resolveExecutionGate,
  type CommitmentGate,
  type ExecutionGate,
} from './filter-helpers.js';
import { makeFundingSourceMap, type FundingSourceMap } from './funding-source-map.js';
import {
  commitReportType,
  execReportType,
  mapApprovedFact,
  mapClassification,
  mapCommitmentLineItem,
  mapExecutionLineItem,
  mapFundingSource,
  mapReport,
  mapSector,
  type CommitmentRow,
  type ExecutionRow,
  type ReportRow,
} from './mappers.js';
import {
  ACCOUNT_CATEGORY_LABELS,
  BUDGET_TRANSFER_EXCLUSIONS,
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_AMOUNT_COLUMN,
  EXECUTION_REPORT_TYPE_LABELS,
  FREQUENCY_FLAG_COLUMN,
  type AccountCategory,
  type BudgetFrequency,
  type ExecutionReportType,
} from '../../core/constants.js';
import {
  BUDGET_COMMITMENT_VIRTUAL_FIELDS,
  BUDGET_FACT_VIRTUAL_FIELDS,
  budgetApprovedFactFilterSpec,
  budgetCommitmentFactFilterSpec,
  budgetCommitmentFactKernelSpec,
  budgetFactFilterSpec,
  budgetFactKernelSpec,
  budgetReportFilterSpec,
} from '../../core/filters.js';

import type { BudgetRepo } from '../../core/ports.js';
import type {
  AggregatedBudgetRow,
  ApprovedBudgetFact,
  BudgetAsOf,
  BudgetClassification,
  BudgetCommitmentFactQuery,
  BudgetEntitySummary,
  BudgetFactQuery,
  BudgetFundingSource,
  BudgetProfileSlice,
  BudgetReport,
  BudgetSector,
  BudgetSeriesPoint,
  BudgetVsExecutionRow,
  ClassificationAggregateQuery,
  CommitmentEntitySummary,
  CommitmentLineItem,
  CommitmentRankingQuery,
  CommitmentSummaryQuery,
  CommitmentTimeseriesQuery,
  CountyHeatmapPoint,
  EntityRankingQuery,
  ExecutionLineItem,
  GatedOffsetPage,
  HeatmapQuery,
  RankedCommitmentEntity,
  RankedEntity,
  SummaryQuery,
  TimeseriesQuery,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const FACT_LIMIT_MAX = 100;
const AGG_LIMIT_MAX = 100;
const RANK_LIMIT_MAX = 100;
const DIM_LIMIT_MAX = 200;
const OFFICIAL_PAGE_MAX = 100;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(Math.floor(n), lo), hi);

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** ASC/DESC as a SQL fragment (no `sql.raw`, which is banned in repos). */
const dirSql = (dir: 'asc' | 'desc'): RawBuilder<unknown> => (dir === 'asc' ? sql`asc` : sql`desc`);

/**
 * Resolve the execution MV table name (aliased `mv`) for a frequency. All reads
 * select from a SINGLE static type (the annual MV — its column set is the common
 * subset) and swap the runtime table via this name through `selectFrom(name)`;
 * month/quarter columns are read via dynamic `sql.ref('mv.month')` so the static
 * type never needs them. This keeps Kysely typing stable (a union of aliased
 * literals collapses the builder to `never` because the 3 MVs differ).
 */
type ExecMvName = 'budget.mv_execution_summary_annual as mv';
type CommitMvName = 'budget.mv_commitment_summary_annual as mv';

const execMvName = (freq: BudgetFrequency): ExecMvName =>
  (freq === 'MONTH'
    ? 'budget.mv_execution_summary_monthly as mv'
    : freq === 'QUARTER'
      ? 'budget.mv_execution_summary_quarterly as mv'
      : 'budget.mv_execution_summary_annual as mv') as ExecMvName;

const commitMvName = (freq: BudgetFrequency): CommitMvName =>
  (freq === 'MONTH'
    ? 'budget.mv_commitment_summary_monthly as mv'
    : freq === 'QUARTER'
      ? 'budget.mv_commitment_summary_quarterly as mv'
      : 'budget.mv_commitment_summary_annual as mv') as CommitMvName;

/** The MV money column an execution ranking/series metric selects (§0.4). */
const metricColumn = (
  m: 'INCOME' | 'EXPENSE' | 'BALANCE'
): 'total_income' | 'total_expense' | 'budget_balance' =>
  m === 'INCOME' ? 'total_income' : m === 'EXPENSE' ? 'total_expense' : 'budget_balance';

/**
 * The MONTHLY commitment MV carries ONLY these 4 cumulative metrics (+ a separate
 * `receptii_neplatite_change` delta this module does not surface). Every other
 * metric is a gap at MONTH grain and is returned as `null` — selecting it would
 * reference a non-existent column and crash (R1 review, found by both reviewers).
 */
const MONTHLY_COMMITMENT_METRICS = new Set([
  'crediteAngajament',
  'platiTrezor',
  'platiNonTrezor',
  'receptiiTotale',
]);
/** A camelCase metric is unavailable at MONTH grain iff the monthly MV lacks it. */
const monthlyCommitmentGap = (camelMetric: string): boolean =>
  !MONTHLY_COMMITMENT_METRICS.has(camelMetric);

export const makeBudgetRepo = (db: Db): BudgetRepo => {
  // ───────────────────────────────────────────────────────────────────────────
  // funding-source id translation (A1) — stored identity id ⇄ public convention id
  // ───────────────────────────────────────────────────────────────────────────

  const fundingMap = makeFundingSourceMap(db);

  /** Re-expose fact-row `fundingSourceId` as the PUBLIC (conventional) id. */
  const withPublicFunding = <T extends { readonly fundingSourceId: number }>(
    items: readonly T[],
    fm: FundingSourceMap
  ): T[] => items.map((it) => ({ ...it, fundingSourceId: fm.toPublicId(it.fundingSourceId) }));

  // ───────────────────────────────────────────────────────────────────────────
  // freshness
  // ───────────────────────────────────────────────────────────────────────────

  const asOf = async (): Promise<Result<BudgetAsOf, ApiError>> => {
    try {
      // Both reads hit the small summary MVs (NOT the 126M fact table): the
      // annual MV gives the latest loaded year; the MONTHLY MV gives the latest
      // year with 12 distinct months (the latest COMPLETE year for safe defaults).
      const row = await db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([sql<number | null>`max(mv.year)`.as('latest_year')])
        .executeTakeFirst();
      const completeResult = await sql<{ latest_complete: number | null }>`
        select max(year) as latest_complete from (
          select year, count(distinct month) as mc
          from budget.mv_execution_summary_monthly group by year
        ) y where y.mc >= 12
      `
        .execute(db)
        .catch(() => ({ rows: [] as { latest_complete: number | null }[] }));
      const latestYear = row?.latest_year ?? new Date().getFullYear();
      const latestComplete = completeResult.rows[0]?.latest_complete ?? latestYear - 1;
      return ok({
        latestLoadedYear: latestYear,
        latestCompleteYear: latestComplete,
        refreshedAt: null, // no refresh-timestamp signal in serving yet (plan §10)
      });
    } catch (error) {
      return err(databaseError('asOf failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // execution facts (FACT path)
  // ───────────────────────────────────────────────────────────────────────────

  /** The pruning-triple predicates (always FIRST; the planner prunes here). */
  const execGatePredicates = (gate: ExecutionGate, alias: string): RawBuilder<unknown>[] => {
    const yr = sql.ref(`${alias}.reporting_year`);
    const conds: RawBuilder<unknown>[] = [];
    if (gate.years.eq !== undefined) conds.push(sql`${yr} = ${gate.years.eq}`);
    if (gate.years.in !== undefined && gate.years.in.length > 0) {
      conds.push(
        sql`${yr} in (${sql.join(
          gate.years.in.map((y) => sql`${y}`),
          sql`, `
        )})`
      );
    }
    if (gate.years.from !== undefined) conds.push(sql`${yr} >= ${gate.years.from}`);
    if (gate.years.to !== undefined) conds.push(sql`${yr} <= ${gate.years.to}`);
    conds.push(sql`${sql.ref(`${alias}.report_type`)} = ${gate.reportLabel}`);
    conds.push(sql`${sql.ref(`${alias}.account_category`)} = ${gate.accountLabel}`);
    conds.push(sql`${sql.ref(`${alias}.${FREQUENCY_FLAG_COLUMN[gate.frequency]}`)} = true`);
    return conds;
  };

  const commitGatePredicates = (gate: CommitmentGate, alias: string): RawBuilder<unknown>[] => {
    const yr = sql.ref(`${alias}.reporting_year`);
    const conds: RawBuilder<unknown>[] = [];
    if (gate.years.eq !== undefined) conds.push(sql`${yr} = ${gate.years.eq}`);
    if (gate.years.in !== undefined && gate.years.in.length > 0) {
      conds.push(
        sql`${yr} in (${sql.join(
          gate.years.in.map((y) => sql`${y}`),
          sql`, `
        )})`
      );
    }
    if (gate.years.from !== undefined) conds.push(sql`${yr} >= ${gate.years.from}`);
    if (gate.years.to !== undefined) conds.push(sql`${yr} <= ${gate.years.to}`);
    conds.push(sql`${sql.ref(`${alias}.report_type`)} = ${gate.reportLabel}`);
    conds.push(sql`${sql.ref(`${alias}.${FREQUENCY_FLAG_COLUMN[gate.frequency]}`)} = true`);
    return conds;
  };

  /** Period tuple (months/quarters) predicate within the year, by frequency. */
  const periodTuple = (
    input: FilterInput,
    freq: BudgetFrequency,
    alias: string
  ): RawBuilder<unknown> | undefined => {
    if (freq === 'MONTH') {
      const months = intIn(fieldOf(input, 'months'));
      if (months !== undefined && months.length > 0) {
        return sql`${sql.ref(`${alias}.reporting_month`)} in (${sql.join(
          months.map((m) => sql`${m}`),
          sql`, `
        )})`;
      }
    } else if (freq === 'QUARTER') {
      const quarters = intIn(fieldOf(input, 'quarters'));
      if (quarters !== undefined && quarters.length > 0) {
        return sql`${sql.ref(`${alias}.quarter`)} in (${sql.join(
          quarters.map((q) => sql`${q}`),
          sql`, `
        )})`;
      }
    }
    return undefined;
  };

  /** Row-level amount range on the frequency amount column (money → exact ::numeric). */
  const amountRange = (
    input: FilterInput,
    freq: BudgetFrequency,
    alias: string
  ): RawBuilder<unknown>[] => {
    const col = sql.ref(`${alias}.${EXECUTION_AMOUNT_COLUMN[freq]}`);
    const conds: RawBuilder<unknown>[] = [];
    const min = fieldOf(input, 'minAmount')?.['gte'];
    const max = fieldOf(input, 'maxAmount')?.['lte'];
    if (typeof min === 'string' && /^-?\d+(\.\d+)?$/u.test(min))
      conds.push(sql`${col}::numeric >= ${min}::numeric`);
    if (typeof max === 'string' && /^-?\d+(\.\d+)?$/u.test(max))
      conds.push(sql`${col}::numeric <= ${max}::numeric`);
    return conds;
  };

  /** Transfer exclusion (fact path opt-in; the EXACT set the MVs bake in, §3.4). */
  const transferExclusion = (alias: string): RawBuilder<unknown> => {
    const econ = BUDGET_TRANSFER_EXCLUSIONS.economicPrefixes.map(
      (p) => sql`${sql.ref(`${alias}.economic_code`)} like ${`${p}%`}`
    );
    const func = BUDGET_TRANSFER_EXCLUSIONS.functionalPrefixes.map(
      (p) => sql`${sql.ref(`${alias}.functional_code`)} like ${`${p}%`}`
    );
    // Keep rows that are NOT a transfer code (NULL-safe: a NULL code is kept).
    return sql`not coalesce(${sql.join([...econ, ...func], sql` or `)}, false)`;
  };

  const wantsExcludeTransfers = (input: FilterInput): boolean => {
    const v = fieldOf(input, 'excludeTransfers')?.['eq'];
    return v === true || v === 'true';
  };

  /** Does the input touch a core (entity/territory) column requiring the join? */
  const needsCoreJoin = (input: FilterInput, coreFields: readonly string[]): boolean => {
    if (coreFields.some((f) => fieldOf(input, f) !== undefined)) return true;
    const ex = input.exclude;
    if (ex !== undefined && typeof ex === 'object') {
      return ['countyCodes', 'regions'].some(
        (f) => (ex as Record<string, unknown>)[f] !== undefined
      );
    }
    return false;
  };

  const EXEC_CORE_FIELDS = [
    'entityTypes',
    'isUat',
    'countyCodes',
    'regions',
    'minPopulation',
    'maxPopulation',
    'q',
  ];

  const execSelect = [
    'eli.execution_line_item_id',
    'eli.report_id',
    'eli.reporting_year',
    'eli.reporting_month',
    'eli.quarter',
    'eli.entity_cui',
    'eli.main_creditor_cui',
    'eli.report_type',
    'eli.account_category',
    'eli.budget_sector_id',
    'eli.expense_type',
    'eli.functional_code',
    'eli.functional_name',
    'eli.economic_code',
    'eli.economic_name',
    'eli.funding_source',
    'eli.funding_source_id',
    'eli.program_code',
  ] as const;

  const execAmountSelect = [
    sql<string>`eli.ytd_amount::text`.as('ytd_amount'),
    sql<string>`eli.monthly_amount::text`.as('monthly_amount'),
    sql<string | null>`eli.quarterly_amount::text`.as('quarterly_amount'),
    'eli.is_monthly',
    'eli.is_quarterly',
    'eli.is_yearly',
    'eli.anomaly',
  ] as const;

  const listExecutionLineItems = async (
    q: BudgetFactQuery
  ): Promise<Result<CursorPage<ExecutionLineItem>, ApiError>> => {
    const gateR = resolveExecutionGate(q.filter, {
      reportType: 'EXECUTION_DETAILED',
      accountCategory: 'EXPENSE',
      frequency: 'YEAR',
    });
    if (gateR.isErr()) return err(gateR.error);
    const gate = gateR.value;

    const limit = clamp(q.page.first, 1, FACT_LIMIT_MAX);
    const fhash = fhashFor(budgetFactFilterSpec, q.filter);
    const dir: 'asc' | 'desc' = q.sort === 'AMOUNT_ASC' ? 'asc' : 'desc';
    let cursorKeys: readonly string[] | undefined;
    if (q.page.after !== undefined) {
      const decoded = decodeCursor(q.page.after, { sort: q.sort, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const fm = await fundingMap.load();
    const translated = prepareFundingFactFilter(q.filter, fm.toStoredId);
    const physical = omitFields(translated, [...BUDGET_FACT_VIRTUAL_FIELDS]);
    const built = toConditionBuilders(budgetFactKernelSpec, physical);
    if (built.isErr()) return err(built.error);

    const conds: RawBuilder<unknown>[] = [...execGatePredicates(gate, 'eli'), ...built.value];
    const tuple = periodTuple(q.filter, gate.frequency, 'eli');
    if (tuple !== undefined) conds.push(tuple);
    conds.push(...amountRange(q.filter, gate.frequency, 'eli'));
    if (wantsExcludeTransfers(q.filter)) conds.push(transferExclusion('eli'));

    const amountCol = EXECUTION_AMOUNT_COLUMN[gate.frequency];
    if (cursorKeys !== undefined) {
      if (q.sort === 'LINE_ORDER') {
        const id = cursorKeys[0] ?? '';
        if (id !== '') conds.push(sql`eli.execution_line_item_id > ${id}::bigint`);
      } else if (cursorKeys.length === 2) {
        const amt = cursorKeys[0] ?? '';
        const id = cursorKeys[1] ?? '';
        const ac = sql.ref(`eli.${amountCol}`);
        conds.push(
          dir === 'desc'
            ? sql`(${ac} < ${amt}::numeric or (${ac} = ${amt}::numeric and eli.execution_line_item_id < ${id}::bigint))`
            : sql`(${ac} > ${amt}::numeric or (${ac} = ${amt}::numeric and eli.execution_line_item_id > ${id}::bigint))`
        );
      }
    }

    const needsJoin = needsCoreJoin(q.filter, EXEC_CORE_FIELDS);
    try {
      let base = db.selectFrom('budget.execution_line_items as eli');
      if (needsJoin) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'eli.entity_cui')
          .leftJoin(
            'core.territories as t',
            't.territorial_siruta_code',
            'e.territorial_siruta_code'
          );
      }
      let query = base.select([...execSelect, ...execAmountSelect]).where(composeAnd(conds));
      if (q.sort === 'LINE_ORDER') {
        query = query.orderBy('eli.execution_line_item_id', 'asc');
      } else {
        // `nulls last` is defensive (the is_* flag guarantees a non-null amount)
        // and matches the keyset cursor's implicit ordering assumption.
        query = query
          .orderBy(sql`eli.${sql.ref(amountCol)} ${dirSql(dir)} nulls last`)
          .orderBy('eli.execution_line_item_id', dir);
      }
      const rows = (await query.limit(limit + 1).execute()) as ExecutionRow[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = withPublicFunding(pageRows.map(mapExecutionLineItem), fm);
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          const amt =
            amountCol === 'monthly_amount'
              ? last.monthly_amount
              : amountCol === 'quarterly_amount'
                ? last.quarterly_amount
                : last.ytd_amount;
          const keys =
            q.sort === 'LINE_ORDER'
              ? [last.execution_line_item_id]
              : [amt ?? '', last.execution_line_item_id];
          next = buildNextCursor({ sort: q.sort, dir, fhash, lastKeys: keys });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listExecutionLineItems failed', error));
    }
  };

  const getExecutionLineItem = async (q: {
    year: number;
    reportType: ExecutionReportType;
    accountCategory: AccountCategory;
    id: string;
  }): Promise<Result<ExecutionLineItem | null, ApiError>> => {
    // q.reportType / q.accountCategory are closed enums (validated at the surface),
    // so the label maps always resolve.
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const accountLabel = ACCOUNT_CATEGORY_LABELS[q.accountCategory];
    if (!/^\d+$/u.test(q.id)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const row = (await db
        .selectFrom('budget.execution_line_items as eli')
        .select([...execSelect, ...execAmountSelect])
        .where('eli.reporting_year', '=', q.year)
        .where('eli.report_type', '=', reportLabel)
        .where('eli.account_category', '=', accountLabel)
        .where('eli.execution_line_item_id', '=', q.id)
        .limit(1)
        .executeTakeFirst()) as ExecutionRow | undefined;
      if (row === undefined) return ok(null);
      const fm = await fundingMap.load();
      return ok(withPublicFunding([mapExecutionLineItem(row)], fm)[0] ?? null);
    } catch (error) {
      return err(databaseError('getExecutionLineItem failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // commitment facts (FACT path; pruning PAIR)
  // ───────────────────────────────────────────────────────────────────────────

  const COMMIT_CORE_FIELDS = ['entityTypes', 'isUat', 'countyCodes', 'regions', 'q'];

  const listCommitmentLineItems = async (
    q: BudgetCommitmentFactQuery
  ): Promise<Result<CursorPage<CommitmentLineItem>, ApiError>> => {
    const gateR = resolveCommitmentGate(q.filter, {
      reportType: 'COMMITMENT_AGG_PRINCIPAL',
      frequency: 'YEAR',
    });
    if (gateR.isErr()) return err(gateR.error);
    const gate = gateR.value;

    const limit = clamp(q.page.first, 1, FACT_LIMIT_MAX);
    const fhash = fhashFor(budgetCommitmentFactFilterSpec, q.filter);
    const dir: 'asc' | 'desc' = q.sort === 'AMOUNT_ASC' ? 'asc' : 'desc';
    let cursorKeys: readonly string[] | undefined;
    if (q.page.after !== undefined) {
      const decoded = decodeCursor(q.page.after, { sort: q.sort, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const fm = await fundingMap.load();
    const translated = prepareFundingFactFilter(q.filter, fm.toStoredId);
    const physical = omitFields(translated, [...BUDGET_COMMITMENT_VIRTUAL_FIELDS]);
    const built = toConditionBuilders(budgetCommitmentFactKernelSpec, physical);
    if (built.isErr()) return err(built.error);

    const conds: RawBuilder<unknown>[] = [...commitGatePredicates(gate, 'cli'), ...built.value];
    const tuple = periodTuple(q.filter, gate.frequency, 'cli');
    if (tuple !== undefined) conds.push(tuple);

    // The sort metric column for the chosen frequency (e.g. ytd_plati_trezor).
    const prefix =
      gate.frequency === 'MONTH'
        ? 'monthly_'
        : gate.frequency === 'QUARTER'
          ? 'quarterly_'
          : 'ytd_';
    const sortCol = `${prefix}${q.metric}`;
    if (cursorKeys !== undefined) {
      if (q.sort === 'LINE_ORDER') {
        const id = cursorKeys[0] ?? '';
        if (id !== '') conds.push(sql`cli.commitment_line_item_id > ${id}::bigint`);
      } else if (cursorKeys.length === 2) {
        const amt = cursorKeys[0] ?? '';
        const id = cursorKeys[1] ?? '';
        const ac = sql.ref(`cli.${sortCol}`);
        // NULL amounts sort AFTER all real values (NULLS LAST). The cursor encodes
        // a null amount as ''. Handle the null section symmetrically for asc/desc
        // so null-amount rows are reachable AND not duplicated (R1 review).
        const idCmp =
          dir === 'desc'
            ? sql`cli.commitment_line_item_id < ${id}::bigint`
            : sql`cli.commitment_line_item_id > ${id}::bigint`;
        if (amt === '') {
          // Already inside the trailing null section: only further null rows by id.
          conds.push(sql`(${ac} is null and ${idCmp})`);
        } else {
          const valCmp =
            dir === 'desc' ? sql`${ac} < ${amt}::numeric` : sql`${ac} > ${amt}::numeric`;
          conds.push(sql`(${valCmp} or ${ac} is null or (${ac} = ${amt}::numeric and ${idCmp}))`);
        }
      }
    }

    const needsJoin = needsCoreJoin(q.filter, COMMIT_CORE_FIELDS);
    try {
      let base = db.selectFrom('budget.commitment_line_items as cli');
      if (needsJoin) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'cli.entity_cui')
          .leftJoin(
            'core.territories as t',
            't.territorial_siruta_code',
            'e.territorial_siruta_code'
          );
      }
      let query = base.select(commitmentSelectList()).where(composeAnd(conds));
      if (q.sort === 'LINE_ORDER') {
        query = query.orderBy('cli.commitment_line_item_id', 'asc');
      } else {
        query = query
          .orderBy(sql`cli.${sql.ref(sortCol)} ${dirSql(dir)} nulls last`)
          .orderBy('cli.commitment_line_item_id', dir);
      }
      const rows = (await query.limit(limit + 1).execute()) as CommitmentRow[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = withPublicFunding(pageRows.map(mapCommitmentLineItem), fm);
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          const amt = (last as unknown as Record<string, string | null>)[sortCol] ?? '';
          const keys =
            q.sort === 'LINE_ORDER'
              ? [last.commitment_line_item_id]
              : [amt, last.commitment_line_item_id];
          next = buildNextCursor({ sort: q.sort, dir, fhash, lastKeys: keys });
        }
      }
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('listCommitmentLineItems failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // entity/period summaries (MV path)
  // ───────────────────────────────────────────────────────────────────────────

  /** Build the MV year predicate from a summary query (single year or range). */
  const mvYearConds = (
    q: { year?: number; yearFrom?: number; yearTo?: number },
    defaultYear: number
  ): RawBuilder<unknown>[] => {
    if (q.year !== undefined) return [sql`mv.year = ${q.year}`];
    const conds: RawBuilder<unknown>[] = [];
    if (q.yearFrom !== undefined) conds.push(sql`mv.year >= ${q.yearFrom}`);
    if (q.yearTo !== undefined) conds.push(sql`mv.year <= ${q.yearTo}`);
    if (conds.length === 0) conds.push(sql`mv.year = ${defaultYear}`);
    return conds;
  };

  /**
   * Resolve the default year ONLY when no year bound is supplied — avoids the
   * `asOf()` round-trip (and its MV scans) on the common explicit-year path.
   */
  const defaultYearFor = async (q: {
    year?: number;
    yearFrom?: number;
    yearTo?: number;
  }): Promise<Result<number, ApiError>> => {
    if (q.year !== undefined || q.yearFrom !== undefined || q.yearTo !== undefined) return ok(0);
    const asOfR = await asOf();
    return asOfR.isErr() ? err(asOfR.error) : ok(asOfR.value.latestCompleteYear);
  };

  const getEntitySummary = async (
    rawCui: string,
    q: SummaryQuery
  ): Promise<Result<readonly BudgetEntitySummary[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const defYearR = await defaultYearFor(q);
    if (defYearR.isErr()) return err(defYearR.error);
    const defaultYear = defYearR.value;
    const reportLabel =
      q.reportType !== undefined ? EXECUTION_REPORT_TYPE_LABELS[q.reportType] : undefined;
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.entity_cui = ${cui}`,
        ...mvYearConds(q, defaultYear),
      ];
      if (reportLabel !== undefined) conds.push(sql`mv.report_type = ${reportLabel}`);
      const periodCols =
        q.frequency === 'MONTH'
          ? [sql<number | null>`mv.month`.as('month'), sql<number | null>`null::int`.as('quarter')]
          : q.frequency === 'QUARTER'
            ? [
                sql<number | null>`null::int`.as('month'),
                sql<number | null>`mv.quarter`.as('quarter'),
              ]
            : [
                sql<number | null>`null::int`.as('month'),
                sql<number | null>`null::int`.as('quarter'),
              ];
      const rows = await db
        .selectFrom(execMvName(q.frequency))
        .select([
          'mv.entity_cui',
          'mv.main_creditor_cui',
          'mv.report_type',
          'mv.year',
          ...periodCols,
          sql<string>`mv.total_income::text`.as('total_income'),
          sql<string>`mv.total_expense::text`.as('total_expense'),
          sql<string>`mv.budget_balance::text`.as('budget_balance'),
        ])
        .where(composeAnd(conds))
        .orderBy('mv.year', 'asc')
        .orderBy('mv.report_type', 'asc')
        .limit(500)
        .execute();
      return ok(
        rows.map((r) => ({
          entityCui: r.entity_cui,
          mainCreditorCui: r.main_creditor_cui,
          reportType: execReportType(r.report_type),
          period: { year: r.year, month: r.month ?? null, quarter: r.quarter ?? null },
          totalIncome: r.total_income,
          totalExpense: r.total_expense,
          budgetBalance: r.budget_balance,
        }))
      );
    } catch (error) {
      return err(databaseError('getEntitySummary failed', error));
    }
  };

  const COMMIT_METRIC_COLS = [
    'credite_angajament',
    'limita_credit_angajament',
    'credite_bugetare',
    'credite_angajament_initiale',
    'credite_bugetare_initiale',
    'credite_angajament_definitive',
    'credite_bugetare_definitive',
    'credite_angajament_disponibile',
    'credite_bugetare_disponibile',
    'receptii_totale',
    'plati_trezor',
    'plati_non_trezor',
    'receptii_neplatite',
  ] as const;

  const getCommitmentSummary = async (
    rawCui: string,
    q: CommitmentSummaryQuery
  ): Promise<Result<readonly CommitmentEntitySummary[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const defYearR = await defaultYearFor(q);
    if (defYearR.isErr()) return err(defYearR.error);
    const defaultYear = defYearR.value;
    const reportLabel =
      q.reportType !== undefined ? COMMITMENT_REPORT_TYPE_LABELS[q.reportType] : undefined;
    const monthly = q.frequency === 'MONTH';
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.entity_cui = ${cui}`,
        ...mvYearConds(q, defaultYear),
      ];
      if (reportLabel !== undefined) conds.push(sql`mv.report_type = ${reportLabel}`);
      // The monthly MV carries only 5 metrics; the annual/quarterly carry all 13.
      const metricSelects = COMMIT_METRIC_COLS.map((c) => {
        if (monthly && monthlyCommitmentGap(toCamel(c))) {
          return sql<string | null>`null::text`.as(c);
        }
        return sql<string | null>`mv.${sql.ref(c)}::text`.as(c);
      });
      const periodCols = monthly
        ? [sql<number | null>`mv.month`.as('month'), sql<number | null>`null::int`.as('quarter')]
        : q.frequency === 'QUARTER'
          ? [
              sql<number | null>`null::int`.as('month'),
              sql<number | null>`mv.quarter`.as('quarter'),
            ]
          : [
              sql<number | null>`null::int`.as('month'),
              sql<number | null>`null::int`.as('quarter'),
            ];
      const rows = await db
        .selectFrom(commitMvName(q.frequency))
        .select([
          'mv.entity_cui',
          'mv.main_creditor_cui',
          'mv.report_type',
          'mv.year',
          ...periodCols,
          ...metricSelects,
        ])
        .where(composeAnd(conds))
        .orderBy('mv.year', 'asc')
        .orderBy('mv.report_type', 'asc')
        .limit(500)
        .execute();
      return ok(rows.map((r) => mapCommitmentSummaryRow(r as Record<string, unknown>)));
    } catch (error) {
      return err(databaseError('getCommitmentSummary failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // timeseries (MV path; normalization applied per-point algebraically)
  // ───────────────────────────────────────────────────────────────────────────

  const executionTimeseries = async (
    q: TimeseriesQuery
  ): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => {
    const cui = normalizeCui(q.entityCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'entityCui'));
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const perCapita = isPerCapita(q.normalization);
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.entity_cui = ${cui}`,
        sql`mv.report_type = ${reportLabel}`,
      ];
      if (q.yearFrom !== undefined) conds.push(sql`mv.year >= ${q.yearFrom}`);
      if (q.yearTo !== undefined) conds.push(sql`mv.year <= ${q.yearTo}`);

      const periodSelect =
        q.frequency === 'MONTH'
          ? sql<number | null>`mv.month`
          : q.frequency === 'QUARTER'
            ? sql<number | null>`mv.quarter`
            : sql<number | null>`null::int`;

      // Apply the per-year normalization multiplier in SQL with `numeric` math
      // (precision-safe — never through a JS float; R1 review). The multiplier is
      // a per-year constant, emitted as a CASE over the distinct years requested.
      const yearsPresent = await db
        .selectFrom(execMvName(q.frequency))
        .select(sql<number>`distinct mv.year`.as('year'))
        .where(composeAnd(conds))
        .execute();
      const multCase = factorCaseExpr(
        yearsPresent.map((y) => y.year),
        q.normalization
      );
      // Per-capita divides by entity population in SQL (entity-grain; §3.4).
      const popExpr = perCapita
        ? sql`(select nullif(t.population, 0) from core.public_entities pe join core.territories t on t.territorial_siruta_code = pe.territorial_siruta_code where pe.cui = mv.entity_cui)`
        : sql`1`;

      const rows = await db
        .selectFrom(execMvName(q.frequency))
        .select([
          'mv.year',
          periodSelect.as('period'),
          sql<string>`(coalesce(mv.${sql.ref(col)},0) * ${multCase} / coalesce(${popExpr}, 1))::text`.as(
            'amount'
          ),
        ])
        .where(composeAnd(conds))
        .orderBy('mv.year', 'asc')
        .orderBy(periodSelect, 'asc')
        .execute();

      const points = rows.map((r) =>
        seriesPoint(r.year, (r as { period: number | null }).period, q.frequency, r.amount)
      );
      return ok(points);
    } catch (error) {
      return err(databaseError('executionTimeseries failed', error));
    }
  };

  const commitmentTimeseries = async (
    q: CommitmentTimeseriesQuery
  ): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => {
    const cui = normalizeCui(q.entityCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'entityCui'));
    const reportLabel = COMMITMENT_REPORT_TYPE_LABELS[q.reportType];
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.entity_cui = ${cui}`,
        sql`mv.report_type = ${reportLabel}`,
      ];
      if (q.yearFrom !== undefined) conds.push(sql`mv.year >= ${q.yearFrom}`);
      if (q.yearTo !== undefined) conds.push(sql`mv.year <= ${q.yearTo}`);
      const periodSelect =
        q.frequency === 'MONTH'
          ? sql<number | null>`mv.month`
          : q.frequency === 'QUARTER'
            ? sql<number | null>`mv.quarter`
            : sql<number | null>`null::int`;
      const rows = await db
        .selectFrom(commitMvName(q.frequency))
        .select([
          'mv.year',
          periodSelect.as('period'),
          sql<string>`coalesce(mv.${sql.ref(q.metric)},0)::text`.as('amount'),
        ])
        .where(composeAnd(conds))
        .orderBy('mv.year', 'asc')
        .orderBy(periodSelect, 'asc')
        .execute();
      return ok(
        rows.map((r) =>
          seriesPoint(r.year, (r as { period: number | null }).period, q.frequency, r.amount)
        )
      );
    } catch (error) {
      return err(databaseError('commitmentTimeseries failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // rankings (MV path + factor; bounded top-N)
  // ───────────────────────────────────────────────────────────────────────────

  const rankEntities = async (
    q: EntityRankingQuery
  ): Promise<Result<readonly RankedEntity[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const limit = clamp(q.limit, 1, RANK_LIMIT_MAX);
    const perCapita = isPerCapita(q.normalization) || false;
    const multiplier = yearMultiplier(q.normalization, q.year);
    const needsGeo =
      (q.countyCodes?.length ?? 0) > 0 ||
      (q.regions?.length ?? 0) > 0 ||
      q.isUat !== undefined ||
      q.minPopulation !== undefined ||
      q.maxPopulation !== undefined ||
      perCapita;
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.year = ${q.year}`,
        sql`mv.report_type = ${reportLabel}`,
      ];
      if (q.countyCodes !== undefined && q.countyCodes.length > 0) {
        conds.push(
          sql`t.county_code in (${sql.join(
            q.countyCodes.map((c) => sql`${c}`),
            sql`, `
          )})`
        );
      }
      if (q.regions !== undefined && q.regions.length > 0) {
        conds.push(
          sql`t.region in (${sql.join(
            q.regions.map((r) => sql`${r}`),
            sql`, `
          )})`
        );
      }
      if (q.isUat !== undefined) conds.push(sql`e.is_uat = ${q.isUat}`);
      if (q.minPopulation !== undefined) conds.push(sql`t.population >= ${q.minPopulation}`);
      if (q.maxPopulation !== undefined) conds.push(sql`t.population <= ${q.maxPopulation}`);

      const metricExpr = sql`coalesce(mv.${sql.ref(col)},0) * ${multiplier}::numeric`;
      const perCapitaExpr = sql`case when t.population > 0 then (coalesce(mv.${sql.ref(col)},0) * ${multiplier}::numeric / t.population) else null end`;
      const orderExpr = perCapita ? perCapitaExpr : metricExpr;

      let base = db.selectFrom(execMvName('YEAR'));
      if (needsGeo) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui')
          .leftJoin(
            'core.territories as t',
            't.territorial_siruta_code',
            'e.territorial_siruta_code'
          );
      } else {
        base = base.leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui');
      }
      const rows = await base
        .select([
          'mv.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'mv.year',
          sql<string>`(${metricExpr})::text`.as('amount'),
          needsGeo
            ? sql<string | null>`(${perCapitaExpr})::text`.as('per_capita')
            : sql<string | null>`null::text`.as('per_capita'),
          needsGeo
            ? sql<number | null>`t.population`.as('population')
            : sql<number | null>`null::int`.as('population'),
          needsGeo
            ? sql<string | null>`t.county_code`.as('county_code')
            : sql<string | null>`null::text`.as('county_code'),
        ])
        .where(composeAnd(conds))
        .orderBy(sql`${orderExpr} ${dirSql(q.ascending === true ? 'asc' : 'desc')} nulls last`)
        .orderBy('mv.entity_cui', 'asc')
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          entityCui: r.entity_cui,
          entityName: r.entity_name,
          reportType: q.reportType,
          year: r.year,
          amount: r.amount,
          perCapita: r.per_capita,
          population: r.population,
          countyCode: r.county_code,
        }))
      );
    } catch (error) {
      return err(databaseError('rankEntities failed', error));
    }
  };

  const rankCommitmentEntities = async (
    q: CommitmentRankingQuery
  ): Promise<Result<readonly RankedCommitmentEntity[], ApiError>> => {
    const reportLabel = COMMITMENT_REPORT_TYPE_LABELS[q.reportType];
    const limit = clamp(q.limit, 1, RANK_LIMIT_MAX);
    try {
      const rows = await db
        .selectFrom(commitMvName('YEAR'))
        .leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui')
        .select([
          'mv.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'mv.year',
          sql<string>`coalesce(mv.${sql.ref(q.metric)},0)::text`.as('amount'),
        ])
        .where(sql<SqlBool>`mv.year = ${q.year} and mv.report_type = ${reportLabel}`)
        .orderBy(sql`mv.${sql.ref(q.metric)} desc nulls last`)
        .orderBy('mv.entity_cui', 'asc')
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          entityCui: r.entity_cui,
          entityName: r.entity_name,
          reportType: q.reportType,
          year: r.year,
          amount: r.amount,
        }))
      );
    } catch (error) {
      return err(databaseError('rankCommitmentEntities failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // classification aggregate (FACT path; ONE pruned leaf)
  // ───────────────────────────────────────────────────────────────────────────

  const aggregateByClassification = async (
    q: ClassificationAggregateQuery
  ): Promise<Result<readonly AggregatedBudgetRow[], ApiError>> => {
    const gateR = resolveExecutionGate(q.filter, {
      reportType: 'EXECUTION_DETAILED',
      accountCategory: 'EXPENSE',
      frequency: 'YEAR',
    });
    if (gateR.isErr()) return err(gateR.error);
    const gate = gateR.value;
    const limit = clamp(q.limit, 1, AGG_LIMIT_MAX);

    // Normalization for a classification aggregate: per-capita has NO bucket-grain
    // population, so it is rejected; TOTAL_EURO / PERCENT_GDP apply a single-year
    // scalar multiplier (a classification aggregate must scope to ONE year so the
    // factor is well-defined). The multiplier is applied in SQL (numeric-exact).
    if (isPerCapita(q.normalization)) {
      return err(
        invalidInput(
          'per-capita normalization is not defined for a classification aggregate',
          'normalization'
        )
      );
    }
    if (q.normalization !== 'TOTAL' && gate.years.eq === undefined) {
      return err(
        invalidInput(
          'non-TOTAL normalization requires a single reportingYear (eq)',
          'reportingYear'
        )
      );
    }
    const aggMult =
      gate.years.eq !== undefined ? yearMultiplier(q.normalization, gate.years.eq) : 1;

    const fm = await fundingMap.load();
    const translated = prepareFundingFactFilter(q.filter, fm.toStoredId);
    const physical = omitFields(translated, [...BUDGET_FACT_VIRTUAL_FIELDS]);
    const built = toConditionBuilders(budgetFactKernelSpec, physical);
    if (built.isErr()) return err(built.error);

    const conds: RawBuilder<unknown>[] = [...execGatePredicates(gate, 'eli'), ...built.value];
    const tuple = periodTuple(q.filter, gate.frequency, 'eli');
    if (tuple !== undefined) conds.push(tuple);
    if (wantsExcludeTransfers(q.filter)) conds.push(transferExclusion('eli'));

    const amountCol = EXECUTION_AMOUNT_COLUMN[gate.frequency];
    // The normalized aggregate sum (multiplier applied in numeric SQL).
    const sumExpr = sql`(sum(eli.${sql.ref(amountCol)}) * ${aggMult}::numeric)`;
    const havingConds: RawBuilder<unknown>[] = [];
    if (q.minAmount !== undefined && /^-?\d+(\.\d+)?$/u.test(q.minAmount)) {
      havingConds.push(sql`${sumExpr} >= ${q.minAmount}::numeric`);
    }
    if (q.maxAmount !== undefined && /^-?\d+(\.\d+)?$/u.test(q.maxAmount)) {
      havingConds.push(sql`${sumExpr} <= ${q.maxAmount}::numeric`);
    }

    const needsJoin = needsCoreJoin(q.filter, EXEC_CORE_FIELDS);
    try {
      let base = db.selectFrom('budget.execution_line_items as eli');
      if (needsJoin) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'eli.entity_cui')
          .leftJoin(
            'core.territories as t',
            't.territorial_siruta_code',
            'e.territorial_siruta_code'
          );
      }
      let query = base
        .select([
          'eli.functional_code',
          sql<string | null>`max(eli.functional_name)`.as('functional_name'),
          'eli.economic_code',
          sql<string | null>`max(eli.economic_name)`.as('economic_name'),
          sql<string>`${sumExpr}::text`.as('amount'),
          sql<string>`count(*)`.as('line_count'),
        ])
        .where(composeAnd(conds))
        .groupBy(['eli.functional_code', 'eli.economic_code']);
      if (havingConds.length > 0) query = query.having(composeAnd(havingConds));
      const rows = await query
        .orderBy(sql`${sumExpr} desc nulls last`)
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          functionalCode: r.functional_code,
          functionalName: r.functional_name,
          economicCode: r.economic_code,
          economicName: r.economic_name,
          amount: r.amount,
          lineCount: Number(r.line_count),
        }))
      );
    } catch (error) {
      return err(databaseError('aggregateByClassification failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // county heatmap (MV → county rollup)
  // ───────────────────────────────────────────────────────────────────────────

  const countyHeatmap = async (
    q: HeatmapQuery
  ): Promise<Result<readonly CountyHeatmapPoint[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const multiplier = yearMultiplier(q.normalization, q.year);
    const perCapita = isPerCapita(q.normalization);
    try {
      const rows = await db
        .selectFrom(execMvName('YEAR'))
        .innerJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui')
        .innerJoin(
          'core.territories as t',
          't.territorial_siruta_code',
          'e.territorial_siruta_code'
        )
        .select([
          sql<string | null>`t.county_code`.as('county_code'),
          sql<string | null>`max(t.county_name)`.as('county_name'),
          sql<string>`(sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric)::text`.as(
            'amount'
          ),
          sql<number | null>`sum(distinct t.population)`.as('population'),
          sql<string>`count(distinct mv.entity_cui)`.as('entity_count'),
        ])
        .where(
          sql<SqlBool>`mv.year = ${q.year} and mv.report_type = ${reportLabel} and t.county_code is not null`
        )
        .groupBy('t.county_code')
        .orderBy(sql`sum(coalesce(mv.${sql.ref(col)},0)) desc nulls last`)
        .execute();
      return ok(
        rows
          .filter((r): r is typeof r & { county_code: string } => r.county_code !== null)
          .map((r) => {
            const pop = r.population;
            const amountNum = Number(r.amount);
            return {
              countyCode: r.county_code,
              countyName: r.county_name,
              year: q.year,
              amount: r.amount,
              perCapita: perCapita && pop !== null && pop > 0 ? String(amountNum / pop) : null,
              population: pop,
              entityCount: Number(r.entity_count),
            };
          })
      );
    } catch (error) {
      return err(databaseError('countyHeatmap failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // reports (metadata; ≥1 of entity/year/report_type required)
  // ───────────────────────────────────────────────────────────────────────────

  const listReports = async (q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetReport>, ApiError>> => {
    const hasEntity = fieldOf(q.filter, 'entityCui') !== undefined;
    const hasYear = fieldOf(q.filter, 'reportingYear') !== undefined;
    const hasType = fieldOf(q.filter, 'reportType') !== undefined;
    if (!hasEntity && !hasYear && !hasType) {
      return err(
        invalidInput(
          'reports require at least one of entityCui / reportingYear / reportType',
          'filter'
        )
      );
    }
    const built = toConditionBuilders(budgetReportFilterSpec, q.filter);
    if (built.isErr()) return err(built.error);
    const page = clamp(q.page, 1, 100000);
    const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
    const offset = (page - 1) * pageSize;
    try {
      const rows = (await db
        .selectFrom('budget.reports as r')
        .leftJoin('core.public_entities as e', 'e.cui', 'r.entity_cui')
        .select([
          'r.report_id',
          'r.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'r.report_type',
          'r.main_creditor_cui',
          sql<string | null>`r.report_date::text`.as('report_date'),
          'r.reporting_year',
          'r.reporting_period',
          'r.budget_sector_id',
          'r.file_source',
          'r.download_links',
        ])
        .where(composeAnd(built.value))
        .orderBy(sql`r.report_date desc nulls last`)
        .orderBy('r.report_id', 'desc')
        .limit(pageSize)
        .offset(offset)
        .execute()) as ReportRow[];
      const countRow = await db
        .selectFrom('budget.reports as r')
        .select(sql<string>`count(*)`.as('cnt'))
        .where(composeAnd(built.value))
        .executeTakeFirst();
      return ok({
        items: rows.map(mapReport),
        total: countRow !== undefined ? Number(countRow.cnt) : null,
        estimated: false,
        caveats: [],
      });
    } catch (error) {
      return err(databaseError('listReports failed', error));
    }
  };

  const getReport = async (reportId: string): Promise<Result<BudgetReport | null, ApiError>> => {
    try {
      const row = (await db
        .selectFrom('budget.reports as r')
        .leftJoin('core.public_entities as e', 'e.cui', 'r.entity_cui')
        .select([
          'r.report_id',
          'r.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'r.report_type',
          'r.main_creditor_cui',
          sql<string | null>`r.report_date::text`.as('report_date'),
          'r.reporting_year',
          'r.reporting_period',
          'r.budget_sector_id',
          'r.file_source',
          'r.download_links',
        ])
        .where('r.report_id', '=', reportId)
        .limit(1)
        .executeTakeFirst()) as ReportRow | undefined;
      return ok(row !== undefined ? mapReport(row) : null);
    } catch (error) {
      return err(databaseError('getReport failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // dimensions (functional/economic catalogs are EMPTY in prod → capability-gated)
  // ───────────────────────────────────────────────────────────────────────────

  const listFunctionalClassifications = (q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
    listClassificationDim(
      'budget.functional_classifications',
      'functional_code',
      'functional_name',
      q
    );

  const listEconomicClassifications = (q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
    listClassificationDim('budget.economic_classifications', 'economic_code', 'economic_name', q);

  const listClassificationDim = async (
    table: 'budget.functional_classifications' | 'budget.economic_classifications',
    codeCol: 'functional_code' | 'economic_code',
    nameCol: 'functional_name' | 'economic_name',
    q: { search?: string; codes?: readonly string[]; limit: number }
  ): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> => {
    const limit = clamp(q.limit, 1, DIM_LIMIT_MAX);
    try {
      // The two catalogs have distinct column names, so a typed Kysely builder
      // can't span both with dynamic refs — compose a single parameterized raw
      // statement instead (code/name columns + table are trusted internal idents
      // validated by the literal-union param types; values stay parameterized).
      const code = sql.ref(`d.${codeCol}`);
      const name = sql.ref(`d.${nameCol}`);
      const tableRef = sql.ref(table);
      const conds: RawBuilder<unknown>[] = [];
      if (q.codes !== undefined && q.codes.length > 0) {
        conds.push(
          sql`${code} in (${sql.join(
            q.codes.map((c) => sql`${c}`),
            sql`, `
          )})`
        );
      }
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        conds.push(
          sql`(${code} ilike ${pattern} escape '\\' or ${name} ilike ${pattern} escape '\\')`
        );
      }
      const where = conds.length > 0 ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
      const stmt = sql<{ code: string; name: string | null }>`
        select ${code} as code, ${name} as name
        from ${tableRef} as d
        ${where}
        order by ${code} asc
        limit ${limit}
      `;
      const result = await stmt.execute(db);
      const rows = result.rows;
      const caveats =
        rows.length === 0
          ? [
              'budget classification catalog is not loaded; functional/economic names are available on fact rows',
            ]
          : [];
      return ok({
        items: rows.map(mapClassification),
        total: rows.length,
        estimated: false,
        caveats,
      });
    } catch (error) {
      return err(databaseError('listClassificationDim failed', error));
    }
  };

  const listBudgetSectors = async (q: {
    search?: string;
    ids?: readonly number[];
  }): Promise<Result<readonly BudgetSector[], ApiError>> => {
    try {
      let query = db
        .selectFrom('budget.budget_sectors as s')
        .select(['s.sector_id', 's.sector_description']);
      if (q.ids !== undefined && q.ids.length > 0)
        query = query.where('s.sector_id', 'in', [...q.ids]);
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        query = query.where(sql<SqlBool>`s.sector_description ilike ${pattern} escape '\\'`);
      }
      const rows = await query.orderBy('s.sector_id', 'asc').execute();
      return ok(rows.map(mapSector));
    } catch (error) {
      return err(databaseError('listBudgetSectors failed', error));
    }
  };

  const listFundingSources = async (q: {
    search?: string;
    ids?: readonly number[];
  }): Promise<Result<readonly BudgetFundingSource[], ApiError>> => {
    // Read the A1 compat view so `sourceId` is the CONVENTIONAL (phoenix) id, not
    // the arbitrary stored identity id. `q.ids` are public ids (they match the
    // view's `source_id`). The synthetic 0=Unknown row is excluded from the picker
    // list (source_code null) — it exists only to resolve unresolved-fact filters.
    try {
      let query = db
        .selectFrom('budget.v_funding_sources_compat as fs')
        .select(['fs.source_id', 'fs.source_code', 'fs.source_description'])
        .where('fs.source_code', 'is not', null);
      if (q.ids !== undefined && q.ids.length > 0)
        query = query.where('fs.source_id', 'in', [...q.ids]);
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        query = query.where(
          sql<SqlBool>`fs.source_code ilike ${pattern} escape '\\' or fs.source_description ilike ${pattern} escape '\\'`
        );
      }
      const rows = await query.orderBy('fs.source_id', 'asc').execute();
      return ok(rows.map(mapFundingSource));
    } catch (error) {
      return err(databaseError('listFundingSources failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // budget-official (capability-gated on row presence)
  // ───────────────────────────────────────────────────────────────────────────

  const listApprovedBudgetFacts = async (q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<ApprovedBudgetFact>, ApiError>> => {
    const built = toConditionBuilders(budgetApprovedFactFilterSpec, q.filter);
    if (built.isErr()) return err(built.error);
    const page = clamp(q.page, 1, 100000);
    const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
    try {
      const rows = await db
        .selectFrom('budget.approved_budget_facts as af')
        .select([
          'af.fact_id',
          'af.budget_year',
          'af.measure_year',
          'af.budget_component',
          'af.functional_code',
          'af.economic_code',
          'af.program_code',
          'af.label',
          'af.measure_kind',
          sql<string | null>`af.amount_value::text`.as('amount_value'),
          'af.unit',
        ])
        .where(composeAnd(built.value))
        .orderBy('af.budget_year', 'desc')
        .orderBy('af.fact_id', 'asc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return ok({ items: rows.map(mapApprovedFact), total: null, estimated: true, caveats: [] });
    } catch (error) {
      return err(databaseError('listApprovedBudgetFacts failed', error));
    }
  };

  const budgetVsExecution = async (q: {
    budgetYear?: number;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetVsExecutionRow>, ApiError>> => {
    // Capability gate keys on bgc_official_facts presence (the view's FROM) —
    // empty bgc ⇒ the view is empty (plan §13.2). Probe cheaply first.
    try {
      const probe = await db
        .selectFrom('budget.bgc_official_facts as b')
        .select(sql<string>`1`.as('one'))
        .limit(1)
        .executeTakeFirst();
      if (probe === undefined) {
        return ok({
          items: [],
          total: 0,
          estimated: false,
          caveats: [
            'budget-official execution bulletins not yet loaded; vs-execution comparison unavailable',
          ],
        });
      }
      const page = clamp(q.page, 1, 100000);
      const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
      let vsQuery = db
        .selectFrom('budget.execution_vs_budget as v')
        .select([
          'v.component_key',
          'v.section',
          'v.line_item_key',
          'v.line_item_label',
          'v.period_year',
          'v.budget_year',
          sql<string | null>`v.execution_amount_ron::text`.as('execution_amount_ron'),
          sql<string | null>`v.approved_amount_ron::text`.as('approved_amount_ron'),
          sql<string | null>`v.delta_amount::text`.as('delta_amount'),
          'v.comparison_basis',
        ]);
      if (q.budgetYear !== undefined) vsQuery = vsQuery.where('v.budget_year', '=', q.budgetYear);
      const rows = await vsQuery
        .orderBy('v.budget_year', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return ok({
        items: rows.map((r) => ({
          componentKey: r.component_key,
          section: r.section,
          lineItemKey: r.line_item_key,
          lineItemLabel: r.line_item_label,
          periodYear: r.period_year,
          budgetYear: r.budget_year,
          executionAmountRon: r.execution_amount_ron,
          approvedAmountRon: r.approved_amount_ron,
          deltaAmount: r.delta_amount,
          comparisonBasis: r.comparison_basis,
        })),
        total: null,
        estimated: true,
        caveats: [],
      });
    } catch (error) {
      return err(databaseError('budgetVsExecution failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // contributor support (§4.1)
  // ───────────────────────────────────────────────────────────────────────────

  const profileSlice = async (
    rawCui: string
  ): Promise<Result<BudgetProfileSlice | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const asOfR = await asOf();
    if (asOfR.isErr()) return err(asOfR.error);
    const { latestLoadedYear, latestCompleteYear } = asOfR.value;
    try {
      // The entity's own default report type drives the slice (its canonical view).
      const ent = await db
        .selectFrom('core.public_entities as e')
        .select(['e.default_report_type'])
        .where('e.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      const defaultReportType = ent?.default_report_type ?? null;
      // Pick the latest year with an MV row for this entity (≤ latestComplete).
      let mvQuery = db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([
          'mv.year',
          'mv.report_type',
          sql<string>`mv.total_income::text`.as('total_income'),
          sql<string>`mv.total_expense::text`.as('total_expense'),
          sql<string>`mv.budget_balance::text`.as('budget_balance'),
        ])
        .where('mv.entity_cui', '=', cui);
      if (defaultReportType !== null)
        mvQuery = mvQuery.where('mv.report_type', '=', defaultReportType);
      const mvRow = await mvQuery
        .where('mv.year', '<=', latestCompleteYear)
        .orderBy('mv.year', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (mvRow === undefined) return ok(null);

      // Top expense categories for that year (one pruned leaf; bounded LIMIT 5).
      const reportType = execReportType(mvRow.report_type);
      const reportLabel = EXECUTION_REPORT_TYPE_LABELS[reportType];
      const top = await db
        .selectFrom('budget.execution_line_items as eli')
        .select([
          'eli.functional_code',
          sql<string | null>`max(eli.functional_name)`.as('functional_name'),
          sql<string>`sum(eli.ytd_amount)::text`.as('amount'),
        ])
        .where('eli.reporting_year', '=', mvRow.year)
        .where('eli.report_type', '=', reportLabel)
        .where('eli.account_category', '=', 'ch')
        .where('eli.is_yearly', '=', true)
        .where('eli.entity_cui', '=', cui)
        .groupBy('eli.functional_code')
        .orderBy(sql`sum(eli.ytd_amount) desc nulls last`)
        .limit(5)
        .execute();

      return ok({
        cui,
        latestYear: latestLoadedYear,
        latestCompleteYear,
        reportType,
        totalIncome: mvRow.total_income,
        totalExpense: mvRow.total_expense,
        budgetBalance: mvRow.budget_balance,
        topExpenseCategories: top.map((t) => ({
          functionalCode: t.functional_code,
          functionalName: t.functional_name,
          amount: t.amount,
        })),
        refreshedAt: null,
      });
    } catch (error) {
      return err(databaseError('profileSlice failed', error));
    }
  };

  const presenceFor = async (rawCui: string): Promise<Result<SourcePresence | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // One index probe on the annual MV (idx_..._entity_year).
      const row = await db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([sql<number>`max(mv.year)`.as('latest_year'), sql<string>`count(*)`.as('cnt')])
        .where('mv.entity_cui', '=', cui)
        .executeTakeFirst();
      const cnt = Number(row?.cnt ?? 0);
      if (cnt === 0) return ok(null);
      return ok({
        source: 'budget',
        present: true,
        label: 'Buget',
        count: cnt,
        badges: ['budget-reporting'],
        ...(row?.latest_year != null && { asOf: { execution: String(row.latest_year) } }),
        attrs: { reportedYears: cnt, latestYear: row?.latest_year ?? null },
      });
    } catch (error) {
      return err(databaseError('presenceFor failed', error));
    }
  };

  // ── shared select-list builders (declared after the closure for readability) ──

  function commitmentSelectList() {
    const base = [
      'cli.commitment_line_item_id',
      'cli.report_id',
      'cli.reporting_year',
      'cli.reporting_month',
      'cli.quarter',
      'cli.entity_cui',
      'cli.main_creditor_cui',
      'cli.report_type',
      'cli.budget_sector_id',
      'cli.functional_code',
      'cli.functional_name',
      'cli.economic_code',
      'cli.economic_name',
      'cli.funding_source',
      'cli.funding_source_id',
      'cli.is_monthly',
      'cli.is_quarterly',
      'cli.is_yearly',
      'cli.anomaly',
    ] as const;
    const metricCols = COMMIT_FACT_METRIC_COLUMNS.map((c) =>
      sql<string | null>`cli.${sql.ref(c)}::text`.as(c)
    );
    return [...base, ...metricCols];
  }

  return {
    asOf,
    listExecutionLineItems,
    getExecutionLineItem,
    listCommitmentLineItems,
    getEntitySummary,
    getCommitmentSummary,
    executionTimeseries,
    commitmentTimeseries,
    rankEntities,
    rankCommitmentEntities,
    aggregateByClassification,
    countyHeatmap,
    listReports,
    getReport,
    listFunctionalClassifications,
    listEconomicClassifications,
    listBudgetSectors,
    listFundingSources,
    listApprovedBudgetFacts,
    budgetVsExecution,
    presenceFor,
    profileSlice,
  };
};

// ── helpers shared outside the closure ────────────────────────────────────────

/** snake_case → camelCase (for the monthly-MV gap check). */
const toCamel = (s: string): string => s.replace(/_([a-z])/gu, (_m, c: string) => c.toUpperCase());

/** All ytd/monthly/quarterly/latest commitment fact columns (in CommitmentRow order). */
const COMMIT_FACT_METRIC_COLUMNS = [
  'ytd_credite_angajament',
  'monthly_credite_angajament',
  'quarterly_credite_angajament',
  'credite_angajament',
  'ytd_limita_credit_angajament',
  'monthly_limita_credit_angajament',
  'quarterly_limita_credit_angajament',
  'limita_credit_angajament',
  'ytd_credite_bugetare',
  'monthly_credite_bugetare',
  'quarterly_credite_bugetare',
  'credite_bugetare',
  'ytd_credite_angajament_initiale',
  'monthly_credite_angajament_initiale',
  'quarterly_credite_angajament_initiale',
  'credite_angajament_initiale',
  'ytd_credite_bugetare_initiale',
  'monthly_credite_bugetare_initiale',
  'quarterly_credite_bugetare_initiale',
  'credite_bugetare_initiale',
  'ytd_credite_angajament_definitive',
  'monthly_credite_angajament_definitive',
  'quarterly_credite_angajament_definitive',
  'credite_angajament_definitive',
  'ytd_credite_bugetare_definitive',
  'monthly_credite_bugetare_definitive',
  'quarterly_credite_bugetare_definitive',
  'credite_bugetare_definitive',
  'ytd_receptii_totale',
  'monthly_receptii_totale',
  'quarterly_receptii_totale',
  'receptii_totale',
  'ytd_plati_trezor',
  'monthly_plati_trezor',
  'quarterly_plati_trezor',
  'plati_trezor',
  'ytd_plati_non_trezor',
  'monthly_plati_non_trezor',
  'quarterly_plati_non_trezor',
  'plati_non_trezor',
  'ytd_receptii_neplatite',
  'monthly_receptii_neplatite',
  'quarterly_receptii_neplatite',
  'receptii_neplatite',
] as const;

/** Map a commitment MV summary row (camelCase metric fields) to the view model. */
const mapCommitmentSummaryRow = (r: Record<string, unknown>): CommitmentEntitySummary => {
  const m = (col: string): string | null => (r[col] as string | null) ?? null;
  return {
    entityCui: r['entity_cui'] as string,
    mainCreditorCui: (r['main_creditor_cui'] as string | null) ?? null,
    reportType: commitReportType(r['report_type'] as string),
    period: {
      year: r['year'] as number,
      month: (r['month'] as number | null) ?? null,
      quarter: (r['quarter'] as number | null) ?? null,
    },
    crediteAngajament: m('credite_angajament'),
    limitaCreditAngajament: m('limita_credit_angajament'),
    crediteBugetare: m('credite_bugetare'),
    crediteAngajamentInitiale: m('credite_angajament_initiale'),
    crediteBugetareInitiale: m('credite_bugetare_initiale'),
    crediteAngajamentDefinitive: m('credite_angajament_definitive'),
    crediteBugetareDefinitive: m('credite_bugetare_definitive'),
    crediteAngajamentDisponibile: m('credite_angajament_disponibile'),
    crediteBugetareDisponibile: m('credite_bugetare_disponibile'),
    receptiiTotale: m('receptii_totale'),
    platiTrezor: m('plati_trezor'),
    platiNonTrezor: m('plati_non_trezor'),
    receptiiNeplatite: m('receptii_neplatite'),
  };
};

/** Build a series point with the right period label for the frequency. */
const seriesPoint = (
  year: number,
  period: number | null,
  freq: BudgetFrequency,
  amount: string
): BudgetSeriesPoint => {
  const y = String(year);
  const label =
    freq === 'MONTH'
      ? `${y}-${String(period ?? 0).padStart(2, '0')}`
      : freq === 'QUARTER'
        ? `${y}-Q${String(period ?? 0)}`
        : y;
  return {
    period: {
      year,
      month: freq === 'MONTH' ? period : null,
      quarter: freq === 'QUARTER' ? period : null,
    },
    periodLabel: label,
    amount,
  };
};
