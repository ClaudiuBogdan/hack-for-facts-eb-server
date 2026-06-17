/**
 * Budget module — `ProdDatabase` augmentation (foundation §3, module-augmentation
 * pattern §14; plan 02 §2).
 *
 * Types the live `budget.*` tables onto the single kernel Kysely instance via TS
 * declaration merging. Table keys are the schema-qualified live names exactly as
 * the prod snapshot (`'budget.execution_line_items'`), so the repo reads the
 * partitioned parents directly and the planner prunes from the WHERE.
 *
 * This module touches the PARTITIONED PARENTS only (never a leaf by name) — the
 * pruning predicate (§0.3) drives the planner to the right `…_yYYYY_rtN_{vn|ch}`
 * leaf. The six summary MVs are typed as plain tables.
 *
 * Scalars (§14.1): `numeric` columns are read as `string` (money precision
 * preserved); `bigint` ids are `string` (the pool's int8 parser). `date` columns
 * are `'YYYY-MM-DD'`; `timestamptz` are ISO strings. Provenance / `metadata jsonb`
 * / `field_trace` / `issues` are NEVER projected (plan §2.3) — they are omitted
 * here so the repo cannot select them by accident.
 */

import type { ColumnType } from 'kysely';

/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;

// ── execution facts (RANGE year → LIST report_type → LIST account_category) ────

export interface BudgetExecutionLineItemsTable {
  execution_line_item_id: string; // bigint → string
  report_id: string;
  line_key: string;
  line_order: number | null;
  reporting_year: number; // RANGE L1 prune
  reporting_month: number;
  quarter: number | null;
  entity_cui: string;
  report_type: string; // LIST L2 prune (partition literal)
  main_creditor_cui: string | null;
  budget_sector_id: number;
  account_category: string; // LIST L3 prune ('vn' | 'ch')
  expense_type: string | null;
  functional_code: string;
  functional_name: string | null;
  economic_code: string | null;
  economic_name: string | null;
  funding_source: string | null;
  funding_source_description: string | null;
  funding_source_id: number;
  program_code: string | null;
  ytd_amount: string; // numeric(18,2) → string
  monthly_amount: string;
  quarterly_amount: string | null;
  is_monthly: boolean;
  is_quarterly: boolean;
  is_yearly: boolean;
  anomaly: string | null;
}

// ── commitment facts (RANGE year → LIST report_type) ──────────────────────────
// 13 metric families × {ytd, monthly, quarterly, latest}. Only the columns the
// module surfaces are typed; all are numeric → string.

export interface BudgetCommitmentLineItemsTable {
  commitment_line_item_id: string; // bigint → string
  report_id: string;
  line_key: string;
  line_order: number | null;
  reporting_year: number; // RANGE L1 prune
  reporting_month: number;
  quarter: number | null;
  entity_cui: string;
  report_type: string; // LIST L2 prune (partition literal)
  main_creditor_cui: string | null;
  budget_sector_id: number;
  functional_code: string;
  functional_name: string | null;
  economic_code: string | null;
  economic_name: string | null;
  funding_source: string | null;
  funding_source_description: string | null;
  funding_source_id: number;
  // 13 metric families (ytd / monthly / quarterly / latest) — numeric → string.
  ytd_credite_angajament: string | null;
  monthly_credite_angajament: string | null;
  quarterly_credite_angajament: string | null;
  credite_angajament: string | null;
  ytd_limita_credit_angajament: string | null;
  monthly_limita_credit_angajament: string | null;
  quarterly_limita_credit_angajament: string | null;
  limita_credit_angajament: string | null;
  ytd_credite_bugetare: string | null;
  monthly_credite_bugetare: string | null;
  quarterly_credite_bugetare: string | null;
  credite_bugetare: string | null;
  ytd_credite_angajament_initiale: string | null;
  monthly_credite_angajament_initiale: string | null;
  quarterly_credite_angajament_initiale: string | null;
  credite_angajament_initiale: string | null;
  ytd_credite_bugetare_initiale: string | null;
  monthly_credite_bugetare_initiale: string | null;
  quarterly_credite_bugetare_initiale: string | null;
  credite_bugetare_initiale: string | null;
  ytd_credite_angajament_definitive: string | null;
  monthly_credite_angajament_definitive: string | null;
  quarterly_credite_angajament_definitive: string | null;
  credite_angajament_definitive: string | null;
  ytd_credite_bugetare_definitive: string | null;
  monthly_credite_bugetare_definitive: string | null;
  quarterly_credite_bugetare_definitive: string | null;
  credite_bugetare_definitive: string | null;
  ytd_receptii_totale: string | null;
  monthly_receptii_totale: string | null;
  quarterly_receptii_totale: string | null;
  receptii_totale: string | null;
  ytd_plati_trezor: string | null;
  monthly_plati_trezor: string | null;
  quarterly_plati_trezor: string | null;
  plati_trezor: string | null;
  ytd_plati_non_trezor: string | null;
  monthly_plati_non_trezor: string | null;
  quarterly_plati_non_trezor: string | null;
  plati_non_trezor: string | null;
  ytd_receptii_neplatite: string | null;
  monthly_receptii_neplatite: string | null;
  quarterly_receptii_neplatite: string | null;
  receptii_neplatite: string | null;
  is_monthly: boolean;
  is_quarterly: boolean;
  is_yearly: boolean;
  anomaly: string | null;
}

// ── execution summary MVs (entity × period × report_type; pre-pivoted vn/ch) ──
// NO account_category column — INCOME → total_income, EXPENSE → total_expense,
// BALANCE → budget_balance (column selector, NOT a predicate; plan §0.4).

export interface BudgetMvExecutionAnnualTable {
  year: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  total_income: string; // numeric → string
  total_expense: string;
  budget_balance: string;
}

export interface BudgetMvExecutionMonthlyTable extends BudgetMvExecutionAnnualTable {
  month: number;
}

export interface BudgetMvExecutionQuarterlyTable extends BudgetMvExecutionAnnualTable {
  quarter: number;
}

// ── commitment summary MVs (entity × period × report_type; 13 metrics) ────────

export interface BudgetMvCommitmentAnnualTable {
  year: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  credite_angajament: string | null;
  limita_credit_angajament: string | null;
  credite_bugetare: string | null;
  credite_angajament_initiale: string | null;
  credite_bugetare_initiale: string | null;
  credite_angajament_definitive: string | null;
  credite_bugetare_definitive: string | null;
  credite_angajament_disponibile: string | null;
  credite_bugetare_disponibile: string | null;
  receptii_totale: string | null;
  plati_trezor: string | null;
  plati_non_trezor: string | null;
  receptii_neplatite: string | null;
}

export interface BudgetMvCommitmentMonthlyTable {
  year: number;
  month: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  credite_angajament: string | null;
  plati_trezor: string | null;
  plati_non_trezor: string | null;
  receptii_totale: string | null;
  receptii_neplatite_change: string | null;
}

export interface BudgetMvCommitmentQuarterlyTable extends BudgetMvCommitmentAnnualTable {
  quarter: number;
}

// ── reports registry ──────────────────────────────────────────────────────────

export interface BudgetReportsTable {
  report_id: string;
  entity_cui: string;
  report_type: string;
  main_creditor_cui: string | null;
  report_date: string | null; // date
  reporting_year: number;
  reporting_period: string;
  budget_sector_id: number | null;
  file_source: string | null;
  download_links: string[] | null; // text[]
}

// ── dimensions (small reference tables) ───────────────────────────────────────

export interface BudgetFunctionalClassificationsTable {
  functional_code: string;
  functional_name: string | null;
}

export interface BudgetEconomicClassificationsTable {
  economic_code: string;
  economic_name: string | null;
}

export interface BudgetSectorsTable {
  sector_id: number;
  sector_description: string | null;
}

export interface BudgetFundingSourcesTable {
  source_id: number;
  source_code: string | null;
  source_description: string | null;
}

// ── budget-official (un-partitioned; capability-gated on row presence) ────────

export interface BudgetApprovedBudgetFactsTable {
  fact_id: string;
  budget_year: number;
  measure_year: number | null;
  budget_component: string | null;
  functional_code: string | null;
  economic_code: string | null;
  funding_source: string | null;
  program_code: string | null;
  ordonator_code: string | null;
  label: string | null;
  measure_kind: string | null;
  amount_value: string | null; // numeric → string
  unit: string | null;
  loaded_at: Tstz | null;
}

export interface BudgetExecutionVsBudgetView {
  bgc_fact_id: string | null;
  period_year: number | null;
  period_month: number | null;
  period_end_date: string | null;
  component_key: string | null;
  section: string | null;
  line_item_key: string | null;
  line_item_label: string | null;
  execution_amount_ron: string | null; // numeric → string
  approved_fact_id: string | null;
  budget_year: number | null;
  measure_year: number | null;
  approved_amount_ron: string | null;
  comparison_basis: string | null;
  delta_amount: string | null;
}

export interface BudgetBgcOfficialFactsTable {
  fact_id: string;
  period_year: number | null;
}

/**
 * Declaration-merge the `budget.*` tables onto the kernel `ProdDatabase`. Importing
 * this module's barrel (which re-exports this file) pulls the augmentation in.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'budget.execution_line_items': BudgetExecutionLineItemsTable;
    'budget.commitment_line_items': BudgetCommitmentLineItemsTable;
    'budget.mv_execution_summary_annual': BudgetMvExecutionAnnualTable;
    'budget.mv_execution_summary_monthly': BudgetMvExecutionMonthlyTable;
    'budget.mv_execution_summary_quarterly': BudgetMvExecutionQuarterlyTable;
    'budget.mv_commitment_summary_annual': BudgetMvCommitmentAnnualTable;
    'budget.mv_commitment_summary_monthly': BudgetMvCommitmentMonthlyTable;
    'budget.mv_commitment_summary_quarterly': BudgetMvCommitmentQuarterlyTable;
    'budget.reports': BudgetReportsTable;
    'budget.functional_classifications': BudgetFunctionalClassificationsTable;
    'budget.economic_classifications': BudgetEconomicClassificationsTable;
    'budget.budget_sectors': BudgetSectorsTable;
    'budget.funding_sources': BudgetFundingSourcesTable;
    'budget.approved_budget_facts': BudgetApprovedBudgetFactsTable;
    'budget.execution_vs_budget': BudgetExecutionVsBudgetView;
    'budget.bgc_official_facts': BudgetBgcOfficialFactsTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
