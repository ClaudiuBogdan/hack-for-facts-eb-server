/**
 * Budget repo — row → view-model mappers (plan §2). Money columns arrive as
 * `string` (numeric → string at the pg boundary, precision-safe). The clean enum
 * is mapped from the partition literal here (constants.ts reverse maps). A row
 * whose report_type literal is unknown falls back to the raw string + the caller
 * surfaces a caveat ('unmapped report type', plan §13.6) — never throws.
 */

import {
  ACCOUNT_CATEGORY_FROM_LABEL,
  COMMITMENT_REPORT_TYPE_FROM_LABEL,
  EXECUTION_REPORT_TYPE_FROM_LABEL,
  type AccountCategory,
  type CommitmentReportType,
  type ExecutionReportType,
} from '../../core/constants.js';

import type {
  ApprovedBudgetFact,
  BudgetClassification,
  BudgetFundingSource,
  BudgetReport,
  BudgetSector,
  CommitmentLineItem,
  CommitmentMetric,
  ExecutionLineItem,
} from '../../core/types.js';

/** Map a numeric string through unchanged (already a precision-safe string). */
export const money = (v: string | null): string | null => v;

/** Coerce a count column (text/number) to a JS number. */
export const num = (v: string | number | null | undefined): number => Number(v ?? 0);

/** Map a numeric string to a nullable JS number (for progress/avg fields). */
export const toFloat = (v: string | null): number | null =>
  v === null || v === '' ? null : Number(v);

/** Resolve an execution report_type literal → clean enum (fallback: detailed). */
export const execReportType = (label: string): ExecutionReportType =>
  EXECUTION_REPORT_TYPE_FROM_LABEL.get(label) ?? 'EXECUTION_DETAILED';

/** Resolve a commitment report_type literal → clean enum (fallback: principal). */
export const commitReportType = (label: string): CommitmentReportType =>
  COMMITMENT_REPORT_TYPE_FROM_LABEL.get(label) ?? 'COMMITMENT_AGG_PRINCIPAL';

/** Resolve an account_category literal ('vn'|'ch') → clean enum. */
export const accountCategory = (label: string): AccountCategory =>
  ACCOUNT_CATEGORY_FROM_LABEL.get(label) ?? 'EXPENSE';

// ── row shapes (the SELECTed columns; money already ::text) ────────────────────

export interface ExecutionRow {
  execution_line_item_id: string;
  report_id: string;
  reporting_year: number;
  reporting_month: number;
  quarter: number | null;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  account_category: string;
  budget_sector_id: number;
  expense_type: string | null;
  functional_code: string;
  functional_name: string | null;
  economic_code: string | null;
  economic_name: string | null;
  funding_source: string | null;
  funding_source_id: number;
  program_code: string | null;
  ytd_amount: string;
  monthly_amount: string;
  quarterly_amount: string | null;
  is_monthly: boolean;
  is_quarterly: boolean;
  is_yearly: boolean;
  anomaly: string | null;
}

export const mapExecutionLineItem = (r: ExecutionRow): ExecutionLineItem => ({
  executionLineItemId: r.execution_line_item_id,
  reportId: r.report_id,
  reportingYear: r.reporting_year,
  reportingMonth: r.reporting_month,
  quarter: r.quarter,
  entityCui: r.entity_cui,
  mainCreditorCui: r.main_creditor_cui,
  reportType: execReportType(r.report_type),
  accountCategory: accountCategory(r.account_category),
  budgetSectorId: r.budget_sector_id,
  expenseType: r.expense_type,
  functionalCode: r.functional_code,
  functionalName: r.functional_name,
  economicCode: r.economic_code,
  economicName: r.economic_name,
  fundingSource: r.funding_source,
  fundingSourceId: r.funding_source_id,
  programCode: r.program_code,
  ytdAmount: r.ytd_amount,
  monthlyAmount: r.monthly_amount,
  quarterlyAmount: r.quarterly_amount,
  isMonthly: r.is_monthly,
  isQuarterly: r.is_quarterly,
  isYearly: r.is_yearly,
  anomaly: r.anomaly,
});

const metric = (
  ytd: string | null,
  monthly: string | null,
  quarterly: string | null,
  latest: string | null
): CommitmentMetric => ({ ytd, monthly, quarterly, latest });

export interface CommitmentRow {
  commitment_line_item_id: string;
  report_id: string;
  reporting_year: number;
  reporting_month: number;
  quarter: number | null;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  budget_sector_id: number;
  functional_code: string;
  functional_name: string | null;
  economic_code: string | null;
  economic_name: string | null;
  funding_source: string | null;
  funding_source_id: number;
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
  ytd_credite_angajament_disponibile: string | null;
  monthly_credite_angajament_disponibile: string | null;
  quarterly_credite_angajament_disponibile: string | null;
  credite_angajament_disponibile: string | null;
  ytd_credite_bugetare_disponibile: string | null;
  monthly_credite_bugetare_disponibile: string | null;
  quarterly_credite_bugetare_disponibile: string | null;
  credite_bugetare_disponibile: string | null;
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

export const mapCommitmentLineItem = (r: CommitmentRow): CommitmentLineItem => ({
  commitmentLineItemId: r.commitment_line_item_id,
  reportId: r.report_id,
  reportingYear: r.reporting_year,
  reportingMonth: r.reporting_month,
  quarter: r.quarter,
  entityCui: r.entity_cui,
  mainCreditorCui: r.main_creditor_cui,
  reportType: commitReportType(r.report_type),
  budgetSectorId: r.budget_sector_id,
  functionalCode: r.functional_code,
  functionalName: r.functional_name,
  economicCode: r.economic_code,
  economicName: r.economic_name,
  fundingSource: r.funding_source,
  fundingSourceId: r.funding_source_id,
  crediteAngajament: metric(
    r.ytd_credite_angajament,
    r.monthly_credite_angajament,
    r.quarterly_credite_angajament,
    r.credite_angajament
  ),
  limitaCreditAngajament: metric(
    r.ytd_limita_credit_angajament,
    r.monthly_limita_credit_angajament,
    r.quarterly_limita_credit_angajament,
    r.limita_credit_angajament
  ),
  crediteBugetare: metric(
    r.ytd_credite_bugetare,
    r.monthly_credite_bugetare,
    r.quarterly_credite_bugetare,
    r.credite_bugetare
  ),
  crediteAngajamentInitiale: metric(
    r.ytd_credite_angajament_initiale,
    r.monthly_credite_angajament_initiale,
    r.quarterly_credite_angajament_initiale,
    r.credite_angajament_initiale
  ),
  crediteBugetareInitiale: metric(
    r.ytd_credite_bugetare_initiale,
    r.monthly_credite_bugetare_initiale,
    r.quarterly_credite_bugetare_initiale,
    r.credite_bugetare_initiale
  ),
  crediteAngajamentDefinitive: metric(
    r.ytd_credite_angajament_definitive,
    r.monthly_credite_angajament_definitive,
    r.quarterly_credite_angajament_definitive,
    r.credite_angajament_definitive
  ),
  crediteBugetareDefinitive: metric(
    r.ytd_credite_bugetare_definitive,
    r.monthly_credite_bugetare_definitive,
    r.quarterly_credite_bugetare_definitive,
    r.credite_bugetare_definitive
  ),
  crediteAngajamentDisponibile: metric(
    r.ytd_credite_angajament_disponibile,
    r.monthly_credite_angajament_disponibile,
    r.quarterly_credite_angajament_disponibile,
    r.credite_angajament_disponibile
  ),
  crediteBugetareDisponibile: metric(
    r.ytd_credite_bugetare_disponibile,
    r.monthly_credite_bugetare_disponibile,
    r.quarterly_credite_bugetare_disponibile,
    r.credite_bugetare_disponibile
  ),
  receptiiTotale: metric(
    r.ytd_receptii_totale,
    r.monthly_receptii_totale,
    r.quarterly_receptii_totale,
    r.receptii_totale
  ),
  platiTrezor: metric(
    r.ytd_plati_trezor,
    r.monthly_plati_trezor,
    r.quarterly_plati_trezor,
    r.plati_trezor
  ),
  platiNonTrezor: metric(
    r.ytd_plati_non_trezor,
    r.monthly_plati_non_trezor,
    r.quarterly_plati_non_trezor,
    r.plati_non_trezor
  ),
  receptiiNeplatite: metric(
    r.ytd_receptii_neplatite,
    r.monthly_receptii_neplatite,
    r.quarterly_receptii_neplatite,
    r.receptii_neplatite
  ),
  isMonthly: r.is_monthly,
  isQuarterly: r.is_quarterly,
  isYearly: r.is_yearly,
  anomaly: r.anomaly,
});

// ── reports + dimensions ──────────────────────────────────────────────────────

export interface ReportRow {
  report_id: string;
  entity_cui: string;
  entity_name: string | null;
  report_type: string;
  main_creditor_cui: string | null;
  report_date: string | null;
  reporting_year: number;
  reporting_period: string;
  budget_sector_id: number | null;
  file_source: string | null;
  download_links: string[] | null;
}

export const mapReport = (r: ReportRow): BudgetReport => ({
  reportId: r.report_id,
  entityCui: r.entity_cui,
  entityName: r.entity_name,
  reportType: r.report_type,
  mainCreditorCui: r.main_creditor_cui,
  reportDate: r.report_date,
  reportingYear: r.reporting_year,
  reportingPeriod: r.reporting_period,
  budgetSectorId: r.budget_sector_id,
  fileSource: r.file_source,
  downloadLinks: r.download_links ?? [],
});

export const mapClassification = (r: {
  code: string;
  name: string | null;
}): BudgetClassification => ({
  code: r.code,
  name: r.name,
});

export const mapSector = (r: {
  sector_id: number;
  sector_description: string | null;
}): BudgetSector => ({
  sectorId: r.sector_id,
  sectorDescription: r.sector_description,
});

export const mapFundingSource = (r: {
  source_id: number;
  source_code: string | null;
  source_description: string | null;
}): BudgetFundingSource => ({
  sourceId: r.source_id,
  sourceCode: r.source_code,
  sourceDescription: r.source_description,
});

export interface ApprovedRow {
  fact_id: string;
  budget_year: number;
  measure_year: number | null;
  budget_component: string | null;
  functional_code: string | null;
  economic_code: string | null;
  program_code: string | null;
  label: string | null;
  measure_kind: string | null;
  amount_value: string | null;
  unit: string | null;
}

export const mapApprovedFact = (r: ApprovedRow): ApprovedBudgetFact => ({
  factId: r.fact_id,
  budgetYear: r.budget_year,
  measureYear: r.measure_year,
  budgetComponent: r.budget_component,
  functionalCode: r.functional_code,
  economicCode: r.economic_code,
  programCode: r.program_code,
  label: r.label,
  measureKind: r.measure_kind,
  amountValue: r.amount_value,
  unit: r.unit,
});
