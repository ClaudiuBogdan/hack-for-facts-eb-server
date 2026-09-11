/**
 * Budget repository — AGGREGATES (codebase plan §WP5): the classification
 * aggregate over ONE pruned fact leaf (invariant 1 of `budget-repo.ts`, the
 * FACT path) and the UAT and county heatmaps that roll the summary MVs up to
 * canonical territories (invariant 2). Moved out of the `makeBudgetRepo`
 * closure unchanged; the closure state it used arrives as the shared context.
 */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  databaseError,
  invalidInput,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { isPerCapita } from './analytics.js';
import {
  AGG_LIMIT_MAX,
  COMPLETE_AGGREGATE_GUARD,
  DECIMAL_MONEY_PATTERN,
  canonicalCountyPopulationAggregate,
  composeAnd,
  metricColumn,
  type BudgetRepoContext,
} from './budget-repo-shared.js';
import { countyExecutiveCuiSql } from './county-executive.js';
import {
  EXEC_CORE_FIELDS,
  amountRange,
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
  resolveExecutionGate,
} from './filter-helpers.js';
import { singleYearMoneyFactor } from './money-factor.js';
import { EXECUTION_AMOUNT_COLUMN, EXECUTION_REPORT_TYPE_LABELS } from '../../core/constants.js';
import { BUDGET_FACT_VIRTUAL_FIELDS, budgetFactKernelSpec } from '../../core/filters.js';

import type {
  AggregatedBudgetRow,
  ClassificationAggregateQuery,
  CountyHeatmapPoint,
  HeatmapQuery,
  UatHeatmapPoint,
} from '../../core/types.js';

export const makeAggregateReads = (ctx: BudgetRepoContext) => {
  const { db, options, fundingMap } = ctx;

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
    if (
      q.complete !== true &&
      (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > AGG_LIMIT_MAX)
    ) {
      return err(
        invalidInput(`classification limit must be between 1 and ${String(AGG_LIMIT_MAX)}`, 'limit')
      );
    }
    if (q.complete === true && q.limit !== 50) {
      return err(
        invalidInput('complete classification mode does not accept a custom limit', 'limit')
      );
    }
    // Complete mode is an explicit, fail-closed capability. Its safety guard is
    // server-owned so clients neither duplicate nor silently drift from it.
    const limit = q.complete === true ? COMPLETE_AGGREGATE_GUARD : q.limit;

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
    if (q.minAmount !== undefined && !DECIMAL_MONEY_PATTERN.test(q.minAmount)) {
      return err(invalidInput('classification minimum amount must be a decimal', 'minAmount'));
    }
    if (q.maxAmount !== undefined && !DECIMAL_MONEY_PATTERN.test(q.maxAmount)) {
      return err(invalidInput('classification maximum amount must be a decimal', 'maxAmount'));
    }
    const rowMinAmount = fieldOf(q.filter, 'minAmount')?.['gte'];
    const rowMaxAmount = fieldOf(q.filter, 'maxAmount')?.['lte'];
    if (
      rowMinAmount !== undefined &&
      (typeof rowMinAmount !== 'string' || !DECIMAL_MONEY_PATTERN.test(rowMinAmount))
    ) {
      return err(invalidInput('row minimum amount must be a decimal', 'filter.minAmount'));
    }
    if (
      rowMaxAmount !== undefined &&
      (typeof rowMaxAmount !== 'string' || !DECIMAL_MONEY_PATTERN.test(rowMaxAmount))
    ) {
      return err(invalidInput('row maximum amount must be a decimal', 'filter.maxAmount'));
    }
    const money =
      gate.years.eq === undefined
        ? ok('1') // Only TOTAL reaches this branch; normalized ranges are rejected above.
        : await singleYearMoneyFactor(options.moneyFactors, q.normalization, gate.years.eq);
    if (money.isErr()) return err(money.error);
    const aggMult = money.value;

    const fm = await fundingMap.load();
    const translated = prepareFundingFactFilter(q.filter, fm.toStoredId);
    const physical = omitFields(translated, [...BUDGET_FACT_VIRTUAL_FIELDS]);
    const built = toConditionBuilders(budgetFactKernelSpec, physical);
    if (built.isErr()) return err(built.error);

    const conds: RawBuilder<unknown>[] = [...execGatePredicates(gate, 'eli'), ...built.value];
    conds.push(...amountRange(q.filter, gate.frequency, 'eli'));
    const tuple = periodTuple(q.filter, gate.frequency, 'eli');
    if (tuple !== undefined) conds.push(tuple);
    if (wantsExcludeTransfers(q.filter)) conds.push(transferExclusion('eli'));

    const amountCol = EXECUTION_AMOUNT_COLUMN[gate.frequency];
    // The normalized aggregate sum (multiplier applied in numeric SQL).
    const sumExpr = sql`(sum(eli.${sql.ref(amountCol)}) * ${aggMult}::numeric)`;
    const havingConds: RawBuilder<unknown>[] = [];
    if (q.minAmount !== undefined) {
      havingConds.push(sql`${sumExpr} >= ${q.minAmount}::numeric`);
    }
    if (q.maxAmount !== undefined) {
      havingConds.push(sql`${sumExpr} <= ${q.maxAmount}::numeric`);
    }

    const needsJoin = needsCoreJoin(q.filter, EXEC_CORE_FIELDS);
    try {
      let base = db.selectFrom('budget.execution_line_items as eli');
      if (needsJoin) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'eli.entity_cui')
          .leftJoin('core.territories as t', 't.id', 'e.territory_id');
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
        .limit(q.complete === true ? limit + 1 : limit)
        .execute();
      if (q.complete === true && rows.length > limit) {
        return err(
          invalidInput(
            `classification aggregate exceeds the ${String(limit)}-row completeness guard`,
            'limit'
          )
        );
      }
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
  // UAT/county heatmaps (MV → canonical territory rollups)
  // ───────────────────────────────────────────────────────────────────────────

  const uatHeatmap = async (
    q: HeatmapQuery
  ): Promise<Result<readonly UatHeatmapPoint[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const money = await singleYearMoneyFactor(options.moneyFactors, q.normalization, q.year);
    if (money.isErr()) return err(money.error);
    const multiplier = money.value;
    const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric`;
    try {
      const result = await sql<{
        territory_id: number;
        entity_cui: string;
        uat_name: string;
        siruta_code: string | null;
        county_code: string | null;
        county_name: string | null;
        region: string | null;
        amount: string;
        per_capita: string | null;
        population: number | null;
      }>`
        select
          territory.id as territory_id,
          territory.uat_code as entity_cui,
          territory.name as uat_name,
          territory.siruta_code,
          territory.county_code,
          territory.county_name,
          territory.region,
          (${amountExpr})::text as amount,
          case
            when ${options.moneyFactors === undefined || q.normalization !== 'PERCENT_GDP'} and territory.population > 0
              then ((${amountExpr}) / territory.population)::text
            else null
          end as per_capita,
          territory.population
        from core.territories territory
        inner join budget.mv_execution_summary_annual mv
          on mv.entity_cui = territory.uat_code
          and mv.year = ${q.year}
          and mv.report_type = ${reportLabel}
        where territory.uat_code is not null
        group by
          territory.id,
          territory.uat_code,
          territory.name,
          territory.siruta_code,
          territory.county_code,
          territory.county_name,
          territory.region,
          territory.population
        order by territory.id asc
      `.execute(db);
      return ok(
        result.rows.map((row) => ({
          territoryId: row.territory_id,
          entityCui: row.entity_cui,
          uatName: row.uat_name,
          sirutaCode: row.siruta_code,
          countyCode: row.county_code,
          countyName: row.county_name,
          region: row.region,
          year: q.year,
          amount: row.amount,
          perCapita: row.per_capita,
          population: row.population,
        }))
      );
    } catch (error) {
      return err(databaseError('uatHeatmap failed', error));
    }
  };

  const countyHeatmap = async (
    q: HeatmapQuery
  ): Promise<Result<readonly CountyHeatmapPoint[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const money = await singleYearMoneyFactor(options.moneyFactors, q.normalization, q.year);
    if (money.isErr()) return err(money.error);
    const multiplier = money.value;
    try {
      // Map data is UAT-grain: join the entity CUI directly to the canonical
      // territory's uat_code. Joining every located public entity through
      // core.public_entities over-counts Bucharest and other institution-rich
      // counties. County population is the canonical county territory value,
      // not SUM(DISTINCT population), which deduplicates equal *values* rather
      // than territories and can double-count county + locality populations.
      const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric`;
      const rows = await sql<{
        county_code: string;
        county_name: string | null;
        county_entity_cui: string | null;
        amount: string;
        per_capita: string | null;
        population: number | null;
        entity_count: string;
      }>`
        with county_info as (
          select distinct on (territory.county_code)
            territory.county_code,
            territory.county_name,
            ${countyExecutiveCuiSql(sql`territory.county_code`)} as county_entity_cui,
            (
              select ${canonicalCountyPopulationAggregate('candidate')}
              from core.territories candidate
              where candidate.county_code = territory.county_code
            )::int as population
          from core.territories territory
          where territory.county_code is not null
          order by
            territory.county_code,
            territory.county_name nulls last,
            territory.id
        )
        select
          county.county_code,
          county.county_name,
          county.county_entity_cui,
          (${amountExpr})::text as amount,
          case
            when ${options.moneyFactors === undefined || q.normalization !== 'PERCENT_GDP'} and county.population > 0
              then ((${amountExpr}) / county.population)::text
            else null
          end as per_capita,
          county.population,
          count(distinct mv.entity_cui)::text as entity_count
        from county_info county
        left join core.territories territory
          on territory.county_code = county.county_code
        left join budget.mv_execution_summary_annual mv
          on mv.entity_cui = territory.uat_code
          and mv.year = ${q.year}
          and mv.report_type = ${reportLabel}
        group by
          county.county_code,
          county.county_name,
          county.county_entity_cui,
          county.population
        having count(mv.entity_cui) > 0
        order by (${amountExpr}) desc nulls last, county.county_code asc
      `.execute(db);
      return ok(
        rows.rows.map((r) => ({
          countyCode: r.county_code,
          countyName: r.county_name,
          countyEntityCui: r.county_entity_cui,
          year: q.year,
          amount: r.amount,
          perCapita: r.per_capita,
          population: r.population,
          entityCount: Number(r.entity_count),
        }))
      );
    } catch (error) {
      return err(databaseError('countyHeatmap failed', error));
    }
  };

  return { aggregateByClassification, uatHeatmap, countyHeatmap };
};
