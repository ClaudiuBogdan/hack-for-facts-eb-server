/**
 * Shared Kernel — `ProdDatabase` Kysely typing (foundation §3).
 *
 * One Kysely instance typed over `transparenta_prod`, schema-per-domain. The
 * kernel types the schemas it owns (`core`, `flows`, `search`); per-source
 * modules augment `ProdDatabase` with their own schema interfaces via
 * declaration merging. Table keys are the **schema-qualified** name exactly as
 * the live snapshot (`'core.organizations'`), so repos read the live schema
 * directly.
 *
 * Scalars (§14.1): `org_id`/`flow_id` are bigint → typed `string` here because
 * the pool registers an int8 parser that returns strings (no precision loss).
 * `numeric` is likewise returned as `string` (the pg default), preserving money
 * precision. `attrs` is jsonb → `Record<string, unknown>` on read.
 */

import type { ColumnType, Generated } from 'kysely';

/** jsonb column: object on read, string on write (server is read-only). */
type Jsonb = ColumnType<Record<string, unknown>, string, string>;
/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;

// ── core schema ──────────────────────────────────────────────────────────────

export interface CoreOrganizations {
  org_id: Generated<string>; // bigint → string (int8 parser)
  cui: string | null;
  registration_number: string | null;
  kind: string;
  name: string;
  normalized_name: string | null;
  county_name: string | null;
  locality_name: string | null;
  siruta_code: number | null; // integer in organizations (cast ::text on read)
  first_seen_source: string;
  attrs: Jsonb;
  created_at: Tstz;
  updated_at: Tstz;
}

export interface CoreOrganizationIdentifiers {
  scheme: string;
  value: string;
  org_id: string; // bigint → string
  source: string;
}

export interface CorePublicEntities {
  cui: string;
  name: string;
  address: string | null;
  entity_type: string | null;
  category: string | null;
  tags: Jsonb;
  is_uat: boolean | null;
  territorial_siruta_code: string | null;
  uat_mapping_method: string | null;
  uat_mapping_confidence: string | null;
  uat_unresolved_reason: string | null;
  parent1_cui: string | null;
  parent2_cui: string | null;
  main_creditors: Jsonb;
  default_report_type: string | null;
  issues: Jsonb;
  field_trace: Jsonb;
  updated_at: Tstz;
}

export interface CoreTerritories {
  id: number;
  territorial_siruta_code: string | null;
  siruta_code: string | null;
  county_siruta_code: string | null;
  uat_code: string | null;
  name: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;
  siruta_link_method: string | null;
  siruta_link_confidence: string | null;
  siruta_link_warnings: Jsonb;
  siruta_link_evidence: Jsonb;
  updated_at: Tstz;
}

export interface CoreClassificationCodes {
  system: string;
  code: string;
  label: string | null;
  parent_code: string | null;
}

// ── flows schema ───────────────────────────────────────────────────────────

export interface FlowsMoneyFlows {
  flow_id: Generated<string>; // bigint → string
  flow_type: string;
  source_id: string | null;
  source_ref: string | null;
  payer_cui: string | null;
  payer_name: string | null;
  payer_org_id: string | null; // bigint → string
  payee_cui: string | null;
  payee_name: string | null;
  payee_org_id: string | null; // bigint → string
  amount_ron: string | null; // numeric → string
  amount_eur: string | null; // numeric → string
  currency: string | null;
  flow_date: string | null; // date → 'YYYY-MM-DD'
  flow_year: number | null;
  title: string | null;
  classification_system: string | null;
  classification_code: string | null;
  county_name: string | null;
  attrs: Jsonb;
}

// ── search schema ────────────────────────────────────────────────────────────

export interface SearchDocuments {
  doc_id: string;
  doc_type: string;
  title: string;
  body: string | null;
  cuis: string[]; // text[]
  doc_date: string | null;
  amount_ron: string | null; // numeric → string
  county_name: string | null;
  url: string | null;
  attrs: Jsonb;
  visibility: string; // 'public' | 'restricted' — query-time gate
  rank_boost: number | null; // precomputed importance (sort signal)
  deleted_at: Tstz | null; // tombstone — exclude from serving when set
  updated_at: Tstz;
  embedded_at: Tstz | null;
  indexed_meili_at: Tstz | null;
  indexed_os_at: Tstz | null;
}

/**
 * The kernel-owned slice of `ProdDatabase`. Per-source modules augment this
 * interface via declaration merging (`declare module` against this file) so the
 * single Kysely instance is typed over the full served schema.
 */
export interface ProdDatabase {
  /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3); the dotted form is mandatory */
  'core.organizations': CoreOrganizations;
  'core.organization_identifiers': CoreOrganizationIdentifiers;
  'core.public_entities': CorePublicEntities;
  'core.territories': CoreTerritories;
  'core.classification_codes': CoreClassificationCodes;
  'flows.money_flows': FlowsMoneyFlows;
  'search.documents': SearchDocuments;
  /* eslint-enable @typescript-eslint/naming-convention -- restore for any further members */
}
