/**
 * Companies module — `ProdDatabase` augmentation (foundation §3, §14
 * module-augmentation pattern).
 *
 * Types the live `companies_v2.*` tables onto the single kernel Kysely instance via
 * TS declaration merging. Table keys are the schema-qualified live names exactly
 * as the prod snapshot (`'companies_v2.registrations'`). The `core.*` tables this
 * module also reads (`organizations`, `organization_identifiers`,
 * `classification_codes`) are already typed by the kernel.
 *
 * Scalars (§14.1): `numeric` columns are `string` (money precision preserved),
 * `bigint` columns (`employees`) are `string` (the pool's int8 parser), `date`
 * columns are `'YYYY-MM-DD'` strings, `timestamptz` are ISO strings.
 *
 * `companies_v2.fiscal_status` does not expose the old misleading `is_active`;
 * the public surface keeps only `declaredFiscallyInactive` (`is_inactive`).
 */

import type { ColumnType } from 'kysely';

/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;

export interface CompaniesRegistrationsTable {
  cui: string;
  organization_id: string;
  legal_name: string;
  normalized_legal_name: string;
  cod_inmatriculare: string | null;
  onrc_euid: string | null;
  legal_form: string | null;
  registration_date: string | null; // date
  registration_date_source: string;
  registration_year_hint: number | null;
  registration_year_hint_source: string | null;
  onrc_lifecycle_status_code: string | null;
  onrc_lifecycle_status_label: string | null;
  website: string | null;
  foreign_parent_country: string | null;
  selected_territory_source: string | null;
  selected_uat_siruta_code: string | null;
  selected_uat_code: string | null;
  selected_county_name: string | null;
  selected_locality_name: string | null;
  territory_match_confidence: string | null; // 'safe' | 'unmatched' etc.
  cui_quality: string;
  updated_at: Tstz;
}

export interface CompaniesFiscalStatusTable {
  cui: string;
  registered_name: string | null;
  normalized_registered_name: string | null;
  is_vat_payer: boolean | null;
  is_inactive: boolean | null; // → declaredFiscallyInactive
  is_split_vat: boolean | null;
  status_date: string | null;
  main_caen_rev: string | null;
  main_caen_code: string | null;
  retrieved_at: Tstz | null;
  snapshot_at: Tstz | null;
  updated_at: Tstz;
}

export interface CompaniesFinancialsTable {
  cui: string;
  year: number; // integer
  statement_profile_hash: string | null;
  metric_rule_version: string;
  turnover: string | null; // numeric → string
  net_profit: string | null;
  net_loss: string | null;
  net_result: string | null;
  employees: string | null; // bigint → string (overflow-safe)
  total_revenue: string | null;
  total_expenses: string | null;
  gross_profit: string | null;
  gross_loss: string | null;
  receivables: string | null;
  current_assets: string | null;
  fixed_assets: string | null;
  cash_and_bank: string | null;
  prepaid_expenses: string | null;
  deferred_income: string | null;
  subscribed_capital: string | null;
  inventories: string | null;
  debts: string | null;
  provisions: string | null;
  total_equity: string | null;
  patrimony_regie: string | null;
  source_indicator_count: number;
  selected_metric_count: number;
  metric_issue_count: number;
  quality_flag_count: number;
  derived_at: Tstz;
}

export interface CompaniesCaenActivitiesTable {
  cui: string;
  source: string;
  caen_rev: string;
  caen_code: string;
  relation: string;
  authorization_type: string | null;
}

export interface CompaniesStatusFlagsTable {
  cui: string;
  status_code: string;
  status_label: string | null;
}

export interface CompaniesEuBranchesTable {
  cui: string;
  branch_key: string;
  branch_name: string | null;
  country: string | null;
  euid: string | null;
  fiscal_code: string | null;
  updated_at: Tstz | null;
}

/**
 * Declaration-merge the `companies_v2.*` tables onto the kernel `ProdDatabase`.
 * Importing the module barrel (which re-exports this file) pulls the augmentation
 * into scope.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'companies_v2.registrations': CompaniesRegistrationsTable;
    'companies_v2.fiscal_status': CompaniesFiscalStatusTable;
    'companies_v2.financials': CompaniesFinancialsTable;
    'companies_v2.caen_profile': CompaniesCaenActivitiesTable;
    'companies_v2.status_flags': CompaniesStatusFlagsTable;
    'companies_v2.eu_branches': CompaniesEuBranchesTable;
    'companies_v2.registration_identifiers': {
      scheme: string;
      value: string;
      cui: string;
      is_current: boolean;
    };
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
