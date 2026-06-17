/**
 * Companies module — `ProdDatabase` augmentation (foundation §3, §14
 * module-augmentation pattern).
 *
 * Types the live `companies.*` tables onto the single kernel Kysely instance via
 * TS declaration merging. Table keys are the schema-qualified live names exactly
 * as the prod snapshot (`'companies.registrations'`). The `core.*` tables this
 * module also reads (`organizations`, `organization_identifiers`,
 * `classification_codes`) are already typed by the kernel.
 *
 * Scalars (§14.1): `numeric` columns are `string` (money precision preserved),
 * `bigint` columns (`employees`) are `string` (the pool's int8 parser), `date`
 * columns are `'YYYY-MM-DD'` strings, `timestamptz` are ISO strings. `lines jsonb`
 * is read-only and render-only.
 *
 * `companies.fiscal_status.is_active` is typed here (it physically exists) but is
 * NEVER selected by any repo method — it is dropped from every surface (§13-R1).
 */

import type { ColumnType } from 'kysely';

/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column read-only (server is read-only). */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;

export interface CompaniesRegistrationsTable {
  cui: string;
  cod_inmatriculare: string | null;
  legal_form: string | null;
  registration_date: string | null; // date
  status_code: string | null;
  status_label: string | null;
  raw_address: string | null;
  raw_county: string | null;
  raw_locality: string | null;
  uat_siruta_code: number | null; // integer
  uat_name: string | null;
  county_name: string | null; // SIRUTA-matched (urban-only) — NOT the filter county
  match_confidence: string | null; // 'safe' | 'unmatched'
  snapshot_at: Tstz | null;
}

export interface CompaniesFiscalStatusTable {
  cui: string;
  registered_name: string | null;
  is_active: boolean | null; // DROPPED — never selected (§13-R1)
  is_vat_payer: boolean | null;
  is_inactive: boolean | null; // → declaredFiscallyInactive
  main_caen_code: string | null;
  snapshot_at: Tstz | null;
}

export interface CompaniesFinancialsTable {
  cui: string;
  year: number; // integer
  turnover: string | null; // numeric → string
  net_profit: string | null;
  net_loss: string | null;
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
  lines: Jsonb | null;
}

export interface CompaniesRepresentativesTable {
  cui: string;
  name: string;
  role: string;
}

export interface CompaniesCaenActivitiesTable {
  cui: string;
  caen_rev: string;
  caen_code: string;
  source: string;
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
 * Declaration-merge the `companies.*` tables onto the kernel `ProdDatabase`.
 * Importing the module barrel (which re-exports this file) pulls the augmentation
 * into scope.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'companies.registrations': CompaniesRegistrationsTable;
    'companies.fiscal_status': CompaniesFiscalStatusTable;
    'companies.financials': CompaniesFinancialsTable;
    'companies.representatives': CompaniesRepresentativesTable;
    'companies.caen_activities': CompaniesCaenActivitiesTable;
    'companies.status_flags': CompaniesStatusFlagsTable;
    'companies.eu_branches': CompaniesEuBranchesTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
