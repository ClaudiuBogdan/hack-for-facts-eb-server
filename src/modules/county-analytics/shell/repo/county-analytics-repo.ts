/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Kysely raw SQL template literals require any typing */
/**
 * County Analytics Repository - Kysely Implementation
 *
 * Fetches budget execution data aggregated by county for heatmap visualization.
 * Uses a dual-CTE approach to:
 * 1. Aggregate ExecutionLineItems by entity_cui
 * 2. Compute county metadata (population, entity_cui) with Bucharest special case
 * 3. Roll up entities to counties via LEFT JOIN
 */

import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  parsePeriodDate,
  extractYear,
  toNumericIds,
} from '@/modules/execution-analytics/shell/repo/query-helpers.js';

import { createDatabaseError, type CountyAnalyticsError } from '../../core/errors.js';

import type { CountyAnalyticsRepository } from '../../core/ports.js';
import type { HeatmapCountyDataPoint } from '../../core/types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of result rows (42 counties * ~10 years = ~420) */
const MAX_RESULTS = 5_000;

/** Query timeout in milliseconds (45 seconds) */
const QUERY_TIMEOUT_MS = 45_000;

/** Bucharest SIRUTA code for county-level population lookup */
const BUCHAREST_SIRUTA_CODE = '179132';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw row returned from county aggregation query.
 */
interface AggregatedCountyRow {
  county_code: string;
  county_name: string;
  county_population: number;
  county_entity_cui: string | null;
  year: number;
  total_amount: string;
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of CountyAnalyticsRepository.
 *
 * This repository uses a dual-CTE approach:
 * 1. filtered_aggregates: Aggregates ExecutionLineItems by entity_cui and year
 * 2. county_info: Computes county metadata with Bucharest special case
 * 3. Main query: LEFT JOINs to roll up entities to counties
 *
 * DATA FORMAT
 * -----------
 * - Returns one row per (county, year) combination
 * - Amounts are in nominal RON (no normalization applied)
 * - Use-case layer handles EUR conversion and per-capita calculations
 */
export class KyselyCountyAnalyticsRepo implements CountyAnalyticsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getHeatmapData(
    filter: AnalyticsFilter
  ): Promise<Result<HeatmapCountyDataPoint[], CountyAnalyticsError>> {
    const frequency = this.getFrequency(filter);

    try {
      // Set statement timeout for this query
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build the CTE-based query
      const rows = await this.executeCountyQuery(filter, frequency);

      // Transform to domain type
      const dataPoints = this.transformRows(rows);

      return ok(dataPoints);
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  // ==========================================================================
  // Query Building
  // ==========================================================================

  /**
   * Executes the county aggregation query using dual CTEs.
   */
  private async executeCountyQuery(
    filter: AnalyticsFilter,
    frequency: Frequency
  ): Promise<AggregatedCountyRow[]> {
    // Build the filtered_aggregates CTE conditions
    const filterConditions = this.buildFilterConditions(filter, frequency);
    const entityJoinClause = this.needsEntityJoin(filter)
      ? sql`LEFT JOIN entities AS e ON eli.entity_cui = e.cui`
      : sql``;

    // Get the appropriate sum expression based on frequency
    const sumExpression = this.getSumExpression(frequency);

    // Build HAVING clause for aggregate thresholds
    const havingClause = this.buildHavingClause(filter, frequency);

    // Build the full query with CTEs
    const query = sql<AggregatedCountyRow>`
      WITH filtered_aggregates AS (
        SELECT
          eli.entity_cui,
          eli.year,
          ${sumExpression} AS total_amount
        FROM executionlineitems AS eli
        ${entityJoinClause}
        WHERE ${filterConditions}
        GROUP BY eli.entity_cui, eli.year
        ${havingClause}
      ),
      county_info AS (
        SELECT DISTINCT ON (u.county_code)
          u.county_code,
          u.county_name,
          (
            SELECT MAX(CASE
              WHEN u2.county_code = 'B' AND u2.siruta_code = ${BUCHAREST_SIRUTA_CODE} THEN u2.population
              WHEN u2.county_code != 'B' AND u2.siruta_code = u2.county_code THEN u2.population
              ELSE 0
            END)
            FROM uats AS u2
            WHERE u2.county_code = u.county_code
          ) AS county_population,
          (
            SELECT u3.uat_code
            FROM uats AS u3
            WHERE u3.county_code = u.county_code
              AND (
                (u3.county_code = 'B' AND u3.siruta_code = ${BUCHAREST_SIRUTA_CODE})
                OR (u3.county_code != 'B' AND u3.siruta_code = u3.county_code)
              )
            LIMIT 1
          ) AS county_entity_cui
        FROM uats AS u
        ORDER BY u.county_code
      )
      SELECT
        ci.county_code,
        ci.county_name,
        COALESCE(ci.county_population, 0)::int AS county_population,
        ci.county_entity_cui,
        fa.year,
        COALESCE(SUM(fa.total_amount), 0) AS total_amount
      FROM county_info AS ci
      LEFT JOIN uats AS u ON ci.county_code = u.county_code
      LEFT JOIN filtered_aggregates AS fa ON u.uat_code = fa.entity_cui
      WHERE fa.year IS NOT NULL
      GROUP BY ci.county_code, ci.county_name, ci.county_population, ci.county_entity_cui, fa.year
      ORDER BY ci.county_code, fa.year
      LIMIT ${MAX_RESULTS}
    `;

    const result = await query.execute(this.db);
    return result.rows;
  }

  /**
   * Builds the WHERE clause conditions for the filtered_aggregates CTE.
   */
  private buildFilterConditions(filter: AnalyticsFilter, frequency: Frequency): any {
    const conditions: any[] = [];

    // Frequency flag
    if (frequency === Frequency.QUARTER) {
      conditions.push(sql`eli.is_quarterly = true`);
    } else if (frequency === Frequency.YEAR) {
      conditions.push(sql`eli.is_yearly = true`);
    }

    // Required filters
    conditions.push(sql`eli.account_category = ${filter.account_category}`);

    if (filter.report_type !== undefined) {
      conditions.push(sql`eli.report_type = ${filter.report_type}`);
    }

    // Period filters
    const periodConditions = this.buildPeriodConditions(filter, frequency);
    if (periodConditions !== null) {
      conditions.push(periodConditions);
    }

    // Dimension filters
    if (filter.main_creditor_cui !== undefined) {
      conditions.push(sql`eli.main_creditor_cui = ${filter.main_creditor_cui}`);
    }

    if (filter.report_ids !== undefined && filter.report_ids.length > 0) {
      conditions.push(sql`eli.report_id = ANY(${filter.report_ids})`);
    }

    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      conditions.push(sql`eli.entity_cui = ANY(${filter.entity_cuis})`);
    }

    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(filter.funding_source_ids);
      if (numericIds.length > 0) {
        conditions.push(sql`eli.funding_source_id = ANY(${numericIds})`);
      }
    }

    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(filter.budget_sector_ids);
      if (numericIds.length > 0) {
        conditions.push(sql`eli.budget_sector_id = ANY(${numericIds})`);
      }
    }

    if (filter.expense_types !== undefined && filter.expense_types.length > 0) {
      conditions.push(sql`eli.expense_type = ANY(${filter.expense_types})`);
    }

    // Code filters
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      conditions.push(sql`eli.functional_code = ANY(${filter.functional_codes})`);
    }

    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const likeConditions = filter.functional_prefixes.map(
        (p) => sql`eli.functional_code LIKE ${p + '%'}`
      );
      conditions.push(sql`(${sql.join(likeConditions, sql` OR `)})`);
    }

    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      conditions.push(sql`eli.economic_code = ANY(${filter.economic_codes})`);
    }

    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const likeConditions = filter.economic_prefixes.map(
        (p) => sql`eli.economic_code LIKE ${p + '%'}`
      );
      conditions.push(sql`(${sql.join(likeConditions, sql` OR `)})`);
    }

    if (filter.program_codes !== undefined && filter.program_codes.length > 0) {
      conditions.push(sql`eli.program_code = ANY(${filter.program_codes})`);
    }

    // Entity filters (requires entity join)
    if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
      conditions.push(sql`e.entity_type = ANY(${filter.entity_types})`);
    }

    if (filter.is_uat !== undefined) {
      conditions.push(sql`e.is_uat = ${filter.is_uat}`);
    }

    // UAT filters (filter at entity level to control which entities contribute)
    if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
      const numericIds = toNumericIds(filter.uat_ids);
      if (numericIds.length > 0) {
        conditions.push(sql`EXISTS (
          SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.id = ANY(${numericIds})
        )`);
      }
    }

    if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.county_code = ANY(${filter.county_codes})
      )`);
    }

    if (filter.regions !== undefined && filter.regions.length > 0) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.region = ANY(${filter.regions})
      )`);
    }

    if (filter.min_population !== undefined && filter.min_population !== null) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND COALESCE(u.population, 0) >= ${filter.min_population}
      )`);
    }

    if (filter.max_population !== undefined && filter.max_population !== null) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND COALESCE(u.population, 0) <= ${filter.max_population}
      )`);
    }

    // Item amount constraints
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      const amountCol = this.getAmountColumn(frequency);
      conditions.push(sql`${sql.raw(amountCol)} >= ${String(filter.item_min_amount)}`);
    }

    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      const amountCol = this.getAmountColumn(frequency);
      conditions.push(sql`${sql.raw(amountCol)} <= ${String(filter.item_max_amount)}`);
    }

    // Exclusions
    this.applyExclusionConditions(conditions, filter);

    // Combine all conditions with AND
    if (conditions.length === 0) {
      return sql`true`;
    }

    return sql`${sql.join(conditions, sql` AND `)}`;
  }

  /**
   * Builds period conditions for the WHERE clause.
   */
  private buildPeriodConditions(filter: AnalyticsFilter, frequency: Frequency): any {
    const { selection } = filter.report_period;

    // Interval-based filter
    if (selection.interval !== undefined) {
      const start = parsePeriodDate(selection.interval.start);
      const end = parsePeriodDate(selection.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        return sql`(eli.year, eli.month) >= (${start.year}, ${start.month})
                   AND (eli.year, eli.month) <= (${end.year}, ${end.month})`;
      }

      if (
        frequency === Frequency.QUARTER &&
        start?.quarter !== undefined &&
        end?.quarter !== undefined
      ) {
        return sql`(eli.year, eli.quarter) >= (${start.year}, ${start.quarter})
                   AND (eli.year, eli.quarter) <= (${end.year}, ${end.quarter})`;
      }

      // YEAR frequency or fallback
      const startYear = start?.year ?? extractYear(selection.interval.start);
      const endYear = end?.year ?? extractYear(selection.interval.end);

      if (startYear !== null && endYear !== null) {
        return sql`eli.year >= ${startYear} AND eli.year <= ${endYear}`;
      }
      if (startYear !== null) {
        return sql`eli.year >= ${startYear}`;
      }
      if (endYear !== null) {
        return sql`eli.year <= ${endYear}`;
      }
    }

    // Discrete dates filter
    if (selection.dates !== undefined && selection.dates.length > 0) {
      if (frequency === Frequency.MONTH) {
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; month: number } => p?.month !== undefined);

        if (validPeriods.length > 0) {
          const periodConditions = validPeriods.map(
            (p) => sql`(eli.year = ${p.year} AND eli.month = ${p.month})`
          );
          return sql`(${sql.join(periodConditions, sql` OR `)})`;
        }
      } else if (frequency === Frequency.QUARTER) {
        const validPeriods = selection.dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);

        if (validPeriods.length > 0) {
          const periodConditions = validPeriods.map(
            (p) => sql`(eli.year = ${p.year} AND eli.quarter = ${p.quarter})`
          );
          return sql`(${sql.join(periodConditions, sql` OR `)})`;
        }
      } else {
        // YEAR frequency
        const years = selection.dates
          .map((d) => extractYear(d))
          .filter((y): y is number => y !== null);

        if (years.length > 0) {
          return sql`eli.year = ANY(${years})`;
        }
      }
    }

    return null;
  }

  /**
   * Applies exclusion conditions to the conditions array.
   */
  private applyExclusionConditions(conditions: any[], filter: AnalyticsFilter): void {
    if (filter.exclude === undefined) {
      return;
    }

    const ex = filter.exclude;

    if (ex.report_ids !== undefined && ex.report_ids.length > 0) {
      conditions.push(sql`eli.report_id != ALL(${ex.report_ids})`);
    }

    if (ex.entity_cuis !== undefined && ex.entity_cuis.length > 0) {
      conditions.push(sql`eli.entity_cui != ALL(${ex.entity_cuis})`);
    }

    if (ex.functional_codes !== undefined && ex.functional_codes.length > 0) {
      conditions.push(sql`eli.functional_code != ALL(${ex.functional_codes})`);
    }

    if (ex.functional_prefixes !== undefined && ex.functional_prefixes.length > 0) {
      const notLikeConditions = ex.functional_prefixes.map(
        (p) => sql`eli.functional_code NOT LIKE ${p + '%'}`
      );
      conditions.push(sql`(${sql.join(notLikeConditions, sql` AND `)})`);
    }

    // Economic code exclusions - only for non-VN accounts
    if (filter.account_category !== 'vn') {
      if (ex.economic_codes !== undefined && ex.economic_codes.length > 0) {
        conditions.push(sql`eli.economic_code != ALL(${ex.economic_codes})`);
      }

      if (ex.economic_prefixes !== undefined && ex.economic_prefixes.length > 0) {
        const notLikeConditions = ex.economic_prefixes.map(
          (p) => sql`eli.economic_code NOT LIKE ${p + '%'}`
        );
        conditions.push(sql`(${sql.join(notLikeConditions, sql` AND `)})`);
      }
    }

    // UAT exclusions
    if (ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
      const numericIds = toNumericIds(ex.uat_ids);
      if (numericIds.length > 0) {
        conditions.push(sql`NOT EXISTS (
          SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.id = ANY(${numericIds})
        )`);
      }
    }

    if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.county_code = ANY(${ex.county_codes})
      )`);
    }

    if (ex.regions !== undefined && ex.regions.length > 0) {
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM uats u WHERE u.uat_code = eli.entity_cui AND u.region = ANY(${ex.regions})
      )`);
    }

    // Entity type exclusions
    if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
      conditions.push(sql`(e.entity_type IS NULL OR e.entity_type != ALL(${ex.entity_types}))`);
    }
  }

  /**
   * Gets the frequency from the filter's report period.
   */
  private getFrequency(filter: AnalyticsFilter): Frequency {
    return filter.report_period.type;
  }

  /**
   * Gets the appropriate SUM expression based on frequency.
   */
  private getSumExpression(frequency: Frequency): any {
    if (frequency === Frequency.MONTH) {
      return sql`COALESCE(SUM(eli.monthly_amount), 0)`;
    }
    if (frequency === Frequency.QUARTER) {
      return sql`COALESCE(SUM(eli.quarterly_amount), 0)`;
    }
    return sql`COALESCE(SUM(eli.ytd_amount), 0)`;
  }

  /**
   * Gets the amount column name based on frequency.
   */
  private getAmountColumn(frequency: Frequency): string {
    if (frequency === Frequency.MONTH) {
      return 'eli.monthly_amount';
    }
    if (frequency === Frequency.QUARTER) {
      return 'eli.quarterly_amount';
    }
    return 'eli.ytd_amount';
  }

  /**
   * Checks if the entity join is needed.
   */
  private needsEntityJoin(filter: AnalyticsFilter): boolean {
    return (
      filter.is_uat !== undefined ||
      (filter.entity_types !== undefined && filter.entity_types.length > 0) ||
      (filter.exclude?.entity_types !== undefined && filter.exclude.entity_types.length > 0)
    );
  }

  /**
   * Builds the HAVING clause for aggregate thresholds.
   */
  private buildHavingClause(filter: AnalyticsFilter, frequency: Frequency): any {
    const conditions: any[] = [];
    const sumExpr =
      frequency === Frequency.MONTH
        ? 'COALESCE(SUM(eli.monthly_amount), 0)'
        : frequency === Frequency.QUARTER
          ? 'COALESCE(SUM(eli.quarterly_amount), 0)'
          : 'COALESCE(SUM(eli.ytd_amount), 0)';

    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      conditions.push(sql`${sql.raw(sumExpr)} >= ${String(filter.aggregate_min_amount)}`);
    }

    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      conditions.push(sql`${sql.raw(sumExpr)} <= ${String(filter.aggregate_max_amount)}`);
    }

    if (conditions.length === 0) {
      return sql``;
    }

    return sql`HAVING ${sql.join(conditions, sql` AND `)}`;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Transforms raw database rows to HeatmapCountyDataPoint array.
   */
  private transformRows(rows: AggregatedCountyRow[]): HeatmapCountyDataPoint[] {
    return rows.map((row) => ({
      county_code: row.county_code,
      county_name: row.county_name,
      county_population: row.county_population,
      county_entity_cui: row.county_entity_cui,
      year: row.year,
      total_amount: new Decimal(row.total_amount),
    }));
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate CountyAnalyticsError.
   */
  private handleQueryError(error: unknown): Result<HeatmapCountyDataPoint[], CountyAnalyticsError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    return err(createDatabaseError(message));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a CountyAnalyticsRepository instance.
 */
export const makeCountyAnalyticsRepo = (db: BudgetDbClient): CountyAnalyticsRepository => {
  return new KyselyCountyAnalyticsRepo(db);
};
