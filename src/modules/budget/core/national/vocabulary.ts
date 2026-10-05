/**
 * National budget — closed public vocabularies (one tuple per national SDL enum).
 *
 * Database literals are deliberately limited to those the reviewed design or
 * P0 evidence pins: observation input IDs (`bgc`, `sinteza`; their `input_id`
 * is the third cursor key) and the view's `available` marker. Other source
 * vocabularies are mapped by the read adapter; core never guesses a literal.
 */

export const PERIOD_TYPES = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

export const BUDGET_FUNDS = [
  'STATE_BUDGET',
  'STATE_SOCIAL_INSURANCE',
  'HEALTH_INSURANCE',
  'UNEMPLOYMENT_INSURANCE',
] as const;
export type BudgetFund = (typeof BUDGET_FUNDS)[number];

export const APPROVED_FORMS = [
  'STATE_BUDGET_SYNTHESIS',
  'STATE_BUDGET_AUTHORITY_DETAIL',
  'STATE_SOCIAL_INSURANCE_SYNTHESIS',
  'HEALTH_INSURANCE_SYNTHESIS',
  'UNEMPLOYMENT_INSURANCE_SYNTHESIS',
] as const;
export type ApprovedForm = (typeof APPROVED_FORMS)[number];

/** The fund each form belongs to. */
export const FORM_FUND: Readonly<Record<ApprovedForm, BudgetFund>> = {
  STATE_BUDGET_SYNTHESIS: 'STATE_BUDGET',
  STATE_BUDGET_AUTHORITY_DETAIL: 'STATE_BUDGET',
  STATE_SOCIAL_INSURANCE_SYNTHESIS: 'STATE_SOCIAL_INSURANCE',
  HEALTH_INSURANCE_SYNTHESIS: 'HEALTH_INSURANCE',
  UNEMPLOYMENT_INSURANCE_SYNTHESIS: 'UNEMPLOYMENT_INSURANCE',
};

/** The synthesis form of each fund (the source of fund-scope descriptors). */
export const SYNTHESIS_FORM: Readonly<Record<BudgetFund, ApprovedForm>> = {
  STATE_BUDGET: 'STATE_BUDGET_SYNTHESIS',
  STATE_SOCIAL_INSURANCE: 'STATE_SOCIAL_INSURANCE_SYNTHESIS',
  HEALTH_INSURANCE: 'HEALTH_INSURANCE_SYNTHESIS',
  UNEMPLOYMENT_INSURANCE: 'UNEMPLOYMENT_INSURANCE_SYNTHESIS',
};

export const AUTHORITY_DETAIL_FORM = 'STATE_BUDGET_AUTHORITY_DETAIL' satisfies ApprovedForm;

/** The revenue holder's code in the authority detail; it is not an authority. */
export const REVENUE_HOLDER_AUTHORITY_CODE = '999';

export const APPROVED_MEASURES = ['APPROVED', 'FORECAST'] as const;
export type ApprovedMeasure = (typeof APPROVED_MEASURES)[number];

export const CREDIT_TYPES = ['BUDGET_CREDITS', 'COMMITMENT_CREDITS'] as const;
export type CreditType = (typeof CREDIT_TYPES)[number];

export const ROW_ROLES = ['DESCRIPTOR', 'CREDIT'] as const;
export type RowRole = (typeof ROW_ROLES)[number];

export const TOTAL_KEYS = [
  'REVENUE_TOTAL',
  'EXPENDITURE_5000_TOTAL_GENERAL',
  'EXPENDITURE_5001_STATE_BUDGET',
  'EXPENDITURE_5005_CHELTUIELI_TOTAL',
  'AUTHORITY_EXPENDITURE_5001',
] as const;
export type TotalKey = (typeof TOTAL_KEYS)[number];

export const TOTAL_SCOPES = ['FUND', 'AUTHORITY'] as const;
export type TotalScope = (typeof TOTAL_SCOPES)[number];

export const APPROVED_STATUSES = [
  'AVAILABLE',
  'SLOT_WITHOUT_VALUE',
  'NO_MATCHING_RECORD',
  'AMBIGUOUS',
  'FORM_NOT_LOADED',
  'NOT_IN_EDITION',
  'EDITION_NOT_LOADED',
  'MULTIPLE_EDITIONS',
] as const;
export type ApprovedStatus = (typeof APPROVED_STATUSES)[number];

/** Axis-only states: series periods may carry them, totals cells never do. */
export type ApprovedAxisStatus = 'NOT_IN_EDITION' | 'EDITION_NOT_LOADED' | 'MULTIPLE_EDITIONS';
export type ApprovedCellStatus = Exclude<ApprovedStatus, ApprovedAxisStatus>;

export const APPROVED_AXES = [
  'TARGET_YEARS_OF_EDITION',
  'EDITIONS_FOR_TARGET',
  'OWN_YEAR_APPROVALS',
] as const;
export type ApprovedAxis = (typeof APPROVED_AXES)[number];

export const APPROVED_UNITS = ['THOUSAND_LEI', 'RON'] as const;
export type ApprovedUnit = (typeof APPROVED_UNITS)[number];

export const VALUE_UNITS = ['THOUSAND_LEI', 'RON', 'FRACTION'] as const;
export type ValueUnit = (typeof VALUE_UNITS)[number];

// ── execution (MF bulletin) ──────────────────────────────────────────────────

export const EXECUTION_INPUTS = ['BGC', 'SINTEZA'] as const;
export type ExecutionInput = (typeof EXECUTION_INPUTS)[number];

/** Stored observation `input_id` of each input (P0: only these two). */
export const EXECUTION_INPUT_SOURCE = {
  BGC: 'bgc',
  SINTEZA: 'sinteza',
} as const satisfies Readonly<Record<ExecutionInput, string>>;
export type ExecutionInputSourceId = (typeof EXECUTION_INPUT_SOURCE)[ExecutionInput];
export const EXECUTION_INPUT_SOURCE_IDS: readonly ExecutionInputSourceId[] = ['bgc', 'sinteza'];

/** The only input the reviewed national catalog maps (`input_id = 'bgc'`). */
export const CATALOG_INPUT_SOURCE_ID = EXECUTION_INPUT_SOURCE.BGC;

export const EXECUTION_FAMILIES = ['BGC', 'SINTEZA', 'NOTA'] as const;
export type ExecutionFamily = (typeof EXECUTION_FAMILIES)[number];

export const FAMILY_PRESENCES = [
  'PRESENT',
  'NOT_LISTED_IN_CAPTURED_PACKET',
  'LISTED_ORIGINAL_UNAVAILABLE',
  'FAMILY_UNRESOLVED',
] as const;
export type FamilyPresence = (typeof FAMILY_PRESENCES)[number];

export const EXECUTION_SECTIONS = ['REVENUE', 'EXPENDITURE', 'BALANCE'] as const;
export type ExecutionSection = (typeof EXECUTION_SECTIONS)[number];

export const PERIOD_ROLES = ['CURRENT', 'COMPARISON', 'DIFFERENCE'] as const;
export type PeriodRole = (typeof PERIOD_ROLES)[number];

export const EXECUTION_MEASURES = [
  'AMOUNT',
  'GDP_SHARE',
  'PUBLISHED_TOTAL_SHARE',
  'AMOUNT_DIFFERENCE',
  'RELATIVE_CHANGE',
  'GDP_DENOMINATOR',
] as const;
export type ExecutionMeasure = (typeof EXECUTION_MEASURES)[number];

export const COVERAGE_KINDS = ['REPORT_PERIOD', 'COMPONENT_INTERVAL', 'NOT_APPLICABLE'] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export const EXECUTION_STATUSES = ['ACTUAL', 'ESTIMATE'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const FINALITIES = ['FINAL', 'OPERATIVE', 'UNKNOWN'] as const;
export type Finality = (typeof FINALITIES)[number];

export const OBSERVATION_DISPOSITIONS = ['FACT', 'BLANK', 'UNRESOLVED', 'NONFINANCIAL'] as const;
export type ObservationDisposition = (typeof OBSERVATION_DISPOSITIONS)[number];

export const MONTH_STATUSES = ['SELECTED', 'NO_SELECTED_RELEASE'] as const;
export type MonthStatus = (typeof MONTH_STATUSES)[number];

export const SERIES_BASES = ['YTD', 'PERIOD_DIFFERENCE', 'FULL_YEAR'] as const;
export type SeriesBasis = (typeof SERIES_BASES)[number];

export const SERIES_PERIOD_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'OUT_OF_COVERAGE'] as const;
export type SeriesPeriodStatus = (typeof SERIES_PERIOD_STATUSES)[number];

export const VALUE_BASES = [
  'REPORTED_CUMULATIVE',
  'REPORTED_CUMULATIVE_FIRST_PERIOD',
  'DERIVED_DIFFERENCE_BETWEEN_REPORTS',
] as const;
export type ValueBasis = (typeof VALUE_BASES)[number];

/** The view's availability marker; served as status AVAILABLE with reason null. */
export const VIEW_AVAILABLE_REASON = 'available';

/** Server-only coverage reasons, in the view's lowercase style. */
export const BEFORE_FIRST_RELEASE = 'before_first_release';
export const AFTER_LAST_RELEASE = 'after_last_release';

/**
 * Reasons known at review time. Documentation only: the list is open, and an
 * unknown view reason is passed through verbatim, never filtered or mapped.
 */
export const KNOWN_VIEW_REASONS = [
  'missing_endpoint_release',
  'definition_change',
  'absent_endpoint_item',
  'blank_endpoint_value',
  'unresolved_endpoint_value',
  'incompatible_endpoint_coverage',
  'missing_predecessor_release',
  'absent_predecessor_item',
  'blank_predecessor_value',
  'unresolved_predecessor_value',
  'incompatible_operand_qualifiers',
] as const;

/** Typed membership test for a closed tuple. */
export const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);
