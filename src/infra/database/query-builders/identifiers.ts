/**
 * SQL Identifiers - Safe Table and Column Definitions
 *
 * This module defines all valid SQL identifiers (table names, column names, aliases)
 * used in the application. By centralizing these definitions, we ensure that
 * only known, trusted identifiers can be used in SQL queries.
 *
 * SECURITY: These are compile-time constants, not user input.
 * sql.raw() is only used here with these trusted values.
 */

// ============================================================================
// Table Aliases
// ============================================================================

/**
 * Standard table aliases used across repositories.
 * These are internal constants - never derived from user input.
 */
export const TableAliases = {
  /** executionlineitems */
  eli: 'eli',
  /** entities */
  e: 'e',
  /** uats */
  u: 'u',
  /** functionalclassifications */
  fc: 'fc',
  /** economicclassifications */
  ec: 'ec',
  /** reports */
  r: 'r',
  /** county_populations (CTE) */
  cp: 'cp',
  /** factors (CTE) */
  f: 'f',
  /** filtered_aggregates (CTE) */
  fa: 'fa',
} as const;

export type TableAlias = keyof typeof TableAliases;

// ============================================================================
// Table Names
// ============================================================================

/**
 * Full table names in the database.
 */
export const TableNames = {
  executionlineitems: 'executionlineitems',
  entities: 'entities',
  uats: 'uats',
  functionalclassifications: 'functionalclassifications',
  economicclassifications: 'economicclassifications',
  reports: 'reports',
} as const;

export type TableName = keyof typeof TableNames;

// ============================================================================
// Column Names by Table
// ============================================================================

/**
 * Column names for executionlineitems table.
 */
export const ExecutionLineItemColumns = {
  line_item_id: 'line_item_id',
  entity_cui: 'entity_cui',
  report_id: 'report_id',
  year: 'year',
  month: 'month',
  quarter: 'quarter',
  functional_code: 'functional_code',
  economic_code: 'economic_code',
  program_code: 'program_code',
  monthly_amount: 'monthly_amount',
  quarterly_amount: 'quarterly_amount',
  ytd_amount: 'ytd_amount',
  is_quarterly: 'is_quarterly',
  is_yearly: 'is_yearly',
  account_category: 'account_category',
  report_type: 'report_type',
  main_creditor_cui: 'main_creditor_cui',
  funding_source_id: 'funding_source_id',
  budget_sector_id: 'budget_sector_id',
  expense_type: 'expense_type',
} as const;

export type ExecutionLineItemColumn = keyof typeof ExecutionLineItemColumns;

/**
 * Column names for entities table.
 */
export const EntityColumns = {
  cui: 'cui',
  name: 'name',
  entity_type: 'entity_type',
  uat_id: 'uat_id',
  is_uat: 'is_uat',
  address: 'address',
  last_updated: 'last_updated',
  default_report_type: 'default_report_type',
  main_creditor_1_cui: 'main_creditor_1_cui',
  main_creditor_2_cui: 'main_creditor_2_cui',
} as const;

export type EntityColumn = keyof typeof EntityColumns;

/**
 * Column names for uats table.
 */
export const UatColumns = {
  id: 'id',
  siruta_code: 'siruta_code',
  name: 'name',
  county_code: 'county_code',
  county_name: 'county_name',
  region: 'region',
  population: 'population',
  uat_type: 'uat_type',
} as const;

export type UatColumn = keyof typeof UatColumns;

/**
 * Column names for functionalclassifications table.
 */
export const FunctionalClassificationColumns = {
  functional_code: 'functional_code',
  functional_name: 'functional_name',
} as const;

export type FunctionalClassificationColumn = keyof typeof FunctionalClassificationColumns;

/**
 * Column names for economicclassifications table.
 */
export const EconomicClassificationColumns = {
  economic_code: 'economic_code',
  economic_name: 'economic_name',
} as const;

export type EconomicClassificationColumn = keyof typeof EconomicClassificationColumns;

/**
 * Column names for reports table.
 */
export const ReportColumns = {
  report_id: 'report_id',
  entity_cui: 'entity_cui',
  year: 'year',
  report_type: 'report_type',
} as const;

export type ReportColumn = keyof typeof ReportColumns;

// ============================================================================
// Amount Column Mapping
// ============================================================================

/**
 * Maps frequency to the appropriate amount column.
 */
export const AmountColumnByFrequency = {
  MONTH: 'monthly_amount',
  QUARTER: 'quarterly_amount',
  YEAR: 'ytd_amount',
} as const;

export type AmountColumn = (typeof AmountColumnByFrequency)[keyof typeof AmountColumnByFrequency];

// ============================================================================
// Aggregate Expression Names (for CTE results)
// ============================================================================

/**
 * Standard names for computed/aggregated columns in CTEs.
 */
export const AggregateColumns = {
  normalized_amount: 'normalized_amount',
  total_amount: 'total_amount',
  per_capita_amount: 'per_capita_amount',
  total_count: 'total_count',
  count: 'count',
  amount: 'amount',
  period_value: 'period_value',
  period_key: 'period_key',
  multiplier: 'multiplier',
  county_population: 'county_population',
} as const;

export type AggregateColumn = keyof typeof AggregateColumns;
