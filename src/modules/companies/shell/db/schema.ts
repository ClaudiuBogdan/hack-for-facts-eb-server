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
  /** 'anaf' (FY2019+) | 'mfp' (FY2008–2018); the publisher seam is CHECK-enforced at 2019. */
  source_system: string;
  /** CHECK admits 'public' | 'personal_moderate' | 'restricted'; every read path allowlists 'public'. */
  privacy_class: string;
  source_indicator_count: number;
  selected_metric_count: number;
  // `metric_issue_count` exists in the table but is ABOLISHED (wrong on ~7.1M MFP
  // rows; scrapper d85663f2, 2026-08-19). Deliberately untyped so it can never be
  // selected; the omission signal lives in `applicable_metric_count`.
  applicable_metric_count: number | null;
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

/** Warn-only (cui, year) statement flags. All 224,657 rows privacy_class='public' (measured 2026-08-25). */
export interface CompaniesFinancialQualityFlagsTable {
  cui: string;
  year: number;
  flag_code: string;
  metric_name: string;
  severity: string; // 'info' | 'review' | 'warning' today; open domain
  numeric_value: string | null; // numeric → string
  threshold_value: string | null;
  privacy_class: string;
  /** Read via raw max(created_at) in the coverage aggregate — typed so a rename fails typecheck-adjacent review, not runtime. */
  created_at: Tstz;
}

/** One row per (cui, capture). ~8.38M rows over two loaded captures; 244,408 restricted (read paths allowlist public). */
export interface CompaniesRegistrationHistoryTable {
  cui: string;
  legal_name: string;
  normalized_legal_name: string;
  legal_form: string | null;
  // `raw_status` exists but is 100% NULL (8,378,866/8,378,866, measured
  // 2026-08-25) — deliberately untyped so a status diff that can never fire
  // cannot be built against it.
  raw_county: string | null;
  raw_locality: string | null;
  source_snapshot_id: string;
  privacy_class: string;
}

/**
 * Capture dimension (applied 2026-08-25; populated by a guarded upsert, no
 * scheduled lane — current-as-of-today, not self-maintaining).
 * `retrieved_at` is DELIBERATELY untyped: freshness must never be served from
 * retrieval — `source_published_at` is what "as of" means to a user, NULL means
 * UNKNOWN and must not be coalesced (captures differ by up to 129 days).
 */
export interface CompaniesSourceSnapshotsTable {
  source_snapshot_id: string;
  source_published_at: string | null; // date
  privacy_class: string;
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
    'companies_v2.financial_quality_flags': CompaniesFinancialQualityFlagsTable;
    'companies_v2.registration_history': CompaniesRegistrationHistoryTable;
    'companies_v2.source_snapshots': CompaniesSourceSnapshotsTable;
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
