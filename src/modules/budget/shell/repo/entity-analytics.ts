/**
 * Budget repository — ENTITY ANALYTICS on the MV path (codebase plan §WP5):
 * the per-entity execution and commitment summaries and the three timeseries
 * (execution, aggregate, commitment), all read from the six summary MVs, never
 * the fact table, with normalization applied per point (invariant 2 of
 * `budget-repo.ts`). Moved out of the `makeBudgetRepo` closure unchanged; the
 * closure state it used arrives as the shared context.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  databaseError,
  invalidInput,
  normalizeCui,
} from '@/modules/shared/index.js';

import { isPerCapita } from './analytics.js';
import {
  commitMvName,
  composeAnd,
  execMvName,
  mapCommitmentSummaryRow,
  metricColumn,
  monthlyCommitmentGap,
  seriesPoint,
  toCamel,
  type BudgetRepoContext,
} from './budget-repo-shared.js';
import { execReportType } from './mappers.js';
import { seriesMoneyFactor } from './money-factor.js';
import {
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_REPORT_TYPE_LABELS,
} from '../../core/constants.js';
import { needsMoneyFactor } from '../../core/money-options.js';

import type {
  AggregateTimeseriesQuery,
  BudgetEntitySummary,
  BudgetSeriesPoint,
  CommitmentEntitySummary,
  CommitmentSummaryQuery,
  CommitmentTimeseriesQuery,
  SummaryQuery,
  TimeseriesQuery,
} from '../../core/types.js';

export const makeEntityAnalyticsReads = (ctx: BudgetRepoContext) => {
  const { db, options, asOf } = ctx;

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
    if (
      options.moneyFactors === undefined &&
      (q.currency !== undefined || q.inflationAdjusted !== undefined)
    )
      return err({
        type: 'ServiceUnavailable',
        message: 'Native monetary options are unavailable',
      });
    const cui = normalizeCui(q.entityCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'entityCui'));
    const creditor = q.mainCreditorCui === undefined ? undefined : normalizeCui(q.mainCreditorCui);
    if (creditor === null) return err(invalidInput('invalid CUI format', 'mainCreditorCui'));
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const perCapita = isPerCapita(q.normalization);
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.entity_cui = ${cui}`,
        sql`mv.report_type = ${reportLabel}`,
      ];
      if (creditor !== undefined) conds.push(sql`mv.main_creditor_cui = ${creditor}`);
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
      const needsAnnualPopulation = perCapita && options.populationRelation !== undefined;
      const needsFactorYears = needsMoneyFactor(q.normalization, q);
      const yearsPresent =
        needsAnnualPopulation || needsFactorYears
          ? await db
              .selectFrom(execMvName(q.frequency))
              .leftJoin('core.public_entities as pe', 'pe.cui', 'mv.entity_cui')
              .select(['mv.year', 'pe.territory_id', 'pe.is_territorial_executive'])
              .distinct()
              .where(composeAnd(conds))
              .execute()
          : [];
      let annualPopulation: RawBuilder<unknown> | undefined;
      let anchor: number | undefined;
      if (needsAnnualPopulation) {
        const anchors = [
          ...new Set(
            yearsPresent.flatMap((row) =>
              row.is_territorial_executive === true && row.territory_id !== null
                ? [row.territory_id]
                : []
            )
          ),
        ];
        anchor = anchors[0];
        if (anchor === undefined) return ok([]);
        const population = await options.populationRelation({
          territoryIds: anchors,
          years: yearsPresent.map((row) => row.year),
        });
        if (population.isErr()) return err(population.error);
        annualPopulation = population.value;
      }
      const factor = await seriesMoneyFactor(
        options.moneyFactors,
        q.normalization,
        yearsPresent.map((y) => y.year),
        q
      );
      if (factor.isErr()) return err(factor.error);
      const multCase = factor.value;
      // Per-capita divides by entity population in SQL (entity-grain; §3.4).
      // Use the validated CUI parameter instead of mv.entity_cui so the
      // aggregate query never references an ungrouped MV column.
      const popExpr =
        annualPopulation !== undefined
          ? sql`(select p.population from (${annualPopulation}) p
          where p.territory_id=${anchor} and p.year=mv.year)`
          : perCapita
            ? sql`(
            select nullif(
              case
                when pe.is_territorial_executive then t.population
                else null
              end,
              0
            )
            from core.public_entities pe
            left join core.territories t
              on t.id = pe.territory_id
            where pe.cui = ${cui}
          )`
            : sql`1`;

      // The execution MVs retain main_creditor_cui in their grain. After any requested
      // creditor filter, collapse the remaining rows before
      // emitting one point per period (the same rule used by rankings).
      const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multCase}`;
      const normalizedAmountExpr = perCapita
        ? sql`(${amountExpr} / nullif((${popExpr}), 0))`
        : amountExpr;

      let seriesQuery = db
        .selectFrom(execMvName(q.frequency))
        .select([
          'mv.year',
          periodSelect.as('period'),
          sql<string>`(${normalizedAmountExpr})::text`.as('amount'),
        ])
        .where(composeAnd(conds))
        .groupBy('mv.year')
        .groupBy(periodSelect)
        .having(sql<SqlBool>`${multCase} is not null`);
      if (perCapita) {
        // Unknown denominators are no-data, never a fabricated zero amount.
        seriesQuery = seriesQuery.having(sql<SqlBool>`(${popExpr}) > 0`);
      }
      const rows = await seriesQuery
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

  const aggregateTimeseries = async (
    q: AggregateTimeseriesQuery
  ): Promise<Result<readonly BudgetSeriesPoint[], ApiError>> => {
    if (isPerCapita(q.normalization)) {
      return err(
        invalidInput(
          'per-capita normalization requires an explicit entity or territory scope',
          'normalization'
        )
      );
    }
    const invalidYearFrom = !Number.isInteger(q.yearFrom) || q.yearFrom <= 0;
    const invalidYearTo = !Number.isInteger(q.yearTo) || q.yearTo <= 0;
    const invalidRange = q.yearFrom > q.yearTo || q.yearTo - q.yearFrom >= 25;
    if (invalidYearFrom || invalidYearTo || invalidRange) {
      return err(invalidInput('aggregate timeseries year range is invalid or too wide', 'year'));
    }
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    try {
      const conds: RawBuilder<unknown>[] = [sql`mv.report_type = ${reportLabel}`];
      conds.push(sql`mv.year >= ${q.yearFrom}`);
      conds.push(sql`mv.year <= ${q.yearTo}`);
      if (q.isUat !== undefined) conds.push(sql`e.is_uat = ${q.isUat}`);
      if (q.isTerritorialExecutive !== undefined)
        conds.push(sql`e.is_territorial_executive = ${q.isTerritorialExecutive}`);
      const periodSelect =
        q.frequency === 'MONTH'
          ? sql<number | null>`mv.month`
          : q.frequency === 'QUARTER'
            ? sql<number | null>`mv.quarter`
            : sql<number | null>`null::int`;
      let multiplier: RawBuilder<unknown> = sql`1::numeric`;
      if (q.normalization !== 'TOTAL') {
        let yearsBase = db.selectFrom(execMvName(q.frequency));
        if (q.isUat !== undefined || q.isTerritorialExecutive !== undefined) {
          yearsBase = yearsBase.leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui');
        }
        const yearsPresent = await yearsBase
          .select(sql<number>`distinct mv.year`.as('year'))
          .where(composeAnd(conds))
          .execute();
        const factor = await seriesMoneyFactor(
          options.moneyFactors,
          q.normalization,
          yearsPresent.map((row) => row.year)
        );
        if (factor.isErr()) return err(factor.error);
        multiplier = factor.value;
      }
      const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}`;
      let seriesBase = db.selectFrom(execMvName(q.frequency));
      if (q.isUat !== undefined || q.isTerritorialExecutive !== undefined) {
        seriesBase = seriesBase.leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui');
      }
      const rows = await seriesBase
        .select([
          'mv.year',
          periodSelect.as('period'),
          sql<string>`(${amountExpr})::text`.as('amount'),
        ])
        .where(composeAnd(conds))
        .groupBy('mv.year')
        .groupBy(periodSelect)
        .having(sql<SqlBool>`${multiplier} is not null`)
        .orderBy('mv.year', 'asc')
        .orderBy(periodSelect, 'asc')
        .execute();
      return ok(
        rows.map((row) =>
          seriesPoint(row.year, (row as { period: number | null }).period, q.frequency, row.amount)
        )
      );
    } catch (error) {
      return err(databaseError('aggregateTimeseries failed', error));
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
          sql<string>`sum(coalesce(mv.${sql.ref(q.metric)},0))::text`.as('amount'),
        ])
        .where(composeAnd(conds))
        .groupBy('mv.year')
        .groupBy(periodSelect)
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

  return {
    getEntitySummary,
    getCommitmentSummary,
    executionTimeseries,
    aggregateTimeseries,
    commitmentTimeseries,
  };
};
