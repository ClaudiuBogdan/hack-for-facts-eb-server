/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
/**
 * UAT Analytics Repository - Kysely Implementation
 *
 * Fetches budget execution data aggregated by UAT for heatmap visualization.
 * Returns data grouped by (UAT, year) to support year-by-year EUR conversion.
 */

import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  parsePeriodDate,
  extractYear,
  toNumericIds,
} from '@/modules/execution-analytics/shell/repo/query-helpers.js';

import { createDatabaseError, type UATAnalyticsError } from '../../core/errors.js';

import type { UATAnalyticsRepository } from '../../core/ports.js';
import type { HeatmapUATDataPoint } from '../../core/types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of UATs to return */
const MAX_RESULTS = 50_000;

/** Query timeout in milliseconds (45 seconds) */
const QUERY_TIMEOUT_MS = 45_000;

// ============================================================================
// Types
// ============================================================================

/**
 * Raw row returned from aggregation query.
 */
interface AggregatedRow {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  siruta_code: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;
  year: number;
  total_amount: string;
}

/**
 * Query builder type - using unknown to avoid blanket any disables.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely dynamic query builder
type DynamicQuery = any;

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of UATAnalyticsRepository.
 *
 * This repository aggregates ExecutionLineItems by entity_cui and year,
 * then joins with UATs table to get UAT metadata for heatmap visualization.
 *
 * DATA FORMAT
 * -----------
 * - Returns one row per (UAT, year) combination
 * - Amounts are in nominal RON (no normalization applied)
 * - Use-case layer handles EUR conversion and per-capita calculations
 */
export class KyselyUATAnalyticsRepo implements UATAnalyticsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getHeatmapData(
    filter: AnalyticsFilter
  ): Promise<Result<HeatmapUATDataPoint[], UATAnalyticsError>> {
    const frequency = this.getFrequency(filter);

    try {
      // Set statement timeout for this query
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build the aggregation query
      let query: DynamicQuery = this.db
        .selectFrom('executionlineitems as eli')
        .innerJoin('uats as u', 'eli.entity_cui', 'u.uat_code')
        .select([
          'u.id as uat_id',
          'u.uat_code',
          'u.name as uat_name',
          'u.siruta_code',
          'u.county_code',
          'u.county_name',
          'u.region',
          'u.population',
          'eli.year',
        ]);

      // Add amount aggregation based on frequency
      query = this.applyAmountAggregation(query, frequency);

      // Apply frequency flag
      query = this.applyFrequencyFlag(query, frequency);

      // Apply period filters
      query = this.applyPeriodFilters(query, filter, frequency);

      // Apply dimension filters
      query = this.applyDimensionFilters(query, filter);

      // Apply code filters
      query = this.applyCodeFilters(query, filter);

      // Apply entity join and filters (for is_uat, entity_types)
      query = this.applyEntityFilters(query, filter);

      // Apply UAT-specific filters (county, region, population)
      query = this.applyUATFilters(query, filter);

      // Apply exclusions
      query = this.applyExclusions(query, filter);

      // Apply amount constraints
      query = this.applyAmountConstraints(query, filter, frequency);

      // Group by UAT and year
      query = query.groupBy([
        'u.id',
        'u.uat_code',
        'u.name',
        'u.siruta_code',
        'u.county_code',
        'u.county_name',
        'u.region',
        'u.population',
        'eli.year',
      ]);

      // Apply aggregate thresholds (HAVING clause)
      query = this.applyAggregateThresholds(query, filter, frequency);

      // Order and limit
      query = query.orderBy('u.id', 'asc').orderBy('eli.year', 'asc').limit(MAX_RESULTS);

      // Execute query
      const rows: AggregatedRow[] = await query.execute();

      // Transform to domain type
      const dataPoints = this.transformRows(rows);

      return ok(dataPoints);
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  // ==========================================================================
  // Query Building Methods
  // ==========================================================================

  /**
   * Gets the frequency from the filter's report period.
   */
  private getFrequency(filter: AnalyticsFilter): Frequency {
    // report_period.type is already Frequency enum
    return filter.report_period.type;
  }

  /**
   * Applies amount aggregation based on frequency.
   */
  private applyAmountAggregation(query: DynamicQuery, frequency: Frequency): DynamicQuery {
    if (frequency === Frequency.MONTH) {
      return query.select(sql<string>`COALESCE(SUM(eli.monthly_amount), 0)`.as('total_amount'));
    }
    if (frequency === Frequency.QUARTER) {
      return query.select(sql<string>`COALESCE(SUM(eli.quarterly_amount), 0)`.as('total_amount'));
    }
    // YEAR
    return query.select(sql<string>`COALESCE(SUM(eli.ytd_amount), 0)`.as('total_amount'));
  }

  /**
   * Applies frequency flag filter.
   */
  private applyFrequencyFlag(query: DynamicQuery, frequency: Frequency): DynamicQuery {
    if (frequency === Frequency.QUARTER) {
      return query.where('eli.is_quarterly', '=', true);
    }
    if (frequency === Frequency.YEAR) {
      return query.where('eli.is_yearly', '=', true);
    }
    // MONTH: no flag needed
    return query;
  }

  /**
   * Applies period (date range) filters.
   */
  private applyPeriodFilters(
    query: DynamicQuery,
    filter: AnalyticsFilter,
    frequency: Frequency
  ): DynamicQuery {
    const { selection } = filter.report_period;

    // Interval-based filter
    if (selection.interval !== undefined) {
      const start = parsePeriodDate(selection.interval.start);
      const end = parsePeriodDate(selection.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.month)`, '>=', sql`(${start.year}, ${start.month})`)
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.month)`, '<=', sql`(${end.year}, ${end.month})`)
        );
      } else if (
        frequency === Frequency.QUARTER &&
        start?.quarter !== undefined &&
        end?.quarter !== undefined
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '>=', sql`(${start.year}, ${start.quarter})`)
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '<=', sql`(${end.year}, ${end.quarter})`)
        );
      } else {
        // YEAR frequency or fallback
        const startYear = start?.year ?? extractYear(selection.interval.start);
        const endYear = end?.year ?? extractYear(selection.interval.end);

        if (startYear !== null) {
          query = query.where('eli.year', '>=', startYear);
        }
        if (endYear !== null) {
          query = query.where('eli.year', '<=', endYear);
        }
      }
    }

    // Discrete dates filter
    if (selection.dates !== undefined && selection.dates.length > 0) {
      if (frequency === Frequency.MONTH) {
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; month: number } => p?.month !== undefined);

        if (validPeriods.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
          query = query.where((eb: ExpressionBuilder<any, any>) => {
            const conditions = validPeriods.map((p) =>
              eb.and([eb('eli.year', '=', p.year), eb('eli.month', '=', p.month)])
            );
            return eb.or(conditions);
          });
        }
      } else if (frequency === Frequency.QUARTER) {
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);

        if (validPeriods.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
          query = query.where((eb: ExpressionBuilder<any, any>) => {
            const conditions = validPeriods.map((p) =>
              eb.and([eb('eli.year', '=', p.year), eb('eli.quarter', '=', p.quarter)])
            );
            return eb.or(conditions);
          });
        }
      } else {
        // YEAR frequency
        const years = selection.dates
          .map((d) => extractYear(d))
          .filter((y): y is number => y !== null);

        if (years.length > 0) {
          query = query.where('eli.year', 'in', years);
        }
      }
    }

    return query;
  }

  /**
   * Applies dimension filters (account category, report type, etc.).
   */
  private applyDimensionFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    // Required filter
    query = query.where('eli.account_category', '=', filter.account_category);

    // Report type (required for heatmap per spec)
    if (filter.report_type !== undefined) {
      query = query.where('eli.report_type', '=', filter.report_type);
    }

    if (filter.main_creditor_cui !== undefined) {
      query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
    }

    if (filter.report_ids !== undefined && filter.report_ids.length > 0) {
      query = query.where('eli.report_id', 'in', filter.report_ids);
    }

    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
    }

    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(filter.funding_source_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.funding_source_id', 'in', numericIds);
      }
    }

    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(filter.budget_sector_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.budget_sector_id', 'in', numericIds);
      }
    }

    if (filter.expense_types !== undefined && filter.expense_types.length > 0) {
      query = query.where('eli.expense_type', 'in', filter.expense_types);
    }

    return query;
  }

  /**
   * Applies code-based filters (functional, economic, program codes).
   */
  private applyCodeFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'in', filter.functional_codes);
    }

    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixes = filter.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      query = query.where('eli.economic_code', 'in', filter.economic_codes);
    }

    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixes = filter.economic_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    if (filter.program_codes !== undefined && filter.program_codes.length > 0) {
      query = query.where('eli.program_code', 'in', filter.program_codes);
    }

    return query;
  }

  /**
   * Applies entity-specific filters (is_uat, entity_types).
   * Joins with entities table if needed.
   */
  private applyEntityFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    const needsEntityJoin =
      filter.is_uat !== undefined ||
      (filter.entity_types !== undefined && filter.entity_types.length > 0) ||
      (filter.exclude?.entity_types !== undefined && filter.exclude.entity_types.length > 0);

    if (!needsEntityJoin) {
      return query;
    }

    query = query.leftJoin('entities as e', 'eli.entity_cui', 'e.cui');

    if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
      query = query.where('e.entity_type', 'in', filter.entity_types);
    }

    if (filter.is_uat !== undefined) {
      query = query.where('e.is_uat', '=', filter.is_uat);
    }

    return query;
  }

  /**
   * Applies UAT-specific filters (county, region, population, uat_ids).
   */
  private applyUATFilters(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
      const numericIds = toNumericIds(filter.uat_ids);
      if (numericIds.length > 0) {
        query = query.where('u.id', 'in', numericIds);
      }
    }

    if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
      query = query.where('u.county_code', 'in', filter.county_codes);
    }

    if (filter.regions !== undefined && filter.regions.length > 0) {
      query = query.where('u.region', 'in', filter.regions);
    }

    if (filter.min_population !== undefined && filter.min_population !== null) {
      query = query.where(sql`COALESCE(u.population, 0)`, '>=', filter.min_population);
    }

    if (filter.max_population !== undefined && filter.max_population !== null) {
      query = query.where(sql`COALESCE(u.population, 0)`, '<=', filter.max_population);
    }

    return query;
  }

  /**
   * Applies exclusion filters.
   */
  private applyExclusions(query: DynamicQuery, filter: AnalyticsFilter): DynamicQuery {
    if (filter.exclude === undefined) {
      return query;
    }

    const ex = filter.exclude;

    if (ex.report_ids !== undefined && ex.report_ids.length > 0) {
      query = query.where('eli.report_id', 'not in', ex.report_ids);
    }

    if (ex.entity_cuis !== undefined && ex.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'not in', ex.entity_cuis);
    }

    if (ex.functional_codes !== undefined && ex.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'not in', ex.functional_codes);
    }

    if (ex.functional_prefixes !== undefined && ex.functional_prefixes.length > 0) {
      const prefixes = ex.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.not(eb.or(ors));
      });
    }

    // Economic code exclusions - only for non-VN accounts (per spec)
    if (filter.account_category !== 'vn') {
      if (ex.economic_codes !== undefined && ex.economic_codes.length > 0) {
        query = query.where('eli.economic_code', 'not in', ex.economic_codes);
      }

      if (ex.economic_prefixes !== undefined && ex.economic_prefixes.length > 0) {
        const prefixes = ex.economic_prefixes;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) => {
          const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
          return eb.not(eb.or(ors));
        });
      }
    }

    // UAT exclusions
    if (ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
      const numericIds = toNumericIds(ex.uat_ids);
      if (numericIds.length > 0) {
        query = query.where('u.id', 'not in', numericIds);
      }
    }

    if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.county_code', 'is', null), eb('u.county_code', 'not in', ex.county_codes)])
      );
    }

    if (ex.regions !== undefined && ex.regions.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.region', 'is', null), eb('u.region', 'not in', ex.regions)])
      );
    }

    // Entity type exclusions (requires entity join)
    if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('e.entity_type', 'is', null), eb('e.entity_type', 'not in', ex.entity_types)])
      );
    }

    return query;
  }

  /**
   * Applies per-item amount constraints.
   */
  private applyAmountConstraints(
    query: DynamicQuery,
    filter: AnalyticsFilter,
    frequency: Frequency
  ): DynamicQuery {
    const amountColumn =
      frequency === Frequency.MONTH
        ? 'eli.monthly_amount'
        : frequency === Frequency.QUARTER
          ? 'eli.quarterly_amount'
          : 'eli.ytd_amount';

    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      query = query.where(sql.raw(amountColumn), '>=', String(filter.item_min_amount));
    }

    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      query = query.where(sql.raw(amountColumn), '<=', String(filter.item_max_amount));
    }

    return query;
  }

  /**
   * Applies aggregate amount thresholds (HAVING clause).
   */
  private applyAggregateThresholds(
    query: DynamicQuery,
    filter: AnalyticsFilter,
    frequency: Frequency
  ): DynamicQuery {
    const sumExpression =
      frequency === Frequency.MONTH
        ? 'COALESCE(SUM(eli.monthly_amount), 0)'
        : frequency === Frequency.QUARTER
          ? 'COALESCE(SUM(eli.quarterly_amount), 0)'
          : 'COALESCE(SUM(eli.ytd_amount), 0)';

    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      query = query.having(sql.raw(sumExpression), '>=', String(filter.aggregate_min_amount));
    }

    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      query = query.having(sql.raw(sumExpression), '<=', String(filter.aggregate_max_amount));
    }

    return query;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to HeatmapUATDataPoint array.
   */
  private transformRows(rows: AggregatedRow[]): HeatmapUATDataPoint[] {
    return rows.map((row) => ({
      uat_id: row.uat_id,
      uat_code: row.uat_code,
      uat_name: row.uat_name,
      siruta_code: row.siruta_code,
      county_code: row.county_code,
      county_name: row.county_name,
      region: row.region,
      population: row.population,
      year: row.year,
      total_amount: new Decimal(row.total_amount),
    }));
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate UATAnalyticsError.
   */
  private handleQueryError(error: unknown): Result<HeatmapUATDataPoint[], UATAnalyticsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    return err(createDatabaseError(message));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a UATAnalyticsRepository instance.
 */
export const makeUATAnalyticsRepo = (db: BudgetDbClient): UATAnalyticsRepository => {
  return new KyselyUATAnalyticsRepo(db);
};
