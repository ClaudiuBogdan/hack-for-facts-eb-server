/**
 * Companies module — filter spec (plan §7). One `CollectionFilterSpec`; the kernel
 * derives the GraphQL input + SQL conditions + the stable `fhash` from it. The
 * module only DECLARES the spec.
 *
 * Aliases MUST match the repo FROM clause:
 *   `o`  core.organizations
 *   `r`  companies_v2.registrations
 *   `f`  companies_v2.fiscal_status
 *   `ca` companies_v2.caen_profile (EXISTS subquery — virtual, repo-intercepted)
 *
 * Two fields are VIRTUAL (no direct kernel-composable column) and are intercepted
 * by the repo (like the pnrr `year`/`role` precedent), so they surface in GraphQL
 * + the fhash but the kernel composer never compiles them:
 *   - `caenCode`  → `EXISTS (companies_v2.caen_profile WHERE cui=o.cui AND caen_code …)`
 *   - `county`    → a diacritic-folded match (NO `unaccent()` — not installed, §13-R4)
 *   - `hasFinancials` → `EXISTS (companies_v2.financials …)` (isNull-style presence)
 *
 * Index-bound note: `county`/`legalForm`/`vatPayer`/`declaredFiscallyInactive`/
 * `registrationDate*`/`mainCaenCode` have no index; the list `total` is bounded
 * (cap 10,000) so a residual filter scan stays cheap, but a `groupBy=county`
 * aggregate is gated to require a selective predicate.
 */

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/** Repo-intercepted virtual filter fields (kernel composer must skip these). */
export const COMPANY_VIRTUAL_FIELDS = ['caenCode', 'county', 'hasFinancials'] as const;

/** Driving predicates that bound a `groupBy=county` aggregate. */
export const COMPANY_AGGREGATE_DRIVING_FIELDS = ['county', 'status', 'caenCode'] as const;

export const companiesFilterSpec: CollectionFilterSpec = {
  collection: 'companies',
  fields: [
    {
      name: 'cui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'o', column: 'cui' },
      array: true,
      exclude: true,
      description: 'Normalized CUI (1–13 digits). Index seek on organizations_cui_uq.',
    },
    {
      name: 'county',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'r', column: 'selected_county_name' },
      array: true,
      exclude: true,
      description:
        'Display county from v2 selected_county_name. Diacritic-folded in TS/SQL (no unaccent).',
    },
    {
      name: 'status',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'r', column: 'onrc_lifecycle_status_code' },
      array: true,
      exclude: true,
      description:
        'ONRC lifecycle status code (e.g. 1084 radiată, 1048 funcțiune). registrations_status_idx.',
    },
    {
      name: 'caenCode',
      type: 'string',
      ops: ['eq', 'in', 'prefix'],
      column: { alias: 'ca', column: 'caen_code' },
      array: true,
      exclude: true,
      description:
        'CAEN code (EXISTS over companies_v2.caen_profile/caen_profile_code_idx). prefix → CAEN division (sargable LIKE).',
    },
    {
      name: 'legalForm',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'r', column: 'legal_form' },
      array: true,
      exclude: true,
      description: 'SRL/SA/PFA/… (no index; residual).',
    },
    {
      name: 'vatPayer',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'f', column: 'is_vat_payer' },
      exclude: true,
      description: 'ANAF VAT-payer flag (joins fiscal_status; no index).',
    },
    {
      name: 'declaredFiscallyInactive',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'f', column: 'is_inactive' },
      exclude: true,
      description: 'ANAF declared-fiscally-inactive-list flag. NOT operating-inactive (§13-R1).',
    },
    {
      name: 'mainCaenCode',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'f', column: 'main_caen_code' },
      array: true,
      exclude: true,
      description: 'ANAF main CAEN (fiscal_status; no index; residual).',
    },
    {
      name: 'registrationDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'r', column: 'registration_date' },
      description: 'ONRC registration date range (xFrom/xTo). 256,142 NULL after 2024-09-03.',
    },
    {
      name: 'registrationDatePresent',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'r', column: 'registration_date' },
      description:
        'Mandatory isNull presence (§14.2) — isNull:true returns the 256,142 NULL-date rows.',
    },
    {
      name: 'hasFinancials',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'r', column: 'cui' },
      description:
        'EXISTS over companies_v2.financials (coverage probe; repo-intercepted virtual).',
    },
  ],
  sort: { default: 'name', allowed: ['name', 'registrationDate', 'cui'] },
};

/** Lifecycle status nomenclature (validated; mojibake-repaired labels). */
export const COMPANY_STATUS_NOMENCLATURE: Readonly<Record<string, string>> = {
  '1084': 'radiată',
  '1048': 'funcțiune',
  '1074': 'întrerupere temporară de activitate',
  '1049': 'dizolvare',
  '1052': 'lichidare',
  '1070': 'faliment',
  '1107': 'insolvență',
  '1057': 'reorganizare judiciară',
};

export const COMPANIES_FILTER_SPECS = {
  companies: companiesFilterSpec,
} as const;
