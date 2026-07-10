/**
 * PNRR module — filter specs (plan §7). One `CollectionFilterSpec` per paged
 * collection; the kernel derives TypeBox / GraphQL input / SQL conditions +
 * the stable `fhash` from these. The module only DECLARES specs.
 *
 * Column `alias` MUST match the table alias the repo uses in its FROM clause
 * (`p` payments, `c` commitments, `a` acquisitions, `ct` contractors, `e`
 * entities, `m` measures). Money columns cast `::text` so comparisons never go
 * through a float (numeric range filters are deferred — see DESIGN.md — until the
 * kernel has a decimal filter op; only indexed/identity/date/enum filters here).
 *
 * Index-bound rule (§3/§7): only the columns with a live index are valid driving
 * predicates; the rest are residual filters the repo applies after a driving
 * predicate. The repo enforces "at least one driving predicate" per collection.
 */

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/** C1–C16 (the 16 live components). */
export const PNRR_COMPONENT_CODES: readonly string[] = Array.from(
  { length: 16 },
  (_, i) => `C${String(i + 1)}`
);

const PNRR_HUBS = ['public_entities', 'companies'] as const;
const PNRR_ROLE_FLAGS = ['beneficiary', 'applicant', 'winner', 'subcontractor'] as const;
const PNRR_CONTRACTOR_ROLE_VALUES = [
  'winning_bidder',
  'foreign_winning_bidder',
  'subcontractor',
  'association_leader',
  'third_party_support',
] as const;
const PNRR_COMMITMENT_STATUS_VALUES = [
  'ÎN IMPLEMENTARE',
  'ÎN IMPLEMENTARE (sub 30%)',
  'FINALIZAT',
] as const;
const PNRR_ANNOUNCEMENT_STATUS_VALUES = ['ATRIBUIT', 'PUBLICAT'] as const;
const PNRR_PROCEDURE_TYPE_VALUES = ['ATRIBUIT', 'PUBLICAT'] as const;

export const pnrrEntitiesFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_entities',
  fields: [
    { name: 'cui', type: 'string', ops: ['eq', 'in'], column: { alias: 'e', column: 'cui' } },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'e', column: 'resolved_name' },
      description: 'Substring match on the resolved entity name.',
    },
    {
      name: 'role',
      type: 'enum',
      ops: ['eq'],
      enumValues: [...PNRR_ROLE_FLAGS],
      column: { alias: 'e', column: 'role_virtual' },
      description:
        'beneficiary | applicant | winner | subcontractor (resolved against is_* flags by the repo).',
    },
    {
      name: 'hub',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PNRR_HUBS],
      column: { alias: 'e', column: 'hub_virtual' },
      description: 'Entity links to this identity registry (EXISTS in entity_registry_links).',
    },
    {
      name: 'caenCode',
      type: 'string',
      ops: ['eq', 'prefix'],
      column: { alias: 'e', column: 'caen_code' },
    },
    {
      name: 'isActive',
      type: 'bool',
      ops: ['eq', 'isNull'],
      column: { alias: 'e', column: 'is_active' },
    },
    {
      name: 'isVatPayer',
      type: 'bool',
      ops: ['eq', 'isNull'],
      column: { alias: 'e', column: 'is_vat_payer' },
    },
    {
      name: 'hasNoHub',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'e', column: 'has_no_hub_virtual' },
      description: 'true → entity has no identity-hub link (coverage residual).',
    },
  ],
  sort: { default: 'cui', allowed: ['cui', 'name', 'total_payments'] },
};

export const pnrrPaymentsFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_payments',
  fields: [
    {
      name: 'beneficiaryCui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'p', column: 'beneficiary_cui' },
    },
    {
      name: 'componentCode',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: PNRR_COMPONENT_CODES,
      column: { alias: 'p', column: 'component_code' },
    },
    {
      name: 'measureFenix',
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
      column: { alias: 'p', column: 'measure_fenix' },
      description:
        'isNull=true returns payments whose measure could not be resolved (data-quality probe).',
    },
    {
      name: 'paymentDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'p', column: 'payment_date' },
    },
    {
      name: 'year',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'p', column: 'year_virtual' },
      description: 'Calendar year; compiled to a payment_date range on the indexed column.',
    },
    {
      name: 'countySiruta',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'p', column: 'county_siruta' },
      description: 'Residual filter (no index) — needs a driving predicate.',
    },
    {
      name: 'caenDivision',
      type: 'string',
      ops: ['eq', 'prefix'],
      column: { alias: 'p', column: 'caen_division' },
      description: 'Residual filter (no index).',
    },
    {
      name: 'financingSource',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'p', column: 'financing_source' },
      description: 'Residual filter (no index).',
    },
  ],
  sort: { default: 'payment_date', allowed: ['payment_date', 'amount_lei'] },
};

export const pnrrCommitmentsFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_commitments',
  fields: [
    {
      name: 'beneficiaryCui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'beneficiary_cui' },
    },
    {
      name: 'contractNumber',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'c', column: 'contract_number' },
    },
    {
      name: 'componentCode',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: PNRR_COMPONENT_CODES,
      column: { alias: 'c', column: 'component_code' },
    },
    {
      name: 'measureCode',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'c', column: 'measure_code' },
      description: 'Residual filter.',
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PNRR_COMMITMENT_STATUS_VALUES],
      column: { alias: 'c', column: 'status' },
      description: 'Residual filter. Live values are Romanian free-text.',
    },
    {
      name: 'countySiruta',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'county_siruta' },
      description: 'Residual filter.',
    },
    {
      name: 'commitmentDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'c', column: 'commitment_date' },
      description: 'Residual filter.',
    },
  ],
  sort: { default: 'commitment_date', allowed: ['commitment_date', 'total_value'] },
};

export const pnrrAcquisitionsFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_acquisitions',
  fields: [
    {
      name: 'beneficiaryCui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'a', column: 'beneficiary_cui' },
      description: 'The PNRR beneficiary running the procurement (== announcement applicant).',
    },
    {
      name: 'signedAt',
      type: 'date',
      ops: ['between'],
      column: { alias: 'a', column: 'signed_at' },
    },
    {
      name: 'announcementKey',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'a', column: 'announcement_key' },
    },
    {
      name: 'componentCode',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: PNRR_COMPONENT_CODES,
      column: { alias: 'an', column: 'component_code' },
      description: 'On the joined announcement (acquisitions carry no component).',
    },
    {
      name: 'procedureType',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PNRR_PROCEDURE_TYPE_VALUES],
      column: { alias: 'a', column: 'procedure_type' },
      description: 'Residual filter.',
    },
    {
      name: 'frameworkAgreement',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'a', column: 'framework_agreement' },
      description: 'Residual filter.',
    },
    {
      name: 'hasSubcontractor',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'a', column: 'has_subcontractor' },
      description: 'Residual filter.',
    },
    {
      name: 'hasAssociationLeader',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'a', column: 'has_association_leader' },
      description: 'Residual filter.',
    },
    {
      name: 'hasThirdPartySupport',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'a', column: 'has_third_party_support' },
      description: 'Residual filter.',
    },
  ],
  sort: { default: 'signed_at', allowed: ['signed_at', 'full_contract_value'] },
};

export const pnrrContractorsFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_contractors',
  fields: [
    {
      name: 'contractorCui',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'ct', column: 'contractor_cui' },
    },
    {
      name: 'acquisitionKey',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'ct', column: 'acquisition_key' },
    },
    {
      name: 'role',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: [...PNRR_CONTRACTOR_ROLE_VALUES],
      column: { alias: 'ct', column: 'role' },
    },
    {
      name: 'contractorCountry',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'ct', column: 'contractor_country' },
      description: 'Residual filter (foreign contractors).',
    },
    {
      name: 'validationStatus',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'ct', column: 'validation_status' },
      description: 'Residual filter.',
    },
    {
      name: 'confidence',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'ct', column: 'confidence' },
      description: 'Residual filter.',
    },
  ],
  sort: { default: 'contract_value', allowed: ['contract_value'] },
};

export const pnrrMeasuresFilterSpec: CollectionFilterSpec = {
  collection: 'pnrr_measures',
  fields: [
    {
      name: 'componentCode',
      type: 'enum',
      ops: ['eq', 'in'],
      enumValues: PNRR_COMPONENT_CODES,
      column: { alias: 'm', column: 'component_code' },
    },
    {
      name: 'measureType',
      type: 'enum',
      ops: ['eq'],
      enumValues: ['investment', 'reform'],
      column: { alias: 'm', column: 'measure_type' },
    },
    {
      name: 'measureNumber',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'm', column: 'measure_number' },
    },
  ],
  sort: { default: 'fenix_reference', allowed: ['fenix_reference'] },
};

/** Status / procedure enum value sets exported for surface tests + announcement filters. */
export const PNRR_COMMITMENT_STATUSES = PNRR_COMMITMENT_STATUS_VALUES;
export const PNRR_ANNOUNCEMENT_STATUSES = PNRR_ANNOUNCEMENT_STATUS_VALUES;

export const PNRR_FILTER_SPECS = {
  entities: pnrrEntitiesFilterSpec,
  payments: pnrrPaymentsFilterSpec,
  commitments: pnrrCommitmentsFilterSpec,
  acquisitions: pnrrAcquisitionsFilterSpec,
  contractors: pnrrContractorsFilterSpec,
  measures: pnrrMeasuresFilterSpec,
} as const;
