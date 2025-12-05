/**
 * Entity Analytics Summary Repository Implementation
 *
 * Queries materialized views (mv_summary_*) for entity totals and trends.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unnecessary-condition -- Kysely dynamic query builder requires type flexibility */
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import {
  createDatabaseError,
  createTimeoutError,
  createInvalidPeriodError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';

import type { EntityAnalyticsSummaryRepository } from '../../core/ports.js';
import type { EntityTotals, ReportPeriodInput, DataSeries } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw row from summary views.
 */
interface SummaryRow {
  year: number;
  quarter?: number;
  month?: number;
  total_income: string;
  total_expense: string;
  budget_balance: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Entity Analytics Summary Repository.
 */
class KyselyEntityAnalyticsSummaryRepo implements EntityAnalyticsSummaryRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getTotals(
    cui: string,
    period: ReportPeriodInput,
    reportType: string,
    mainCreditorCui?: string
  ): Promise<Result<EntityTotals, EntityError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      const { startYear, endYear } = extractYearRangeFromSelection(period.selection);

      // Query the appropriate materialized view based on frequency
      let rows: SummaryRow[];

      switch (period.frequency) {
        case Frequency.YEAR:
          rows = await this.queryAnnualTotals(cui, startYear, endYear, reportType, mainCreditorCui);
          break;
        case Frequency.QUARTER:
          rows = await this.queryQuarterlyTotals(
            cui,
            period,
            startYear,
            endYear,
            reportType,
            mainCreditorCui
          );
          break;
        case Frequency.MONTH:
          rows = await this.queryMonthlyTotals(
            cui,
            period,
            startYear,
            endYear,
            reportType,
            mainCreditorCui
          );
          break;
        default:
          return err(createInvalidPeriodError(`Unknown frequency: ${String(period.frequency)}`));
      }

      // Sum up all rows if multiple periods selected
      let totalIncome = new Decimal(0);
      let totalExpenses = new Decimal(0);
      let budgetBalance = new Decimal(0);

      for (const row of rows) {
        totalIncome = totalIncome.plus(new Decimal(row.total_income || '0'));
        totalExpenses = totalExpenses.plus(new Decimal(row.total_expense || '0'));
        budgetBalance = budgetBalance.plus(new Decimal(row.budget_balance || '0'));
      }

      return ok({
        totalIncome: totalIncome.toNumber(),
        totalExpenses: totalExpenses.toNumber(),
        budgetBalance: budgetBalance.toNumber(),
      });
    } catch (error) {
      return this.handleQueryError(error, 'getTotals');
    }
  }

  async getTrend(
    cui: string,
    period: ReportPeriodInput,
    reportType: string,
    metric: 'income' | 'expenses' | 'balance',
    mainCreditorCui?: string
  ): Promise<Result<DataSeries, EntityError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      const { startYear, endYear } = extractYearRangeFromSelection(period.selection);

      // Query the appropriate materialized view based on frequency
      let dataPoints: { date: string; value: Decimal }[];

      switch (period.frequency) {
        case Frequency.YEAR:
          dataPoints = await this.queryAnnualTrend(
            cui,
            startYear,
            endYear,
            reportType,
            metric,
            mainCreditorCui
          );
          break;
        case Frequency.QUARTER:
          dataPoints = await this.queryQuarterlyTrend(
            cui,
            period,
            startYear,
            endYear,
            reportType,
            metric,
            mainCreditorCui
          );
          break;
        case Frequency.MONTH:
          dataPoints = await this.queryMonthlyTrend(
            cui,
            period,
            startYear,
            endYear,
            reportType,
            metric,
            mainCreditorCui
          );
          break;
        default:
          return err(createInvalidPeriodError(`Unknown frequency: ${String(period.frequency)}`));
      }

      return ok({
        frequency: period.frequency,
        data: dataPoints,
      });
    } catch (error) {
      return this.handleQueryError(error, 'getTrend');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Totals Queries
  // ─────────────────────────────────────────────────────────────────────────────

  private async queryAnnualTotals(
    cui: string,
    startYear: number,
    endYear: number,
    reportType: string,
    mainCreditorCui?: string
  ): Promise<SummaryRow[]> {
    let query: any = this.db
      .selectFrom('mv_summary_annual')
      .select(['total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    return query.execute();
  }

  private async queryQuarterlyTotals(
    cui: string,
    period: ReportPeriodInput,
    startYear: number,
    endYear: number,
    reportType: string,
    mainCreditorCui?: string
  ): Promise<SummaryRow[]> {
    let query: any = this.db
      .selectFrom('mv_summary_quarterly')
      .select(['year', 'quarter', 'total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    // Apply quarter filters if specific dates/interval provided
    query = this.applyQuarterFilters(query, period);

    return query.execute();
  }

  private async queryMonthlyTotals(
    cui: string,
    period: ReportPeriodInput,
    startYear: number,
    endYear: number,
    reportType: string,
    mainCreditorCui?: string
  ): Promise<SummaryRow[]> {
    let query: any = this.db
      .selectFrom('mv_summary_monthly')
      .select(['year', 'month', 'total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    // Apply month filters if specific dates/interval provided
    query = this.applyMonthFilters(query, period);

    return query.execute();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Trend Queries
  // ─────────────────────────────────────────────────────────────────────────────

  private async queryAnnualTrend(
    cui: string,
    startYear: number,
    endYear: number,
    reportType: string,
    metric: 'income' | 'expenses' | 'balance',
    mainCreditorCui?: string
  ): Promise<{ date: string; value: Decimal }[]> {
    const metricColumn = this.getMetricColumn(metric);

    let query: any = this.db
      .selectFrom('mv_summary_annual')
      .select(['year', 'total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    query = query.orderBy('year', 'asc');

    const rows: SummaryRow[] = await query.execute();

    return rows.map((row) => ({
      date: String(row.year),
      value: new Decimal(this.extractMetricValue(row, metricColumn)),
    }));
  }

  private async queryQuarterlyTrend(
    cui: string,
    period: ReportPeriodInput,
    startYear: number,
    endYear: number,
    reportType: string,
    metric: 'income' | 'expenses' | 'balance',
    mainCreditorCui?: string
  ): Promise<{ date: string; value: Decimal }[]> {
    const metricColumn = this.getMetricColumn(metric);

    let query: any = this.db
      .selectFrom('mv_summary_quarterly')
      .select(['year', 'quarter', 'total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    query = this.applyQuarterFilters(query, period);
    query = query.orderBy('year', 'asc').orderBy('quarter', 'asc');

    const rows: SummaryRow[] = await query.execute();

    return rows.map((row) => ({
      date: `${String(row.year)}-Q${String(row.quarter ?? 1)}`,
      value: new Decimal(this.extractMetricValue(row, metricColumn)),
    }));
  }

  private async queryMonthlyTrend(
    cui: string,
    period: ReportPeriodInput,
    startYear: number,
    endYear: number,
    reportType: string,
    metric: 'income' | 'expenses' | 'balance',
    mainCreditorCui?: string
  ): Promise<{ date: string; value: Decimal }[]> {
    const metricColumn = this.getMetricColumn(metric);

    let query: any = this.db
      .selectFrom('mv_summary_monthly')
      .select(['year', 'month', 'total_income', 'total_expense', 'budget_balance'])
      .where('entity_cui', '=', cui)
      .where('report_type', '=', reportType as any)
      .where('year', '>=', startYear)
      .where('year', '<=', endYear);

    if (mainCreditorCui !== undefined) {
      query = query.where('main_creditor_cui', '=', mainCreditorCui);
    } else {
      query = query.where('main_creditor_cui', 'is', null);
    }

    query = this.applyMonthFilters(query, period);
    query = query.orderBy('year', 'asc').orderBy('month', 'asc');

    const rows: SummaryRow[] = await query.execute();

    return rows.map((row) => ({
      date: `${String(row.year)}-${String(row.month ?? 1).padStart(2, '0')}`,
      value: new Decimal(this.extractMetricValue(row, metricColumn)),
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private getMetricColumn(metric: 'income' | 'expenses' | 'balance'): keyof SummaryRow {
    switch (metric) {
      case 'income':
        return 'total_income';
      case 'expenses':
        return 'total_expense';
      case 'balance':
        return 'budget_balance';
    }
  }

  /**
   * Extracts the value for a given metric column from a summary row.
   */
  private extractMetricValue(row: SummaryRow, metricColumn: keyof SummaryRow): string {
    const value = row[metricColumn];
    return value !== undefined && value !== null ? String(value) : '0';
  }

  private applyQuarterFilters(query: any, period: ReportPeriodInput): any {
    const selection = period.selection;

    // If specific dates are provided, filter by them
    if (selection.dates !== undefined && selection.dates.length > 0) {
      const quarterConditions: { year: number; quarter: number }[] = [];

      for (const date of selection.dates) {
        const parsed = this.parseQuarterDate(date);
        if (parsed !== null) {
          quarterConditions.push(parsed);
        }
      }

      if (quarterConditions.length > 0) {
        // Build OR conditions for each quarter
        return query.where((eb: any) =>
          eb.or(
            quarterConditions.map((cond) =>
              eb.and([eb('year', '=', cond.year), eb('quarter', '=', cond.quarter)])
            )
          )
        );
      }
    }

    // If interval is provided, apply range filters
    if (selection.interval !== undefined) {
      const start = this.parseQuarterDate(selection.interval.start);
      const end = this.parseQuarterDate(selection.interval.end);

      if (start !== null && end !== null) {
        // Use composite comparison: (year, quarter) >= (startYear, startQuarter)
        query = query.where((eb: any) =>
          eb.or([
            eb('year', '>', start.year),
            eb.and([eb('year', '=', start.year), eb('quarter', '>=', start.quarter)]),
          ])
        );
        query = query.where((eb: any) =>
          eb.or([
            eb('year', '<', end.year),
            eb.and([eb('year', '=', end.year), eb('quarter', '<=', end.quarter)]),
          ])
        );
      }
    }

    return query;
  }

  private applyMonthFilters(query: any, period: ReportPeriodInput): any {
    const selection = period.selection;

    // If specific dates are provided, filter by them
    if (selection.dates !== undefined && selection.dates.length > 0) {
      const monthConditions: { year: number; month: number }[] = [];

      for (const date of selection.dates) {
        const parsed = this.parseMonthDate(date);
        if (parsed !== null) {
          monthConditions.push(parsed);
        }
      }

      if (monthConditions.length > 0) {
        // Build OR conditions for each month
        return query.where((eb: any) =>
          eb.or(
            monthConditions.map((cond) =>
              eb.and([eb('year', '=', cond.year), eb('month', '=', cond.month)])
            )
          )
        );
      }
    }

    // If interval is provided, apply range filters
    if (selection.interval !== undefined) {
      const start = this.parseMonthDate(selection.interval.start);
      const end = this.parseMonthDate(selection.interval.end);

      if (start !== null && end !== null) {
        // Use composite comparison
        query = query.where((eb: any) =>
          eb.or([
            eb('year', '>', start.year),
            eb.and([eb('year', '=', start.year), eb('month', '>=', start.month)]),
          ])
        );
        query = query.where((eb: any) =>
          eb.or([
            eb('year', '<', end.year),
            eb.and([eb('year', '=', end.year), eb('month', '<=', end.month)]),
          ])
        );
      }
    }

    return query;
  }

  /**
   * Parses a quarter date string like "2023-Q2".
   */
  private parseQuarterDate(date: string): { year: number; quarter: number } | null {
    const match = /^(\d{4})-Q([1-4])$/i.exec(date);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        year: Number.parseInt(match[1], 10),
        quarter: Number.parseInt(match[2], 10),
      };
    }
    // Also try parsing as just year
    const yearMatch = /^(\d{4})$/.exec(date);
    if (yearMatch?.[1] !== undefined) {
      return { year: Number.parseInt(yearMatch[1], 10), quarter: 1 };
    }
    return null;
  }

  /**
   * Parses a month date string like "2023-06".
   */
  private parseMonthDate(date: string): { year: number; month: number } | null {
    const match = /^(\d{4})-(\d{2})$/.exec(date);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        year: Number.parseInt(match[1], 10),
        month: Number.parseInt(match[2], 10),
      };
    }
    // Also try parsing as just year
    const yearMatch = /^(\d{4})$/.exec(date);
    if (yearMatch?.[1] !== undefined) {
      return { year: Number.parseInt(yearMatch[1], 10), month: 1 };
    }
    return null;
  }

  /**
   * Handles query errors and converts to domain errors.
   */
  private handleQueryError(error: unknown, operation: string): Result<never, EntityError> {
    if (isTimeoutError(error)) {
      return err(createTimeoutError(`Entity analytics ${operation} query timed out`, error));
    }
    return err(createDatabaseError(`Entity analytics ${operation} failed`, error));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an EntityAnalyticsSummaryRepository instance.
 */
export const makeEntityAnalyticsSummaryRepo = (
  db: BudgetDbClient
): EntityAnalyticsSummaryRepository => {
  return new KyselyEntityAnalyticsSummaryRepo(db);
};
