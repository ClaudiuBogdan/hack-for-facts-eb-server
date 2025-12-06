/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires any typing */
/**
 * Kysely repository implementation for execution line items.
 */

import { Decimal } from 'decimal.js';
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';
import {
  extractYear,
  parsePeriodDate,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from '@/modules/execution-analytics/shell/repo/query-helpers.js';

import {
  createDatabaseError,
  createTimeoutError,
  type ExecutionLineItemError,
} from '../../core/errors.js';
import {
  QUERY_TIMEOUT_MS,
  DEFAULT_SECONDARY_SORT,
  type ExecutionLineItem,
  type ExecutionLineItemConnection,
  type ExecutionLineItemFilter,
  type SortInput,
} from '../../core/types.js';

import type { ExecutionLineItemRepository } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Types
// ============================================================================

/** Anomaly type from database */
type DbAnomalyType = 'YTD_ANOMALY' | 'MISSING_LINE_ITEM';

/**
 * Raw row returned from database query.
 */
interface RawLineItemRow {
  line_item_id: string;
  report_id: string;
  entity_cui: string;
  funding_source_id: number;
  budget_sector_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: 'vn' | 'ch';
  expense_type: string | null;
  program_code: string | null;
  year: number;
  month: number;
  quarter: number | null;
  ytd_amount: string;
  monthly_amount: string;
  quarterly_amount: string | null;
  anomaly: DbAnomalyType | null;
  total_count: string;
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
 * Kysely-based implementation of ExecutionLineItemRepository.
 *
 * Query optimization notes:
 * - Period flags (is_yearly/is_quarterly) are applied first to match index prefix
 * - Conditional JOINs on Entities/UATs only when required by filters
 * - Window function COUNT(*) OVER() for total count without extra query
 * - Deterministic secondary sort on ytd_amount for stable pagination
 */
class KyselyExecutionLineItemRepo implements ExecutionLineItemRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async findById(id: string): Promise<Result<ExecutionLineItem | null, ExecutionLineItemError>> {
    try {
      const row = await this.db
        .selectFrom('executionlineitems')
        .select([
          'line_item_id',
          'report_id',
          'entity_cui',
          'funding_source_id',
          'budget_sector_id',
          'functional_code',
          'economic_code',
          'account_category',
          'expense_type',
          'program_code',
          'year',
          'month',
          'quarter',
          'ytd_amount',
          'monthly_amount',
          'quarterly_amount',
          'anomaly',
        ])
        .where('line_item_id', '=', id)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToEntity(row));
    } catch (error) {
      return err(createDatabaseError('Failed to fetch execution line item by ID', error));
    }
  }

  async list(
    filter: ExecutionLineItemFilter,
    sort: SortInput,
    limit: number,
    offset: number
  ): Promise<Result<ExecutionLineItemConnection, ExecutionLineItemError>> {
    const frequency = filter.report_period.type;

    try {
      // Set statement timeout for this transaction
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build query step by step
      let query: DynamicQuery = this.db
        .selectFrom('executionlineitems as eli')
        .select([
          'eli.line_item_id',
          'eli.report_id',
          'eli.entity_cui',
          'eli.funding_source_id',
          'eli.budget_sector_id',
          'eli.functional_code',
          'eli.economic_code',
          'eli.account_category',
          'eli.expense_type',
          'eli.program_code',
          'eli.year',
          'eli.month',
          'eli.quarter',
          'eli.ytd_amount',
          'eli.monthly_amount',
          'eli.quarterly_amount',
          'eli.anomaly',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Apply period flags FIRST (matches index prefix)
      query = this.applyPeriodFlags(query, frequency);

      // Apply period filters
      query = this.applyPeriodFilters(query, filter);

      // Apply dimension filters
      query = this.applyDimensionFilters(query, filter);

      // Apply code filters
      query = this.applyCodeFilters(query, filter);

      // Apply entity joins and filters
      query = this.applyEntityJoinsAndFilters(query, filter);

      // Apply exclusions
      query = this.applyExclusions(query, filter);

      // Apply amount constraints
      query = this.applyAmountConstraints(query, filter, frequency);

      // Apply sorting (pass frequency to map 'amount' to correct column)
      query = this.applySorting(query, sort, frequency);

      // Apply pagination
      query = query.limit(limit).offset(offset);

      // Execute query
      const rows: RawLineItemRow[] = await query.execute();

      // Transform results
      return ok(this.mapToConnection(rows, limit, offset));
    } catch (error) {
      return this.handleQueryError(error);
    }
  }

  // ==========================================================================
  // Query Building Methods
  // ==========================================================================

  /**
   * Applies period flags (is_yearly/is_quarterly) based on frequency.
   * These must come first to match index prefix.
   */
  private applyPeriodFlags(query: DynamicQuery, frequency: Frequency): DynamicQuery {
    if (frequency === Frequency.YEAR) {
      return query.where('eli.is_yearly', '=', true);
    }
    if (frequency === Frequency.QUARTER) {
      return query.where('eli.is_quarterly', '=', true);
    }
    // MONTH: no flag needed
    return query;
  }

  /**
   * Applies period (date range) filters.
   */
  private applyPeriodFilters(query: DynamicQuery, filter: ExecutionLineItemFilter): DynamicQuery {
    const { selection, type: frequency } = filter.report_period;

    // Interval-based filter
    if (selection.interval !== undefined) {
      const start = parsePeriodDate(selection.interval.start);
      const end = parsePeriodDate(selection.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        // Filter by (year, month) tuple using row comparison
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
        // Filter by (year, quarter) tuple using row comparison
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '>=', sql`(${start.year}, ${start.quarter})`)
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb(sql`(eli.year, eli.quarter)`, '<=', sql`(${end.year}, ${end.quarter})`)
        );
      } else {
        // YEAR frequency or fallback: filter by year only
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
        // YEAR frequency: filter by years only
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
  private applyDimensionFilters(
    query: DynamicQuery,
    filter: ExecutionLineItemFilter
  ): DynamicQuery {
    // Account category (required field)
    query = query.where('eli.account_category', '=', filter.account_category);

    // Report type
    if (filter.report_type !== undefined) {
      query = query.where('eli.report_type', '=', filter.report_type);
    }

    // Main creditor CUI
    if (filter.main_creditor_cui !== undefined) {
      query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
    }

    // Report IDs
    if (filter.report_ids !== undefined && filter.report_ids.length > 0) {
      query = query.where('eli.report_id', 'in', filter.report_ids);
    }

    // Entity CUIs
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
    }

    // Funding source IDs
    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(filter.funding_source_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.funding_source_id', 'in', numericIds);
      }
    }

    // Budget sector IDs
    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(filter.budget_sector_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.budget_sector_id', 'in', numericIds);
      }
    }

    // Expense types
    if (filter.expense_types !== undefined && filter.expense_types.length > 0) {
      query = query.where('eli.expense_type', 'in', filter.expense_types);
    }

    return query;
  }

  /**
   * Applies code-based filters (functional, economic, program codes).
   */
  private applyCodeFilters(query: DynamicQuery, filter: ExecutionLineItemFilter): DynamicQuery {
    // Exact functional codes
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'in', filter.functional_codes);
    }

    // Functional code prefixes (LIKE patterns)
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixes = filter.functional_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.functional_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    // Exact economic codes
    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      query = query.where('eli.economic_code', 'in', filter.economic_codes);
    }

    // Economic code prefixes
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixes = filter.economic_prefixes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) => {
        const ors = prefixes.map((p) => eb('eli.economic_code', 'like', `${p}%`));
        return eb.or(ors);
      });
    }

    // Program codes
    if (filter.program_codes !== undefined && filter.program_codes.length > 0) {
      query = query.where('eli.program_code', 'in', filter.program_codes);
    }

    return query;
  }

  /**
   * Applies entity/UAT joins and their dependent filters.
   */
  private applyEntityJoinsAndFilters(
    query: DynamicQuery,
    filter: ExecutionLineItemFilter
  ): DynamicQuery {
    const requiresEntityJoin = needsEntityJoin(filter);
    const requiresUatJoin = needsUatJoin(filter);

    // Apply entity join if needed
    if (requiresEntityJoin) {
      query = query.leftJoin('entities as e', 'eli.entity_cui', 'e.cui');

      // Entity-specific filters
      if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
        query = query.where('e.entity_type', 'in', filter.entity_types);
      }

      if (filter.is_uat !== undefined) {
        query = query.where('e.is_uat', '=', filter.is_uat);
      }

      if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
        const numericIds = toNumericIds(filter.uat_ids);
        if (numericIds.length > 0) {
          query = query.where('e.uat_id', 'in', numericIds);
        }
      }

      // Search filter: case-insensitive substring match on entity name
      if (filter.search !== undefined && filter.search.trim() !== '') {
        const escapedSearch = filter.search
          .trim()
          .replace(/\\/g, '\\\\')
          .replace(/%/g, '\\%')
          .replace(/_/g, '\\_');
        query = query.where('e.name', 'ilike', `%${escapedSearch}%`);
      }
    }

    // Apply UAT join if needed
    if (requiresUatJoin) {
      query = query.leftJoin('uats as u', 'e.uat_id', 'u.id');

      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        query = query.where('u.county_code', 'in', filter.county_codes);
      }

      if (filter.regions !== undefined && filter.regions.length > 0) {
        query = query.where('u.region', 'in', filter.regions);
      }

      // Population filters
      if (filter.min_population !== undefined && filter.min_population !== null) {
        query = query.where('u.population', '>=', filter.min_population);
      }

      if (filter.max_population !== undefined && filter.max_population !== null) {
        query = query.where('u.population', '<=', filter.max_population);
      }
    }

    return query;
  }

  /**
   * Applies exclusion filters with NULL-safe handling.
   */
  private applyExclusions(query: DynamicQuery, filter: ExecutionLineItemFilter): DynamicQuery {
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

    if (ex.main_creditor_cui !== undefined) {
      query = query.where('eli.main_creditor_cui', '!=', ex.main_creditor_cui);
    }

    // Funding source exclusions
    if (ex.funding_source_ids !== undefined && ex.funding_source_ids.length > 0) {
      const numericIds = toNumericIds(ex.funding_source_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.funding_source_id', 'not in', numericIds);
      }
    }

    // Budget sector exclusions
    if (ex.budget_sector_ids !== undefined && ex.budget_sector_ids.length > 0) {
      const numericIds = toNumericIds(ex.budget_sector_ids);
      if (numericIds.length > 0) {
        query = query.where('eli.budget_sector_id', 'not in', numericIds);
      }
    }

    // Functional code exclusions
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

    // Economic code exclusions
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

    // Expense type exclusions
    if (ex.expense_types !== undefined && ex.expense_types.length > 0) {
      query = query.where('eli.expense_type', 'not in', ex.expense_types);
    }

    // Program code exclusions
    if (ex.program_codes !== undefined && ex.program_codes.length > 0) {
      query = query.where('eli.program_code', 'not in', ex.program_codes);
    }

    // Entity type exclusions - must preserve NULL entity_type rows
    if (ex.entity_types !== undefined && ex.entity_types.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('e.entity_type', 'is', null), eb('e.entity_type', 'not in', ex.entity_types)])
      );
    }

    // UAT ID exclusions - must preserve NULL uat_id rows
    if (ex.uat_ids !== undefined && ex.uat_ids.length > 0) {
      const numericIds = toNumericIds(ex.uat_ids);
      if (numericIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
        query = query.where((eb: ExpressionBuilder<any, any>) =>
          eb.or([eb('e.uat_id', 'is', null), eb('e.uat_id', 'not in', numericIds)])
        );
      }
    }

    // County code exclusions - must preserve NULL county_code rows
    if (ex.county_codes !== undefined && ex.county_codes.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.county_code', 'is', null), eb('u.county_code', 'not in', ex.county_codes)])
      );
    }

    // Region exclusions
    if (ex.regions !== undefined && ex.regions.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([eb('u.region', 'is', null), eb('u.region', 'not in', ex.regions)])
      );
    }

    return query;
  }

  /**
   * Applies amount-based constraints based on frequency.
   */
  private applyAmountConstraints(
    query: DynamicQuery,
    filter: ExecutionLineItemFilter,
    frequency: Frequency
  ): DynamicQuery {
    // Select the appropriate amount column based on frequency
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
   * Applies sorting with secondary sort for stable pagination.
   *
   * The 'amount' field is a virtual field that maps to the correct amount column
   * based on the query frequency:
   * - MONTH: monthly_amount
   * - QUARTER: quarterly_amount
   * - YEAR: ytd_amount
   */
  private applySorting(query: DynamicQuery, sort: SortInput, frequency: Frequency): DynamicQuery {
    // Map 'amount' to the appropriate column based on frequency
    const sortField = this.mapSortField(sort.field, frequency);
    const column = `eli.${sortField}`;
    query = query.orderBy(column, sort.order.toLowerCase() as 'asc' | 'desc');

    // Add secondary sort for deterministic pagination (if not already sorting by ytd_amount)
    if (sort.field !== DEFAULT_SECONDARY_SORT.field) {
      const secondaryColumn = `eli.${DEFAULT_SECONDARY_SORT.field}`;
      query = query.orderBy(
        secondaryColumn,
        DEFAULT_SECONDARY_SORT.order.toLowerCase() as 'asc' | 'desc'
      );
    }

    return query;
  }

  /**
   * Maps virtual sort fields to actual database columns.
   *
   * The 'amount' field is mapped based on frequency:
   * - MONTH → monthly_amount
   * - QUARTER → quarterly_amount
   * - YEAR → ytd_amount
   */
  private mapSortField(field: string, frequency: Frequency): string {
    if (field === 'amount') {
      if (frequency === Frequency.MONTH) return 'monthly_amount';
      if (frequency === Frequency.QUARTER) return 'quarterly_amount';
      return 'ytd_amount';
    }
    return field;
  }

  // ==========================================================================
  // Result Transformation
  // ==========================================================================

  /**
   * Maps a raw database row to ExecutionLineItem domain entity.
   */
  private mapRowToEntity(row: {
    line_item_id: string;
    report_id: string;
    entity_cui: string;
    funding_source_id: number;
    budget_sector_id: number;
    functional_code: string;
    economic_code: string | null;
    account_category: 'vn' | 'ch';
    expense_type: string | null;
    program_code: string | null;
    year: number;
    month: number;
    quarter: number | null;
    ytd_amount: string;
    monthly_amount: string;
    quarterly_amount: string | null;
    anomaly?: DbAnomalyType | null;
  }): ExecutionLineItem {
    return {
      line_item_id: row.line_item_id,
      report_id: row.report_id,
      entity_cui: row.entity_cui,
      funding_source_id: row.funding_source_id,
      budget_sector_id: row.budget_sector_id,
      functional_code: row.functional_code,
      economic_code: row.economic_code,
      account_category: row.account_category,
      expense_type: row.expense_type as 'dezvoltare' | 'functionare' | null,
      program_code: row.program_code,
      year: row.year,
      month: row.month,
      quarter: row.quarter,
      ytd_amount: new Decimal(row.ytd_amount),
      monthly_amount: new Decimal(row.monthly_amount),
      quarterly_amount: row.quarterly_amount !== null ? new Decimal(row.quarterly_amount) : null,
      anomaly: row.anomaly ?? null,
    };
  }

  /**
   * Maps query results to paginated connection.
   */
  private mapToConnection(
    rows: RawLineItemRow[],
    limit: number,
    offset: number
  ): ExecutionLineItemConnection {
    const firstRow = rows[0];
    const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

    const nodes: ExecutionLineItem[] = rows.map((row) => this.mapRowToEntity(row));

    return {
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    };
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Handles query errors and returns appropriate error type.
   */
  private handleQueryError(
    error: unknown
  ): Result<ExecutionLineItemConnection, ExecutionLineItemError> {
    const message = error instanceof Error ? error.message : 'Unknown database error';

    // Check for timeout error (PostgreSQL error code 57014)
    const isTimeout =
      message.includes('statement timeout') ||
      message.includes('57014') ||
      message.includes('canceling statement due to statement timeout');

    if (isTimeout) {
      return err(createTimeoutError('Execution line items query timed out', error));
    }

    return err(createDatabaseError('Failed to fetch execution line items', error));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an ExecutionLineItemRepository instance.
 */
export const makeExecutionLineItemRepo = (db: BudgetDbClient): ExecutionLineItemRepository => {
  return new KyselyExecutionLineItemRepo(db);
};
