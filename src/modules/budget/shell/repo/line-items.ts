/**
 * Budget repository — execution and commitment LINE ITEMS (the FACT path,
 * codebase plan §WP5): cursor lists and single-row reads over the partitioned
 * fact tables, every query pruned by its gate literals first (invariant 1 of
 * `budget-repo.ts`). Moved out of the `makeBudgetRepo` closure unchanged; the
 * closure state it used (`db`, the options, the funding map) arrives as the
 * shared context.
 */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type CursorPage,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { isPerCapita } from './analytics.js';
import {
  COMMIT_FACT_METRIC_COLUMNS,
  FACT_LIMIT_MAX,
  clamp,
  composeAnd,
  dirSql,
  type BudgetRepoContext,
  withPublicFunding,
} from './budget-repo-shared.js';
import {
  EXEC_CORE_FIELDS,
  amountRange,
  commitGatePredicates,
  execGatePredicates,
  needsCoreJoin,
  periodTuple,
  transferExclusion,
  wantsExcludeTransfers,
} from './fact-predicates.js';
import {
  fieldOf,
  omitFields,
  prepareFundingFactFilter,
  resolveCommitmentGate,
  resolveExecutionGate,
} from './filter-helpers.js';
import {
  mapCommitmentLineItem,
  mapExecutionLineItem,
  type CommitmentRow,
  type ExecutionRow,
} from './mappers.js';
import { availableSingleYearMoneyFactor } from './money-factor.js';
import {
  ACCOUNT_CATEGORY_LABELS,
  EXECUTION_AMOUNT_COLUMN,
  EXECUTION_REPORT_TYPE_LABELS,
  type AccountCategory,
  type ExecutionReportType,
} from '../../core/constants.js';
import {
  BUDGET_COMMITMENT_VIRTUAL_FIELDS,
  BUDGET_FACT_VIRTUAL_FIELDS,
  budgetCommitmentFactFilterSpec,
  budgetCommitmentFactKernelSpec,
  budgetFactFilterSpec,
  budgetFactKernelSpec,
} from '../../core/filters.js';
import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';
import { normalizeLineItemAmounts } from '../../core/line-item-amounts.js';
import { needsMoneyFactor } from '../../core/money-options.js';

import type {
  BudgetCommitmentFactQuery,
  BudgetFactQuery,
  CommitmentLineItem,
  ExecutionLineItem,
} from '../../core/types.js';

export const makeLineItemReads = (ctx: BudgetRepoContext) => {
  const { db, options, fundingMap } = ctx;

  // ───────────────────────────────────────────────────────────────────────────
  // execution facts (FACT path)
  // ───────────────────────────────────────────────────────────────────────────

  /** The pruning-triple predicates (always FIRST; the planner prunes here). */
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
    if (
      options.moneyFactors === undefined &&
      (q.currency !== undefined || q.inflationAdjusted !== undefined)
    )
      return err({
        type: 'ServiceUnavailable',
        message: 'Native monetary options are unavailable',
      });
    const gateR = resolveExecutionGate(q.filter, {
      reportType: 'EXECUTION_DETAILED',
      accountCategory: 'EXPENSE',
      frequency: 'YEAR',
    });
    if (gateR.isErr()) return err(gateR.error);
    const gate = gateR.value;

    const normalization = q.normalization ?? 'TOTAL';
    const normalized = normalization !== 'TOTAL' || needsMoneyFactor(normalization, q);
    const entitySelection = fieldOf(q.filter, 'entityCuis')?.['in'];
    const normalizedYear = fieldOf(q.filter, 'reportingYear')?.['eq'];
    if (
      normalized &&
      (typeof normalizedYear !== 'number' ||
        !Number.isInteger(normalizedYear) ||
        !Array.isArray(entitySelection) ||
        entitySelection.length !== 1 ||
        typeof entitySelection[0] !== 'string')
    ) {
      return err(
        invalidInput(
          'line-item normalization requires an explicit reportingYear.eq and one entityCuis.in',
          'normalization'
        )
      );
    }
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
          .leftJoin('core.territories as t', 't.id', 'e.territory_id');
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
      let items = withPublicFunding(pageRows.map(mapExecutionLineItem), fm);
      if (normalized && items.length > 0) {
        // The validated single-entity/year scope is independent of which creditors own the facts.
        if (
          options.moneyFactors === undefined ||
          (isPerCapita(normalization) && options.populationRelation === undefined)
        ) {
          return err({
            type: 'ServiceUnavailable',
            message: 'Native line-item normalization is unavailable',
          });
        }
        const year = Number(normalizedYear);
        const factor = await availableSingleYearMoneyFactor(
          options.moneyFactors,
          normalization,
          year,
          q
        );
        if (factor.isErr()) return err(factor.error);
        let population: string | null = '1';
        if (isPerCapita(normalization) && factor.value !== null) {
          const entity = await db
            .selectFrom('core.public_entities')
            .select(['territory_id', 'is_territorial_executive'])
            .where('cui', '=', items[0]?.entityCui ?? '')
            .executeTakeFirst();
          population = null;
          if (
            entity?.is_territorial_executive === true &&
            entity.territory_id !== null &&
            options.populationRelation !== undefined
          ) {
            const relation = await options.populationRelation({
              territoryIds: [entity.territory_id],
              years: [year],
            });
            if (relation.isErr()) return err(relation.error);
            const result = await sql<{
              population: string | null;
            }>`select p.population::text as population
              from (${relation.value}) p where p.territory_id=${entity.territory_id} and p.year=${year}`.execute(
              db
            );
            if (result.rows.length > 1)
              return err({ type: 'ServiceUnavailable', message: 'Duplicate annual population' });
            population = result.rows[0]?.population ?? null;
            if (
              population !== null &&
              (!legacyDecimal(population).isFinite() || legacyDecimal(population).lte(0))
            ) {
              return err({ type: 'ServiceUnavailable', message: 'Invalid annual population' });
            }
          }
        }
        const multiplier = factor.value;
        items = items.map((item) => ({
          ...item,
          normalizedAmounts:
            multiplier === null || population === null
              ? null
              : normalizeLineItemAmounts(item, multiplier, population),
        }));
      }
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

  const COMMIT_CORE_FIELDS = [
    'entityTypes',
    'isUat',
    'isTerritorialExecutive',
    'countyCodes',
    'regions',
    'q',
  ];

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
          .leftJoin('core.territories as t', 't.id', 'e.territory_id');
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

  // ── shared select-list builders ──

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

  return { listExecutionLineItems, getExecutionLineItem, listCommitmentLineItems };
};
