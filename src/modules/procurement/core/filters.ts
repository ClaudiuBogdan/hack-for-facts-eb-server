/**
 * Procurement module — filter specs (plan §7; priority area). One
 * `CollectionFilterSpec` per base-table collection; the kernel derives TypeBox
 * (unused — no REST), the GraphQL `input`, and the SQL conditions + stable `fhash`
 * from these. The module only DECLARES specs (no DSL).
 *
 * Column `alias` MUST match the repo FROM alias: `p` procedures, `c` contracts,
 * `d` direct_acquisitions, `m` contract_modifications. Money/value ranges use the
 * kernel `money` type (precision-safe `::numeric`). `cpvDivision[]` is NOT in these
 * specs — it compiles to an index-safe range over `cpv_code` and is intercepted by
 * the repo (a non-indexed `substring(cpv_code,1,2)` would skip the *_cpv_code_idx;
 * §7.1/§7.3 I7). `cpvCodePrefix` is kernel-compiled (`ILIKE 'p%'`); under this DB's
 * **C collation** (verified live) the planner rewrites that to the index range
 * `cpv_code >= 'p' AND cpv_code < successor(p)` on the plain `*_cpv_code_idx` btree,
 * so it is index-safe here (the reviewers' ILIKE-skips-index concern does not apply
 * under C collation). The DA list `requiresSelective` — a runtime check in the repo
 * (`assertDaSelective`) rejects an empty / non-selective / over-wide-window filter
 * on all surfaces (§3a(1)/§7.3 I5).
 */

import {
  CONTRACT_STATUSES,
  DA_SOURCE_SYSTEMS,
  DA_STATUSES,
  PROCEDURE_STATUSES,
} from './constants.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

// ── procedures (526k) ──────────────────────────────────────────────────────────

export const procedureFilterSpec: CollectionFilterSpec = {
  collection: 'procurement_procedure',
  fields: [
    {
      name: 'authorityCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'p', column: 'authority_cui' },
    },
    {
      name: 'cpvCode',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'p', column: 'cpv_code' },
    },
    {
      name: 'cpvCodePrefix',
      type: 'string',
      ops: ['prefix'],
      column: { alias: 'p', column: 'cpv_code' },
      description: 'Left-anchored CPV prefix (uses procedures_cpv_code_idx).',
    },
    // cpvDivision[] is repo-intercepted → index-safe range (virtual; not compiled).
    {
      name: 'cpvDivision',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      virtual: true,
      column: { alias: 'p', column: 'cpv_code' },
      description: '2-digit CPV division (index-safe range on cpv_code, not substring).',
    },
    {
      name: 'procedureType',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'p', column: 'procedure_type' },
    },
    {
      name: 'contractKind',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'p', column: 'contract_kind' },
    },
    {
      name: 'noticeKind',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'p', column: 'notice_kind' },
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      array: true,
      enumValues: PROCEDURE_STATUSES,
      column: { alias: 'p', column: 'status' },
    },
    { name: 'noticeNo', type: 'string', ops: ['eq'], column: { alias: 'p', column: 'notice_no' } },
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      virtual: true,
      column: { alias: 'p', column: 'publication_date' },
      description: 'Filter on publication_date year (repo expands to a date range on the index).',
    },
    {
      name: 'publicationDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'p', column: 'publication_date' },
    },
    {
      name: 'minValueRon',
      type: 'money',
      ops: ['gte'],
      column: { alias: 'p', column: 'estimated_value_ron' },
      description: 'Lower bound on estimated_value_ron.',
    },
    {
      name: 'maxValueRon',
      type: 'money',
      ops: ['lte'],
      column: { alias: 'p', column: 'estimated_value_ron' },
      description: 'Upper bound on estimated_value_ron.',
    },
    // buyer territory (needs the core join)
    {
      name: 'countyCode',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'county_code' },
      description: 'Buyer county (via core join).',
    },
    {
      name: 'region',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'region' },
      description: 'Buyer region (via core join).',
    },
  ],
  sort: { default: 'publication_date', allowed: ['publication_date', 'estimated_value_ron'] },
};

// ── contracts (1.92M) ──────────────────────────────────────────────────────────

export const contractFilterSpec: CollectionFilterSpec = {
  collection: 'procurement_contract_row',
  fields: [
    {
      name: 'authorityCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'c', column: 'authority_cui' },
    },
    {
      name: 'supplierCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'c', column: 'supplier_cui' },
    },
    {
      name: 'cpvCode',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'c', column: 'cpv_code' },
    },
    {
      name: 'cpvCodePrefix',
      type: 'string',
      ops: ['prefix'],
      column: { alias: 'c', column: 'cpv_code' },
      description: 'Left-anchored CPV prefix (uses contracts_cpv_code_idx).',
    },
    {
      name: 'cpvDivision',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      virtual: true,
      column: { alias: 'c', column: 'cpv_code' },
      description: '2-digit CPV division (index-safe range on cpv_code).',
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      array: true,
      enumValues: CONTRACT_STATUSES,
      column: { alias: 'c', column: 'status' },
    },
    { name: 'noticeNo', type: 'string', ops: ['eq'], column: { alias: 'c', column: 'notice_no' } },
    {
      name: 'procedureId',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'c', column: 'procedure_id' },
      description: 'isNull surfaces procedures-without-linkage (PC-10).',
    },
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      virtual: true,
      column: { alias: 'c', column: 'contract_date' },
      description: 'Filter on contract_date year (repo expands to a date range).',
    },
    {
      name: 'contractDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'c', column: 'contract_date' },
    },
    {
      name: 'minValueRon',
      type: 'money',
      ops: ['gte'],
      column: { alias: 'c', column: 'value_ron' },
    },
    {
      name: 'maxValueRon',
      type: 'money',
      ops: ['lte'],
      column: { alias: 'c', column: 'value_ron' },
    },
    {
      name: 'includeDuplicates',
      type: 'bool',
      ops: ['eq'],
      virtual: true,
      column: { alias: 'c', column: 'is_canonical' },
      description:
        'Default false → forces is_canonical=true; true also returns non-canonical rows.',
    },
    {
      name: 'countyCode',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'county_code' },
      description: 'Buyer county (via core join).',
    },
    {
      name: 'region',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 't', column: 'region' },
      description: 'Buyer region (via core join).',
    },
  ],
  sort: { default: 'contract_date', allowed: ['contract_date', 'value_ron'] },
};

// ── direct_acquisitions (20.2M — HIGH VOLUME, selective filter required) ────────

export const daFilterSpec: CollectionFilterSpec = {
  collection: 'procurement_direct_acquisition',
  fields: [
    {
      name: 'authorityCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'd', column: 'authority_cui' },
    },
    {
      name: 'supplierCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'd', column: 'supplier_cui' },
    },
    {
      name: 'cpvCode',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'd', column: 'cpv_code' },
    },
    {
      name: 'cpvCodePrefix',
      type: 'string',
      ops: ['prefix'],
      column: { alias: 'd', column: 'cpv_code' },
      description: 'Left-anchored CPV prefix (uses das_cpv_code_idx).',
    },
    {
      name: 'cpvDivision',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      virtual: true,
      column: { alias: 'd', column: 'cpv_code' },
      description: '2-digit CPV division (index-safe range on cpv_code).',
    },
    {
      name: 'uniqueCode',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'd', column: 'unique_code' },
    },
    {
      name: 'sourceSystem',
      type: 'enum',
      ops: ['eq', 'in'],
      array: true,
      enumValues: DA_SOURCE_SYSTEMS,
      column: { alias: 'd', column: 'source_system' },
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      array: true,
      enumValues: DA_STATUSES,
      column: { alias: 'd', column: 'status' },
    },
    // NOTE: elicitatie_da publication_date is 100% null → the date filter binds to
    // finalization_date (the indexed, populated column).
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      virtual: true,
      column: { alias: 'd', column: 'finalization_date' },
      description: 'Filter on finalization_date year (publication_date is null on elicitatie_da).',
    },
    {
      name: 'finalizationDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'd', column: 'finalization_date' },
    },
    {
      name: 'minValueRon',
      type: 'money',
      ops: ['gte'],
      column: { alias: 'd', column: 'value_ron' },
    },
    {
      name: 'maxValueRon',
      type: 'money',
      ops: ['lte'],
      column: { alias: 'd', column: 'value_ron' },
    },
    {
      name: 'includeDuplicates',
      type: 'bool',
      ops: ['eq'],
      virtual: true,
      column: { alias: 'd', column: 'is_canonical' },
      description: 'Default false → forces is_canonical=true.',
    },
  ],
  sort: { default: 'finalization_date', allowed: ['finalization_date', 'value_ron'] },
};

// ── modifications (53k) ────────────────────────────────────────────────────────

export const modificationFilterSpec: CollectionFilterSpec = {
  collection: 'procurement_modification',
  fields: [
    {
      name: 'contractId',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'm', column: 'contract_id' },
      description: 'isNull surfaces modifications without a linked contract (PC-10).',
    },
    {
      name: 'authorityCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'm', column: 'authority_cui' },
    },
    {
      name: 'supplierCui',
      type: 'string',
      ops: ['in', 'eq'],
      array: true,
      column: { alias: 'm', column: 'supplier_cui' },
    },
    {
      name: 'contractNo',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'm', column: 'contract_no' },
    },
    { name: 'noticeNo', type: 'string', ops: ['eq'], column: { alias: 'm', column: 'notice_no' } },
    {
      name: 'linkMethod',
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
      array: true,
      column: { alias: 'm', column: 'link_method' },
    },
    {
      name: 'modificationType',
      type: 'string',
      ops: ['eq', 'in'],
      array: true,
      column: { alias: 'm', column: 'modification_type' },
    },
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'in', 'between'],
      column: { alias: 'm', column: 'year' },
    },
    {
      name: 'modificationDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'm', column: 'modification_date' },
    },
  ],
  sort: { default: 'modification_date', allowed: ['modification_date'] },
};

// ── repo-intercepted fields (NOT compiled by the kernel composer) ──────────────
// These appear in the spec (so they surface in GraphQL/TypeBox + the fhash) but the
// repo compiles them itself: cpvDivision → index-safe range, year → date range,
// includeDuplicates → is_canonical predicate selection.

export const PROCEDURE_VIRTUAL_FIELDS = ['cpvDivision', 'year'] as const;
export const CONTRACT_VIRTUAL_FIELDS = ['cpvDivision', 'year', 'includeDuplicates'] as const;
export const DA_VIRTUAL_FIELDS = ['cpvDivision', 'year', 'includeDuplicates'] as const;
export const MODIFICATION_VIRTUAL_FIELDS = [] as const;

/**
 * Field names that count as a "selective" DA filter (§7.3 / §3a(1)). `cpvCode`
 * (exact) and `cpvDivision` (2-digit range) are selective; `cpvCodePrefix` is
 * deliberately EXCLUDED — a 1–2 char prefix matches millions of rows, so prefix
 * selectivity is data-dependent and not a safe driving predicate on its own (a
 * caller wanting prefix scope must also pass an entity or date window). `year` /
 * `finalizationDate` are selective only when their window is bounded — the runtime
 * `assertDaSelective` enforces the day-span cap, not mere presence.
 */
export const DA_SELECTIVE_FIELDS = [
  'authorityCui',
  'supplierCui',
  'cpvCode',
  'cpvDivision',
  'uniqueCode',
  'year',
  'finalizationDate',
] as const;

/**
 * Drop the repo-intercepted fields so the kernel composer never compiles them
 * (the kernel applies `spec.default` for any declared field absent from input, and
 * a virtual field has no real column / needs special SQL — the budget precedent).
 *
 * DISCIPLINE (Codex/GLM review): the *KernelSpec is used ONLY by
 * `toConditionBuilders` for SQL. The cursor `fhash` + cache key MUST be computed
 * from the FULL spec (`fhashFor(<full>Spec, filter)`) so cpvDivision/year/
 * includeDuplicates DO affect the hash — otherwise a cursor minted under one CPV
 * division could be replayed against another. Every repo list method below does
 * exactly this.
 */
const dropFields = (spec: CollectionFilterSpec, drop: readonly string[]): CollectionFilterSpec => {
  const set = new Set(drop);
  return { ...spec, fields: spec.fields.filter((f) => !set.has(f.name)) };
};

/**
 * Reject a filter that specifies BOTH the virtual `year` AND the real date-range
 * field on the same date column — they would silently intersect into an ambiguous
 * combined range (Codex #5 / GLM #11). Surface-level guard used by every repo list.
 */
export const assertNoYearDateConflict = (
  input: Readonly<Record<string, unknown>>,
  dateField: 'publicationDate' | 'contractDate' | 'finalizationDate'
): { ok: true } | { ok: false; field: string } => {
  const hasYear = input['year'] !== undefined && typeof input['year'] === 'object';
  const hasDate = input[dateField] !== undefined && typeof input[dateField] === 'object';
  return hasYear && hasDate ? { ok: false, field: dateField } : { ok: true };
};

export const procedureKernelSpec = dropFields(procedureFilterSpec, PROCEDURE_VIRTUAL_FIELDS);
export const contractKernelSpec = dropFields(contractFilterSpec, CONTRACT_VIRTUAL_FIELDS);
export const daKernelSpec = dropFields(daFilterSpec, DA_VIRTUAL_FIELDS);
export const modificationKernelSpec = modificationFilterSpec;

export const PROCUREMENT_FILTER_SPECS = {
  procedure: procedureFilterSpec,
  contract: contractFilterSpec,
  directAcquisition: daFilterSpec,
  modification: modificationFilterSpec,
} as const;
