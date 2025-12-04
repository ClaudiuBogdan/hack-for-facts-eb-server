/**
 * SQL Condition Builder
 *
 * Provides utilities for building SQL WHERE conditions from AnalyticsFilter.
 * Used by repositories that need to build raw SQL queries with proper filtering.
 *
 * Design principles:
 * - Each function returns an array of condition strings (without AND/OR)
 * - Caller is responsible for joining conditions
 * - NULL-safe exclusions: uses (column IS NULL OR column NOT IN (...))
 * - String values are properly quoted
 */

import { Frequency } from '@/common/types/temporal.js';

import { buildPeriodConditions, type PeriodSelection } from './period-filter-builder.js';
import { toNumericIds } from './query-helpers.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Context for SQL condition building.
 */
export interface SqlBuildContext {
  /** Whether entities table is joined (enables entity_type, is_uat, uat_id filters) */
  hasEntityJoin: boolean;
  /** Whether uats table is joined (enables county_code, population filters) */
  hasUatJoin: boolean;
  /** Table alias for executionlineitems (default: 'eli') */
  lineItemAlias?: string;
  /** Table alias for entities (default: 'e') */
  entityAlias?: string;
  /** Table alias for uats (default: 'u') */
  uatAlias?: string;
}

/**
 * Minimal filter interface for dimension filters.
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
 * Minimal filter interface for code filters.
 */
export interface CodeFilter {
  functional_codes?: readonly string[];
  functional_prefixes?: readonly string[];
  economic_codes?: readonly string[];
  economic_prefixes?: readonly string[];
  program_codes?: readonly string[];
}

/**
 * Minimal filter interface for geographic filters.
 */
export interface GeographicFilter {
  entity_types?: readonly string[];
  is_uat?: boolean;
  uat_ids?: readonly string[];
  county_codes?: readonly string[];
  min_population?: number | null;
  max_population?: number | null;
}

/**
 * Minimal filter interface for amount constraints.
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
}

/**
 * Combined filter interface for all SQL conditions.
 */
export interface AnalyticsSqlFilter
  extends DimensionFilter, CodeFilter, GeographicFilter, AmountFilter {
  report_period: {
    frequency: Frequency;
    selection: PeriodSelection;
  };
  exclude?: ExclusionFilter;
}

// ============================================================================
// Default Aliases
// ============================================================================

const DEFAULT_LINE_ITEM_ALIAS = 'eli';
const DEFAULT_ENTITY_ALIAS = 'e';
const DEFAULT_UAT_ALIAS = 'u';

// ============================================================================
// Main Builder Function
// ============================================================================

/**
 * Builds all WHERE conditions for an analytics query.
 *
 * @returns Array of condition strings to be joined with AND
 */
export function buildWhereConditions(filter: AnalyticsSqlFilter, ctx: SqlBuildContext): string[] {
  const conditions: string[] = [];
  const eli = ctx.lineItemAlias ?? DEFAULT_LINE_ITEM_ALIAS;
  const e = ctx.entityAlias ?? DEFAULT_ENTITY_ALIAS;
  const u = ctx.uatAlias ?? DEFAULT_UAT_ALIAS;

  // Frequency flag
  conditions.push(...buildFrequencyConditions(filter.report_period.frequency, eli));

  // Dimension filters
  conditions.push(...buildDimensionConditions(filter, eli));

  // Period filters
  conditions.push(
    ...buildPeriodConditions(filter.report_period.selection, filter.report_period.frequency, eli)
  );

  // Code filters
  conditions.push(...buildCodeConditions(filter, eli));

  // Geographic filters (if joined)
  if (ctx.hasEntityJoin) {
    conditions.push(...buildEntityConditions(filter, e));
  }
  if (ctx.hasUatJoin) {
    conditions.push(...buildUatConditions(filter, u));
  }

  // Amount constraints
  conditions.push(...buildAmountConditions(filter, filter.report_period.frequency, eli));

  // Exclusions
  if (filter.exclude !== undefined) {
    conditions.push(...buildExclusionConditions(filter.exclude, filter.account_category, ctx));
  }

  return conditions;
}

/**
 * Joins conditions into a WHERE clause string.
 * Returns empty string if no conditions.
 */
export function toWhereClause(conditions: string[]): string {
  if (conditions.length === 0) return '';
  return `WHERE ${conditions.join(' AND ')}`;
}

// ============================================================================
// Frequency Conditions
// ============================================================================

function buildFrequencyConditions(frequency: Frequency, alias: string): string[] {
  if (frequency === Frequency.QUARTER) {
    return [`${alias}.is_quarterly = true`];
  }
  if (frequency === Frequency.YEAR) {
    return [`${alias}.is_yearly = true`];
  }
  // MONTH: no flag needed
  return [];
}

// ============================================================================
// Dimension Conditions
// ============================================================================

function buildDimensionConditions(filter: DimensionFilter, alias: string): string[] {
  const conditions: string[] = [];

  // Required
  conditions.push(`${alias}.account_category = '${filter.account_category}'`);

  // Optional
  if (filter.report_type !== undefined) {
    conditions.push(`${alias}.report_type = '${filter.report_type}'`);
  }

  if (filter.main_creditor_cui !== undefined) {
    conditions.push(`${alias}.main_creditor_cui = '${filter.main_creditor_cui}'`);
  }

  if (hasValues(filter.report_ids)) {
    conditions.push(`${alias}.report_id IN (${quoteStrings(filter.report_ids)})`);
  }

  if (hasValues(filter.entity_cuis)) {
    conditions.push(`${alias}.entity_cui IN (${quoteStrings(filter.entity_cuis)})`);
  }

  if (hasValues(filter.funding_source_ids)) {
    const ids = toNumericIds(filter.funding_source_ids);
    if (ids.length > 0) {
      conditions.push(`${alias}.funding_source_id IN (${ids.join(', ')})`);
    }
  }

  if (hasValues(filter.budget_sector_ids)) {
    const ids = toNumericIds(filter.budget_sector_ids);
    if (ids.length > 0) {
      conditions.push(`${alias}.budget_sector_id IN (${ids.join(', ')})`);
    }
  }

  if (hasValues(filter.expense_types)) {
    conditions.push(`${alias}.expense_type IN (${quoteStrings(filter.expense_types)})`);
  }

  return conditions;
}

// ============================================================================
// Code Conditions
// ============================================================================

function buildCodeConditions(filter: CodeFilter, alias: string): string[] {
  const conditions: string[] = [];

  if (hasValues(filter.functional_codes)) {
    conditions.push(`${alias}.functional_code IN (${quoteStrings(filter.functional_codes)})`);
  }

  if (hasValues(filter.functional_prefixes)) {
    const prefixOrs = filter.functional_prefixes
      .map((p) => `${alias}.functional_code LIKE '${p}%'`)
      .join(' OR ');
    conditions.push(`(${prefixOrs})`);
  }

  if (hasValues(filter.economic_codes)) {
    conditions.push(`${alias}.economic_code IN (${quoteStrings(filter.economic_codes)})`);
  }

  if (hasValues(filter.economic_prefixes)) {
    const prefixOrs = filter.economic_prefixes
      .map((p) => `${alias}.economic_code LIKE '${p}%'`)
      .join(' OR ');
    conditions.push(`(${prefixOrs})`);
  }

  if (hasValues(filter.program_codes)) {
    conditions.push(`${alias}.program_code IN (${quoteStrings(filter.program_codes)})`);
  }

  return conditions;
}

// ============================================================================
// Geographic Conditions
// ============================================================================

function buildEntityConditions(filter: GeographicFilter, alias: string): string[] {
  const conditions: string[] = [];

  if (hasValues(filter.entity_types)) {
    conditions.push(`${alias}.entity_type IN (${quoteStrings(filter.entity_types)})`);
  }

  if (filter.is_uat !== undefined) {
    conditions.push(`${alias}.is_uat = ${String(filter.is_uat)}`);
  }

  if (hasValues(filter.uat_ids)) {
    const ids = toNumericIds(filter.uat_ids);
    if (ids.length > 0) {
      conditions.push(`${alias}.uat_id IN (${ids.join(', ')})`);
    }
  }

  return conditions;
}

function buildUatConditions(filter: GeographicFilter, alias: string): string[] {
  const conditions: string[] = [];

  if (hasValues(filter.county_codes)) {
    conditions.push(`${alias}.county_code IN (${quoteStrings(filter.county_codes)})`);
  }

  if (filter.min_population !== undefined && filter.min_population !== null) {
    conditions.push(`${alias}.population >= ${String(filter.min_population)}`);
  }

  if (filter.max_population !== undefined && filter.max_population !== null) {
    conditions.push(`${alias}.population <= ${String(filter.max_population)}`);
  }

  return conditions;
}

// ============================================================================
// Amount Conditions
// ============================================================================

/**
 * Gets the appropriate amount column based on frequency.
 */
export function getAmountColumn(frequency: Frequency, alias = 'eli'): string {
  if (frequency === Frequency.MONTH) return `${alias}.monthly_amount`;
  if (frequency === Frequency.QUARTER) return `${alias}.quarterly_amount`;
  return `${alias}.ytd_amount`;
}

function buildAmountConditions(
  filter: AmountFilter,
  frequency: Frequency,
  alias: string
): string[] {
  const conditions: string[] = [];
  const column = getAmountColumn(frequency, alias);

  if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
    conditions.push(`${column} >= ${String(filter.item_min_amount)}`);
  }

  if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
    conditions.push(`${column} <= ${String(filter.item_max_amount)}`);
  }

  return conditions;
}

// ============================================================================
// Exclusion Conditions
// ============================================================================

/**
 * Builds exclusion conditions.
 *
 * IMPORTANT: For nullable columns (entity_type, uat_id, county_code),
 * we use (column IS NULL OR column NOT IN (...)) to preserve NULL rows.
 * SQL's NOT IN does not match NULL values.
 */
function buildExclusionConditions(
  exclude: ExclusionFilter,
  accountCategory: string,
  ctx: SqlBuildContext
): string[] {
  const conditions: string[] = [];
  const eli = ctx.lineItemAlias ?? DEFAULT_LINE_ITEM_ALIAS;
  const e = ctx.entityAlias ?? DEFAULT_ENTITY_ALIAS;
  const u = ctx.uatAlias ?? DEFAULT_UAT_ALIAS;

  // Line item exclusions
  if (hasValues(exclude.report_ids)) {
    conditions.push(`${eli}.report_id NOT IN (${quoteStrings(exclude.report_ids)})`);
  }

  if (hasValues(exclude.entity_cuis)) {
    conditions.push(`${eli}.entity_cui NOT IN (${quoteStrings(exclude.entity_cuis)})`);
  }

  if (hasValues(exclude.functional_codes)) {
    conditions.push(`${eli}.functional_code NOT IN (${quoteStrings(exclude.functional_codes)})`);
  }

  if (hasValues(exclude.functional_prefixes)) {
    const prefixAnds = exclude.functional_prefixes
      .map((p) => `${eli}.functional_code NOT LIKE '${p}%'`)
      .join(' AND ');
    conditions.push(`(${prefixAnds})`);
  }

  // Economic exclusions only apply to non-VN accounts
  if (accountCategory !== 'vn') {
    if (hasValues(exclude.economic_codes)) {
      conditions.push(`${eli}.economic_code NOT IN (${quoteStrings(exclude.economic_codes)})`);
    }

    if (hasValues(exclude.economic_prefixes)) {
      const prefixAnds = exclude.economic_prefixes
        .map((p) => `${eli}.economic_code NOT LIKE '${p}%'`)
        .join(' AND ');
      conditions.push(`(${prefixAnds})`);
    }
  }

  // Entity exclusions (NULL-safe)
  if (ctx.hasEntityJoin) {
    if (hasValues(exclude.entity_types)) {
      const values = quoteStrings(exclude.entity_types);
      conditions.push(`(${e}.entity_type IS NULL OR ${e}.entity_type NOT IN (${values}))`);
    }

    if (hasValues(exclude.uat_ids)) {
      const ids = toNumericIds(exclude.uat_ids);
      if (ids.length > 0) {
        conditions.push(`(${e}.uat_id IS NULL OR ${e}.uat_id NOT IN (${ids.join(', ')}))`);
      }
    }
  }

  // UAT exclusions (NULL-safe)
  if (ctx.hasUatJoin) {
    if (hasValues(exclude.county_codes)) {
      const values = quoteStrings(exclude.county_codes);
      conditions.push(`(${u}.county_code IS NULL OR ${u}.county_code NOT IN (${values}))`);
    }
  }

  return conditions;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if an array has values.
 */
function hasValues<T>(arr: readonly T[] | undefined): arr is readonly T[] {
  return arr !== undefined && arr.length > 0;
}

/**
 * Quotes strings for SQL IN clause.
 */
function quoteStrings(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}
