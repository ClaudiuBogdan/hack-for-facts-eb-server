// Ignore naming conventions for database tables

import { Generated, ColumnType } from 'kysely';

import type { DbReportType } from '@/common/types/report-types.js';

// Enum Types
export type ReportType = DbReportType;

export type ExpenseType = 'dezvoltare' | 'functionare';
export type AccountCategory = 'vn' | 'ch';
export type AnomalyType = 'YTD_ANOMALY' | 'MISSING_LINE_ITEM';

// Helper for timestamps which can be strings or Dates depending on driver config
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// UATs Table
export interface UATs {
  id: Generated<number>;
  uat_key: string;
  uat_code: string;
  siruta_code: string;
  name: string;
  county_code: string;
  county_name: string;
  region: string;
  population: number | null;
  last_updated: Generated<Timestamp>;
}

// Entities Table
export interface Entities {
  cui: string;
  name: string;
  uat_id: number | null;
  address: string | null;
  entity_type: string | null;
  default_report_type: ReportType | null;
  is_uat: Generated<boolean>;
  last_updated: Generated<Timestamp>;
  main_creditor_1_cui: string | null;
  main_creditor_2_cui: string | null;
}

// Functional Classifications Table
export interface FunctionalClassifications {
  functional_code: string;
  functional_name: string;
}

// Economic Classifications Table
export interface EconomicClassifications {
  economic_code: string;
  economic_name: string;
}

// Funding Sources Table
export interface FundingSources {
  source_id: Generated<number>;
  source_description: string;
}

// Budget Sectors Table
export interface BudgetSectors {
  sector_id: Generated<number>;
  sector_description: string;
}

// Tags Table
export interface Tags {
  tag_id: Generated<number>;
  tag_name: string;
  created_at: Generated<Timestamp>;
}

// Reports Table
export interface Reports {
  report_id: string;
  entity_cui: string;
  report_type: ReportType;
  main_creditor_cui: string | null;
  report_date: Timestamp;
  reporting_year: number;
  reporting_period: string;
  budget_sector_id: number;
  file_source: string | null;
  import_timestamp: Generated<Timestamp>;
  download_links: string[] | null;
}
// ExecutionLineItems Table
export interface ExecutionLineItems {
  year: number;
  month: number;
  report_type: ReportType;
  line_item_id: Generated<string>; // BIGINT
  report_id: string;
  entity_cui: string;
  main_creditor_cui: string | null;
  budget_sector_id: number;
  funding_source_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: AccountCategory;
  program_code: string | null;
  expense_type: ExpenseType | null;
  ytd_amount: string; // NUMERIC(18,2) -> string
  monthly_amount: string; // NUMERIC(18,2) -> string
  is_quarterly: Generated<boolean>;
  quarter: number | null;
  quarterly_amount: string | null; // NUMERIC(18,2) -> string
  is_yearly: Generated<boolean>;
  anomaly: AnomalyType | null;
}

// AngajamenteLineItems Table
export interface AngajamenteLineItems {
  year: number;
  month: number;
  report_type: ReportType;
  line_item_id: Generated<string>; // BIGINT
  report_id: string;
  entity_cui: string;
  main_creditor_cui: string | null;
  budget_sector_id: number;
  funding_source_id: number;
  functional_code: string;
  economic_code: string | null;

  // YTD metrics (NUMERIC -> string)
  credite_angajament: string;
  limita_credit_angajament: string;
  credite_bugetare: string;
  credite_angajament_initiale: string;
  credite_bugetare_initiale: string;
  credite_angajament_definitive: string;
  credite_bugetare_definitive: string;
  credite_angajament_disponibile: string;
  credite_bugetare_disponibile: string;
  receptii_totale: string;
  plati_trezor: string;
  plati_non_trezor: string;
  receptii_neplatite: string;

  // Monthly deltas (NUMERIC -> string)
  monthly_plati_trezor: string;
  monthly_plati_non_trezor: string;
  monthly_receptii_totale: string;
  monthly_receptii_neplatite_change: string;
  monthly_credite_angajament: string;

  // Period flags
  is_quarterly: Generated<boolean>;
  quarter: number | null;
  is_yearly: Generated<boolean>;

  // Quarterly deltas (NUMERIC -> string)
  quarterly_credite_angajament: string | null;
  quarterly_limita_credit_angajament: string | null;
  quarterly_credite_bugetare: string | null;
  quarterly_credite_angajament_initiale: string | null;
  quarterly_credite_bugetare_initiale: string | null;
  quarterly_credite_angajament_definitive: string | null;
  quarterly_credite_bugetare_definitive: string | null;
  quarterly_credite_angajament_disponibile: string | null;
  quarterly_credite_bugetare_disponibile: string | null;
  quarterly_receptii_totale: string | null;
  quarterly_plati_trezor: string | null;
  quarterly_plati_non_trezor: string | null;
  quarterly_receptii_neplatite: string | null;

  anomaly: AnomalyType | null;
}

// Junction Tables
export interface EntityTags {
  entity_cui: string;
  tag_id: number;
}

export interface FunctionalClassificationTags {
  functional_code: string;
  tag_id: number;
}

export interface EconomicClassificationTags {
  economic_code: string;
  tag_id: number;
}

// Materialized Views
export interface MvReportAvailability {
  entity_cui: string;
  year: number;
  report_type: ReportType;
  priority: number;
  has_december_data: number;
  available_months: number[];
  latest_month: number;
}

export interface MvSummaryQuarterly {
  year: number;
  quarter: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  total_income: string;
  total_expense: string;
  budget_balance: string;
}

export interface MvSummaryMonthly {
  year: number;
  month: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  total_income: string;
  total_expense: string;
  budget_balance: string;
}

export interface MvSummaryAnnual {
  year: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  total_income: string;
  total_expense: string;
  budget_balance: string;
}

export interface MvAngajamenteSummaryQuarterly {
  year: number;
  quarter: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  credite_angajament: string;
  limita_credit_angajament: string;
  credite_bugetare: string;
  credite_angajament_initiale: string;
  credite_bugetare_initiale: string;
  credite_angajament_definitive: string;
  credite_bugetare_definitive: string;
  credite_angajament_disponibile: string;
  credite_bugetare_disponibile: string;
  receptii_totale: string;
  plati_trezor: string;
  plati_non_trezor: string;
  receptii_neplatite: string;
}

export interface MvAngajamenteSummaryMonthly {
  year: number;
  month: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  credite_angajament: string;
  plati_trezor: string;
  plati_non_trezor: string;
  receptii_totale: string;
  receptii_neplatite_change: string;
}

export interface MvAngajamenteSummaryAnnual {
  year: number;
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: ReportType;
  credite_angajament: string;
  limita_credit_angajament: string;
  credite_bugetare: string;
  credite_angajament_initiale: string;
  credite_bugetare_initiale: string;
  credite_angajament_definitive: string;
  credite_bugetare_definitive: string;
  credite_angajament_disponibile: string;
  credite_bugetare_disponibile: string;
  receptii_totale: string;
  plati_trezor: string;
  plati_non_trezor: string;
  receptii_neplatite: string;
}

// Database Schema Interface
// Note: PostgreSQL converts unquoted identifiers to lowercase, so table names here must be lowercase
export interface BudgetDatabase {
  uats: UATs;
  entities: Entities;
  functionalclassifications: FunctionalClassifications;
  economicclassifications: EconomicClassifications;
  fundingsources: FundingSources;
  budgetsectors: BudgetSectors;
  tags: Tags;
  reports: Reports;
  executionlineitems: ExecutionLineItems;
  angajamentelineitems: AngajamenteLineItems;
  entitytags: EntityTags;
  functionalclassificationtags: FunctionalClassificationTags;
  economicclassificationtags: EconomicClassificationTags;
  mv_report_availability: MvReportAvailability;
  mv_summary_quarterly: MvSummaryQuarterly;
  mv_summary_monthly: MvSummaryMonthly;
  mv_summary_annual: MvSummaryAnnual;
  mv_angajamente_summary_quarterly: MvAngajamenteSummaryQuarterly;
  mv_angajamente_summary_monthly: MvAngajamenteSummaryMonthly;
  mv_angajamente_summary_annual: MvAngajamenteSummaryAnnual;
}
