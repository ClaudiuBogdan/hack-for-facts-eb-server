/**
 * PNRR module — `ProdDatabase` augmentation (foundation §3, module-augmentation
 * pattern §14).
 *
 * Types the live `pnrr.*` tables onto the single kernel Kysely instance via TS
 * declaration merging. Table keys are the schema-qualified live names exactly as
 * the prod snapshot (`'pnrr.payments'`), so the repo reads the schema directly.
 *
 * Scalars (§14.1): `numeric` columns are `string` (pg numeric default — money
 * precision preserved). `bigint` columns are `string` (the pool's int8 parser).
 * `date` columns are `'YYYY-MM-DD'` strings; `timestamptz` are ISO strings.
 * `attrs jsonb` is read-only and NEVER projected wholesale (PII defense, §8.2).
 *
 * Only the columns the module reads are typed precisely; provenance / PII columns
 * exist in the DB but are deliberately omitted from every projection (the repo
 * never selects them). They are present here only where a method must reference
 * them internally (e.g. `retrieved_at` for freshness).
 */

import type { ColumnType, Generated } from 'kysely';

/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column: object on read; server is read-only so write types are unused. */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;

// ── identity spine ───────────────────────────────────────────────────────────

export interface PnrrEntitiesTable {
  cui: string;
  resolved_name: string | null;
  name_source: string | null;
  caen_code: string | null;
  is_active: boolean | null;
  is_vat_payer: boolean | null;
  is_beneficiary: boolean | null;
  is_applicant: boolean | null;
  is_winner: boolean | null;
  is_subcontractor: boolean | null;
  first_seen_source: string | null;
  built_at: Tstz | null;
  attrs: Jsonb;
  created_at: Tstz;
  updated_at: Tstz;
}

export interface PnrrEntityRegistryLinksTable {
  link_id: Generated<string>; // bigint → string
  cui: string;
  registry: string; // 'public_entities' | 'companies'
  registry_cui: string | null;
  link_confidence: number | null; // real
  built_at: Tstz | null;
  attrs: Jsonb;
}

// ── ledger ───────────────────────────────────────────────────────────────────

export interface PnrrPaymentsTable {
  payment_key: string;
  beneficiary_cui: string | null;
  beneficiary_name: string | null;
  is_personal_recipient: boolean | null; // INTERNAL gate signal — never projected
  component_code: string | null;
  measure_fenix: string | null;
  measure_raw: string | null;
  submeasure_raw: string | null;
  amount_lei: string | null; // numeric → string
  amount_eur: string | null; // numeric → string
  payment_direction: string | null; // 'disbursement' | 'reversal' | 'zero_adjustment'
  payment_date: string | null; // date
  county_name: string | null;
  county_siruta: string | null;
  locality_name: string | null;
  locality_siruta: string | null;
  caen_division: string | null;
  financing_source: string | null;
  source_system: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

export interface PnrrCommitmentsTable {
  commitment_key: string;
  beneficiary_cui: string | null;
  beneficiary_name: string | null;
  id_angajament: string | null;
  contract_number: string | null;
  component_code: string | null;
  measure_code: string | null;
  total_value: string | null; // numeric → string
  eu_value: string | null;
  national_public_value: string | null;
  vat_value: string | null;
  ineligible_value: string | null;
  financial_progress: string | null; // numeric → string (Float at the edge)
  physical_progress: string | null;
  commitment_date: string | null; // date
  end_date: string | null; // date
  status: string | null;
  county_name: string | null;
  county_siruta: string | null;
  source_system: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

export interface PnrrCommitmentSnapshotsTable {
  snapshot_id: string;
  source_record_id: string;
  snapshot_date: string; // date
  beneficiary_cui: string | null;
  contract_number: string | null;
  commitment_key: string | null; // NULLABLE soft link
  link_confidence: number | null; // real
  financial_progress: string | null; // numeric → string
  physical_progress: string | null;
  stage: string | null;
  received_eur: string | null; // numeric → string
  paid_eur: string | null;
  allocated_eur: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

export interface PnrrProgramIndicatorsTable {
  snapshot_id: string;
  snapshot_date: string; // date
  nr_projects: number | null; // integer
  allocated_eur: string | null; // numeric → string
  received_eur: string | null;
  paid_eur: string | null;
  attrs: Jsonb;
}

// ── procurement graph ────────────────────────────────────────────────────────

export interface PnrrAnnouncementsTable {
  announcement_key: string;
  platform_project_id: string | null;
  applicant_cui: string | null;
  applicant_name: string | null;
  project_name: string | null;
  call_name: string | null;
  component_code: string | null;
  budget_value: string | null; // numeric → string
  status: string | null;
  is_personal_recipient: boolean | null; // INTERNAL gate signal — never projected
  county_siruta: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

export interface PnrrAcquisitionsTable {
  acquisition_key: string;
  announcement_key: string | null;
  beneficiary_cui: string | null; // the PNRR beneficiary running the procurement (== announcement applicant)
  beneficiary_name: string | null;
  procedure_type: string | null;
  signed_at: string | null; // date
  full_contract_value: string | null; // numeric → string
  currency: string | null;
  award_criterion: string | null;
  framework_agreement: boolean | null;
  has_association_leader: boolean | null;
  has_third_party_support: boolean | null;
  has_subcontractor: boolean | null;
  source_system: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

export interface PnrrLotsTable {
  lot_key: string;
  announcement_key: string | null;
  lot_number: string | null;
  description: string | null;
  attrs: Jsonb;
}

export interface PnrrContractorsTable {
  contractor_key: string;
  acquisition_key: string | null;
  role: string;
  contractor_cui: string | null;
  contractor_name: string | null;
  contractor_country: string | null;
  contract_value: string | null; // numeric → string
  currency: string | null;
  confidence: string | null;
  validation_status: string | null;
  retrieved_at: Tstz | null;
  attrs: Jsonb;
}

// ── taxonomy / dimensions ─────────────────────────────────────────────────────

export interface PnrrComponentsTable {
  component_code: string;
  component_name: string | null;
  pillar: string | null;
  attrs: Jsonb;
}

export interface PnrrMeasuresTable {
  fenix_reference: string;
  component_code: string | null;
  measure_type: string | null; // 'investment' | 'reform'
  measure_number: number | null; // integer
  measure_name: string | null;
  attrs: Jsonb;
}

/**
 * Declaration-merge the `pnrr.*` tables onto the kernel `ProdDatabase` so the one
 * Kysely instance is typed over the served schema. Importing this module's barrel
 * (which re-exports this file) pulls the augmentation into scope.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'pnrr.entities': PnrrEntitiesTable;
    'pnrr.entity_registry_links': PnrrEntityRegistryLinksTable;
    'pnrr.payments': PnrrPaymentsTable;
    'pnrr.commitments': PnrrCommitmentsTable;
    'pnrr.commitment_snapshots': PnrrCommitmentSnapshotsTable;
    'pnrr.program_indicators': PnrrProgramIndicatorsTable;
    'pnrr.announcements': PnrrAnnouncementsTable;
    'pnrr.acquisitions': PnrrAcquisitionsTable;
    'pnrr.lots': PnrrLotsTable;
    'pnrr.contractors': PnrrContractorsTable;
    'pnrr.components': PnrrComponentsTable;
    'pnrr.measures': PnrrMeasuresTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
