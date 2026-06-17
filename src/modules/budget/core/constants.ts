/**
 * Budget module — enum ↔ partition-literal maps + shared constants (plan §0.1,
 * §3.4). The API surface exposes CLEAN enums (`EXECUTION_DETAILED`, `EXPENSE`);
 * a kernel-internal map translates enum → the exact partition literal at the repo
 * boundary so the planner prunes. The DB literals NEVER leak to the surface, but
 * the SQL always uses the literal (verified live 2026-06-16).
 */

// ── execution report_type (LIST L2 partition keys — verified live) ────────────

export const EXECUTION_REPORT_TYPES = [
  'EXECUTION_DETAILED',
  'EXECUTION_AGG_PRINCIPAL',
  'EXECUTION_AGG_SECONDARY',
] as const;
export type ExecutionReportType = (typeof EXECUTION_REPORT_TYPES)[number];

export const EXECUTION_REPORT_TYPE_LABELS: Record<ExecutionReportType, string> = {
  EXECUTION_DETAILED: 'Executie bugetara detaliata',
  EXECUTION_AGG_PRINCIPAL: 'Executie bugetara agregata la nivel de ordonator principal',
  EXECUTION_AGG_SECONDARY: 'Executie bugetara agregata la nivel de ordonator secundar',
};

/** Reverse map (partition literal → clean enum) for mapping fact rows out. */
export const EXECUTION_REPORT_TYPE_FROM_LABEL: ReadonlyMap<string, ExecutionReportType> = new Map(
  EXECUTION_REPORT_TYPES.map((e) => [EXECUTION_REPORT_TYPE_LABELS[e], e])
);

// ── commitment report_type (LIST L2 partition keys — verified live) ───────────

export const COMMITMENT_REPORT_TYPES = [
  'COMMITMENT_AGG_PRINCIPAL',
  'COMMITMENT_AGG_SECONDARY',
  'COMMITMENT_DETAILED',
] as const;
export type CommitmentReportType = (typeof COMMITMENT_REPORT_TYPES)[number];

export const COMMITMENT_REPORT_TYPE_LABELS: Record<CommitmentReportType, string> = {
  COMMITMENT_AGG_PRINCIPAL: 'Executie - Angajamente bugetare agregat principal',
  COMMITMENT_AGG_SECONDARY: 'Executie - Angajamente bugetare agregat secundar',
  COMMITMENT_DETAILED: 'Executie - Angajamente bugetare detaliat',
};

export const COMMITMENT_REPORT_TYPE_FROM_LABEL: ReadonlyMap<string, CommitmentReportType> = new Map(
  COMMITMENT_REPORT_TYPES.map((e) => [COMMITMENT_REPORT_TYPE_LABELS[e], e])
);

// ── account_category (LIST L3 partition key) ──────────────────────────────────

export const ACCOUNT_CATEGORIES = ['INCOME', 'EXPENSE'] as const;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

/** Clean enum → DB literal (income = venituri = 'vn'; expense = cheltuieli = 'ch'). */
export const ACCOUNT_CATEGORY_LABELS: Record<AccountCategory, string> = {
  INCOME: 'vn',
  EXPENSE: 'ch',
};
export const ACCOUNT_CATEGORY_FROM_LABEL: ReadonlyMap<string, AccountCategory> = new Map([
  ['vn', 'INCOME'],
  ['ch', 'EXPENSE'],
]);

// ── frequency (selects the period-scope partial index + the amount column) ────

export const BUDGET_FREQUENCIES = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type BudgetFrequency = (typeof BUDGET_FREQUENCIES)[number];

/** The execution amount column for a frequency (matches getAmountColumnName legacy). */
export const EXECUTION_AMOUNT_COLUMN: Record<BudgetFrequency, 'monthly_amount' | 'quarterly_amount' | 'ytd_amount'> = {
  MONTH: 'monthly_amount',
  QUARTER: 'quarterly_amount',
  YEAR: 'ytd_amount',
};

/** The is_* flag column the frequency selects (the partial period-scope index). */
export const FREQUENCY_FLAG_COLUMN: Record<BudgetFrequency, 'is_monthly' | 'is_quarterly' | 'is_yearly'> = {
  MONTH: 'is_monthly',
  QUARTER: 'is_quarterly',
  YEAR: 'is_yearly',
};

// ── normalization (plan §3.4 — consolidated single mechanism) ─────────────────

export const BUDGET_NORMALIZATIONS = [
  'TOTAL',
  'TOTAL_EURO',
  'PER_CAPITA',
  'PER_CAPITA_EURO',
  'PERCENT_GDP',
] as const;
export type BudgetNormalization = (typeof BUDGET_NORMALIZATIONS)[number];

// ── transfer exclusions (plan §3.4 — the EXACT set the MVs bake in) ───────────
// Verified against legacy commitments-repo.ts. Fact-path `excludeTransfers` MUST
// use this verbatim so fact-path and MV-path "exclude transfers" answers match.
// Economic prefixes apply to EXPENSE; functional prefixes to INCOME.

export const BUDGET_TRANSFER_EXCLUSIONS = {
  economicPrefixes: ['51.01', '51.02'] as const, // expense side
  functionalPrefixes: ['36.02.05', '37.02.03', '37.02.04', '47.02.04'] as const, // income side
} as const;

// ── Bucharest special-case (plan §3.4 — centralized once, consumed here) ──────
// Bucharest is county_code 'B'; its municipality-level SIRUTA/CUI is 179132.
export const BUCHAREST_SIRUTA_CODE = '179132';
export const BUCHAREST_COUNTY_CODE = 'B';

// ── grain note (Grain Gate §14.6) ─────────────────────────────────────────────
export const BUDGET_GRAIN_NOTE =
  'Budget facts are a balance-sheet grain (execution income/expense, commitments). ' +
  'Execution and commitment totals are NEVER summed together. ' +
  'Cross-source money flows are not yet projected for budget.';

// ── flow / doc type registrations this module owns (plan §4.1, §9) ────────────
export const BUDGET_FLOW_TYPE = 'budget_execution';
export const BUDGET_DOC_TYPES = ['budget_entity', 'budget_report'] as const;
