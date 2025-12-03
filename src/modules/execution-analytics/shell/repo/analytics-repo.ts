/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/restrict-template-expressions -- Kysely query builder requires dynamic typing and conditional checks */
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, type DataSeries, type DataPoint } from '@/common/types/temporal.js';

import type { AnalyticsError } from '../../core/errors.js';
import type { AnalyticsFilter, AnalyticsRepository } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

/**
 * Formats database row to date string based on period type.
 *
 * Output format matches the DataPoint.date specification:
 * - YEAR: YYYY (e.g., 2024)
 * - MONTH: YYYY-MM (e.g., 2024-03)
 * - QUARTER: YYYY-QN (e.g., 2024-Q1)
 */
function formatDateFromRow(
  year: number,
  periodValue: number,
  periodType: 'MONTH' | 'QUARTER' | 'YEAR'
): string {
  if (periodType === 'MONTH') {
    const month = String(periodValue).padStart(2, '0');
    return `${year}-${month}`;
  }

  if (periodType === 'QUARTER') {
    return `${year}-Q${periodValue}`;
  }

  // YEAR
  return `${year}`;
}

/**
 * Maps period type to Frequency enum
 */
function getFrequency(periodType: 'MONTH' | 'QUARTER' | 'YEAR'): Frequency {
  if (periodType === 'MONTH') return Frequency.MONTHLY;
  if (periodType === 'QUARTER') return Frequency.QUARTERLY;
  return Frequency.YEARLY;
}

/**
 * Kysely-based implementation of AnalyticsRepository.
 *
 * IMPORTANT: This repository implements the "aggregate-after-normalize" pattern.
 *
 * It ALWAYS returns data as a time series (DataSeries) with individual
 * data points per period. This is critical because:
 *
 * 1. Normalization factors (CPI, exchange rates) vary by year
 * 2. To correctly normalize multi-year data, we must apply factors per-point
 * 3. Any cross-period aggregation must happen AFTER normalization
 *
 * DATA FORMAT
 * -----------
 * - Values are in nominal RON (no inflation adjustment)
 * - Each point represents the SUM of matching records for that period
 * - Points are ordered chronologically
 *
 * SINGLE-PERIOD QUERIES
 * ---------------------
 * When the filter specifies a single year/quarter/month, the result
 * is still a DataSeries with one data point. This maintains consistency
 * and allows the normalization pipeline to work uniformly.
 */
export class KyselyAnalyticsRepo implements AnalyticsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getAggregatedSeries(filter: AnalyticsFilter): Promise<Result<DataSeries, AnalyticsError>> {
    try {
      // Start building the query on executionlineitems (lowercase, as PostgreSQL converts unquoted table names)
      // We define the base query. Note: We use 'any' for intermediate query builder
      // to handle the complexity of conditional joins and selects without complex generic passing.
      let query: any = this.db.selectFrom('executionlineitems as eli').select(['eli.year']);

      // Determine aggregation and grouping based on period type
      const periodType = filter.report_period.type;

      if (periodType === 'MONTH') {
        query = query
          .select('eli.month as period_value')
          .select(sql<string>`COALESCE(SUM(eli.monthly_amount), 0)`.as('amount'))
          .groupBy(['eli.year', 'eli.month'])
          .orderBy('eli.year', 'asc')
          .orderBy('eli.month', 'asc');
      } else if (periodType === 'QUARTER') {
        query = query
          .select('eli.quarter as period_value')
          .select(sql<string>`COALESCE(SUM(eli.quarterly_amount), 0)`.as('amount'))
          .groupBy(['eli.year', 'eli.quarter'])
          .orderBy('eli.year', 'asc')
          .orderBy('eli.quarter', 'asc');

        // Enforce quarterly data flag
        query = query.where('eli.is_quarterly', '=', true);
      } else {
        // YEAR
        query = query
          .select('eli.year as period_value')
          .select(sql<string>`COALESCE(SUM(eli.ytd_amount), 0)`.as('amount'))
          .groupBy('eli.year')
          .orderBy('eli.year', 'asc');

        // Enforce yearly data flag
        query = query.where('eli.is_yearly', '=', true);
      }

      // Apply Filters

      // 1. Account Category
      query = query.where('eli.account_category', '=', filter.account_category);

      // 2. Period Filter
      const { selection } = filter.report_period;
      if (selection.interval != null) {
        const startYear = parseInt(selection.interval.start.substring(0, 4), 10);
        const endYear = parseInt(selection.interval.end.substring(0, 4), 10);

        if (!Number.isNaN(startYear)) query = query.where('eli.year', '>=', startYear);
        if (!Number.isNaN(endYear)) query = query.where('eli.year', '<=', endYear);
      }

      if (selection.dates != null && selection.dates.length > 0) {
        const years = selection.dates
          .map((d) => parseInt(d.substring(0, 4), 10))
          .filter((y) => !Number.isNaN(y));
        if (years.length > 0) {
          query = query.where('eli.year', 'in', years);
        }
      }

      // 3. Dimensions & IDs
      if (filter.report_type != null) {
        query = query.where('eli.report_type', '=', filter.report_type);
      }
      if (filter.main_creditor_cui != null) {
        query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
      }
      if (filter.report_ids?.length) {
        query = query.where('eli.report_id', 'in', filter.report_ids);
      }
      if (filter.entity_cuis?.length) {
        query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
      }
      if (filter.funding_source_ids?.length) {
        query = query.where('eli.funding_source_id', 'in', filter.funding_source_ids.map(Number));
      }
      if (filter.budget_sector_ids?.length) {
        query = query.where('eli.budget_sector_id', 'in', filter.budget_sector_ids.map(Number));
      }

      // 4. Codes (Functional/Economic/Program)
      if (filter.functional_codes?.length) {
        query = query.where('eli.functional_code', 'in', filter.functional_codes);
      }
      if (filter.functional_prefixes?.length) {
        const prefixes = filter.functional_prefixes;
        query = query.where((eb: any) => {
          const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
          return eb.or(ors);
        });
      }

      if (filter.economic_codes?.length) {
        query = query.where('eli.economic_code', 'in', filter.economic_codes);
      }
      if (filter.economic_prefixes?.length) {
        const prefixes = filter.economic_prefixes;
        query = query.where((eb: any) => {
          const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
          return eb.or(ors);
        });
      }
      if (filter.program_codes?.length) {
        query = query.where('eli.program_code', 'in', filter.program_codes);
      }

      // 5. Aggregation Constraints
      if (filter.item_min_amount != null) {
        query = query.where('eli.ytd_amount', '>=', String(filter.item_min_amount));
      }
      if (filter.item_max_amount != null) {
        query = query.where('eli.ytd_amount', '<=', String(filter.item_max_amount));
      }

      // 6. Join Logic (Entities / UATs)
      const needsEntityJoin =
        filter.entity_types?.length ||
        filter.is_uat != null ||
        filter.uat_ids?.length ||
        filter.county_codes?.length ||
        (filter.exclude &&
          (filter.exclude.entity_types?.length ||
            filter.exclude.uat_ids?.length ||
            filter.exclude.county_codes?.length));

      if (needsEntityJoin) {
        query = query.leftJoin('entities as e', 'eli.entity_cui', 'e.cui');
      }

      const needsUatJoin = filter.county_codes?.length || filter.exclude?.county_codes?.length;

      if (needsUatJoin) {
        query = query.leftJoin('uats as u', 'e.uat_id', 'u.id');
      }

      // Apply Entity/UAT Filters
      if (filter.entity_types?.length) {
        query = query.where('e.entity_type', 'in', filter.entity_types);
      }
      if (filter.is_uat != null) {
        query = query.where('e.is_uat', '=', filter.is_uat);
      }
      if (filter.uat_ids?.length) {
        query = query.where('e.uat_id', 'in', filter.uat_ids.map(Number));
      }
      if (filter.county_codes?.length) {
        query = query.where('u.county_code', 'in', filter.county_codes);
      }

      // 7. Exclusions
      if (filter.exclude) {
        const ex = filter.exclude;
        if (ex.report_ids?.length) query = query.where('eli.report_id', 'not in', ex.report_ids);
        if (ex.entity_cuis?.length) query = query.where('eli.entity_cui', 'not in', ex.entity_cuis);

        if (ex.functional_prefixes?.length) {
          const prefixes = ex.functional_prefixes;
          query = query.where((eb: any) => {
            const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
            return eb.not(eb.or(ors));
          });
        }

        if (ex.entity_types?.length)
          query = query.where('e.entity_type', 'not in', ex.entity_types);
        if (ex.county_codes?.length)
          query = query.where('u.county_code', 'not in', ex.county_codes);
      }

      // Execute
      const rows = await query.execute();

      // Convert rows to DataPoint array
      const dataPoints: DataPoint[] = rows.map((r: any) => ({
        date: formatDateFromRow(
          r.year,
          r.period_value != null ? Number(r.period_value) : r.year,
          periodType
        ),
        value: new Decimal(r.amount),
      }));

      // Build DataSeries
      const series: DataSeries = {
        frequency: getFrequency(periodType),
        data: dataPoints,
      };

      return ok(series);
    } catch (error) {
      return err({
        type: 'DatabaseError',
        message: error instanceof Error ? error.message : 'Unknown DB Error',
        cause: error,
      });
    }
  }
}

// Factory
export const makeAnalyticsRepo = (db: BudgetDbClient): AnalyticsRepository => {
  return new KyselyAnalyticsRepo(db);
};
