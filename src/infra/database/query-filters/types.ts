/**
 * Query Filter Types
 *
 * Core types for the composable SQL filter pipeline.
 * Uses Kysely's RawBuilder for parameterized queries - SQL injection safe by design.
 */

import type { Frequency } from '@/common/types/temporal.js';
import type { RawBuilder } from 'kysely';

// ============================================================================
// Parameterized SQL Condition Type
// ============================================================================

/**
 * A parameterized SQL condition using Kysely's RawBuilder.
 *
 * SECURITY: Values interpolated in sql`` template are automatically parameterized,
 * preventing SQL injection by design. The database receives:
 * - SQL string with placeholders: `account_category = $1`
 * - Parameters array: ['ch']
 *
 * Never concatenate user input into SQL strings - always use sql`` template.
 */
export type SqlCondition = RawBuilder<unknown>;

/**
 * A condition builder function that produces parameterized SQL conditions.
 */
export type ConditionBuilder = (ctx: FilterContext) => SqlCondition[];

// ============================================================================
// Filter Context
// ============================================================================

/**
 * Context for SQL filter building.
 * Tracks which tables are joined and their aliases.
 */
export interface FilterContext {
  /** Table alias for execution line items (fixed: 'eli') */
  readonly lineItemAlias: 'eli';
  /** Table alias for entities (fixed: 'e') */
  readonly entityAlias: 'e';
  /** Table alias for UATs (fixed: 'u') */
  readonly uatAlias: 'u';
  /** Whether entities table has been joined */
  hasEntityJoin: boolean;
  /** Whether UATs table has been joined */
  hasUatJoin: boolean;
}

/**
 * Creates a default filter context with standard join flags.
 */
export const createFilterContext = (
  overrides?: Partial<Pick<FilterContext, 'hasEntityJoin' | 'hasUatJoin'>>
): FilterContext => {
  return {
    lineItemAlias: 'eli',
    entityAlias: 'e',
    uatAlias: 'u',
    hasEntityJoin: overrides?.hasEntityJoin ?? false,
    hasUatJoin: overrides?.hasUatJoin ?? false,
  };
};

// ============================================================================
// Parsed Period Types
// ============================================================================

/**
 * Parsed period components from a date string.
 * Extracted from strings like "2023", "2023-06", "2023-Q2".
 */
export interface ParsedPeriod {
  year: number;
  month?: number;
  quarter?: number;
}

/**
 * Parsed month period with required month field.
 */
export interface MonthPeriod {
  year: number;
  month: number;
}

/**
 * Parsed quarter period with required quarter field.
 */
export interface QuarterPeriod {
  year: number;
  quarter: number;
}

// ============================================================================
// Period Selection Types
// ============================================================================

/**
 * Period selection from analytics filter.
 * Either an interval (start/end) or a list of discrete dates.
 */
export interface PeriodSelection {
  interval?: { start: string; end: string } | undefined;
  dates?: readonly string[] | undefined;
}

/**
 * Report period combining frequency and selection.
 */
export interface ReportPeriod {
  type: Frequency;
  selection: PeriodSelection;
}

// ============================================================================
// Filter Input Types (Minimal Interfaces)
// ============================================================================

/**
 * Minimal interface for dimension filters.
 * Uses snake_case to match AnalyticsFilter from common/types.
 */
export interface DimensionFilter {
  account_category: string;
  report_type?: string;
  main_creditor_cui?: string;
  report_ids?: readonly string[];
  entity_cuis?: readonly string[];
  funding_source_ids?: readonly string[];
  budget_sector_ids?: readonly string[];
  expense_types?: readonly string[];
}

/**
 * Minimal interface for code filters.
 */
export interface CodeFilter {
  functional_codes?: readonly string[];
  functional_prefixes?: readonly string[];
  economic_codes?: readonly string[];
  economic_prefixes?: readonly string[];
  program_codes?: readonly string[];
}

/**
 * Minimal interface for geographic/entity filters.
 */
export interface GeographicFilter {
  entity_types?: readonly string[];
  is_uat?: boolean;
  uat_ids?: readonly string[];
  county_codes?: readonly string[];
  regions?: readonly string[];
  min_population?: number | null;
  max_population?: number | null;
  search?: string;
}

/**
 * Minimal interface for amount constraints.
 */
export interface AmountFilter {
  item_min_amount?: number | null;
  item_max_amount?: number | null;
}

/**
 * Exclusion filter interface.
 */
export interface ExclusionFilter {
  report_ids?: readonly string[];
  entity_cuis?: readonly string[];
  functional_codes?: readonly string[];
  functional_prefixes?: readonly string[];
  economic_codes?: readonly string[];
  economic_prefixes?: readonly string[];
  entity_types?: readonly string[];
  uat_ids?: readonly string[];
  county_codes?: readonly string[];
  regions?: readonly string[];
}

/**
 * Combined analytics filter for SQL condition building.
 * Extends all filter interfaces for full filter support.
 */
export interface AnalyticsSqlFilter
  extends DimensionFilter, CodeFilter, GeographicFilter, AmountFilter {
  report_period: ReportPeriod;
  exclude?: ExclusionFilter;
}
