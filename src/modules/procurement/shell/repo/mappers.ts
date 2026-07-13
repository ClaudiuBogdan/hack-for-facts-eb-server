/**
 * Procurement module — row → view-model mappers (plan §2). Pure functions; money
 * stays a STRING (§14.1). The `currency` column is mapped to `{ isRon, valueSuspect }`
 * at this boundary and never exposed raw (audit F1/F7). `cpvDivisionCode` is derived
 * from the first two chars of the (normalized 8-digit) `cpv_code`.
 *
 * Verified-live currency invariant (2026-06-17): `value_ron IS NOT NULL` ⟹ currency
 * ∈ {null,'',RON}. So:
 *   isRon        = currency is null/''/'RON'
 *   valueSuspect = value_ron is null AND currency present AND currency ∉ {'','RON'}
 *
 * CURRENCY EXPOSURE (the client contract needs the token beside `valueRon`):
 *   currency = isRon ? 'RON' : (a 3-letter alpha token, uppercased) : null
 * The raw column's garbage tail (~2.6k rows holding CPV codes and bare amounts) can
 * therefore never reach the wire — a non-alpha token degrades to `null`, which the
 * paired `valueSuspect: true` already explains.
 */

import {
  type ContractStatus,
  type DaSourceSystem,
  type DaStatus,
  type ProcedureStatus,
} from '../../core/constants.js';

import type {
  DuplicateRef,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  TedRef,
} from '../../core/types.js';
import type {
  ProcurementContractModificationsTable,
  ProcurementContractsTable,
  ProcurementDirectAcquisitionsTable,
  ProcurementProceduresTable,
} from '../db/schema.js';

/**
 * The repo SELECTs project a SUBSET of each table (money cast to text, internal
 * columns dropped). Mappers read exactly the projected columns, so they accept the
 * projected ROW shape — never the full table type (which would demand columns the
 * SELECT omits, e.g. `source_system` on procedures).
 */
type ProcedureRow = Pick<
  ProcurementProceduresTable,
  | 'procedure_id'
  | 'source_system'
  | 'source_url'
  | 'notice_no'
  | 'notice_kind'
  | 'procedure_type'
  | 'contract_kind'
  | 'title'
  | 'authority_cui'
  | 'authority_name'
  | 'cpv_code'
  | 'currency'
  | 'estimated_value_ron'
  | 'awarded_value_ron'
  | 'status'
  | 'county_name'
  | 'publication_date'
  | 'state_date'
>;
type ContractRow = Pick<
  ProcurementContractsTable,
  | 'contract_id'
  | 'contract_key'
  | 'source_system'
  | 'source_url'
  | 'procedure_id'
  | 'notice_no'
  | 'contract_no'
  | 'contract_date'
  | 'title'
  | 'authority_cui'
  | 'authority_name'
  | 'supplier_cui'
  | 'supplier_name'
  | 'cpv_code'
  | 'currency'
  | 'value_ron'
  | 'estimated_value_ron'
  | 'status'
  | 'county_name'
  | 'is_canonical'
  | 'dup_group_id'
>;
type DaRow = Pick<
  ProcurementDirectAcquisitionsTable,
  | 'da_id'
  | 'da_key'
  | 'source_system'
  | 'source_url'
  | 'unique_code'
  | 'title'
  | 'authority_cui'
  | 'authority_name'
  | 'supplier_cui'
  | 'supplier_name'
  | 'cpv_code'
  | 'currency'
  | 'value_ron'
  | 'estimated_value_ron'
  | 'status'
  | 'county_name'
  | 'publication_date'
  | 'finalization_date'
  | 'is_canonical'
  | 'dup_group_id'
>;
type ModificationRow = Pick<
  ProcurementContractModificationsTable,
  | 'modification_id'
  | 'contract_id'
  | 'source_url'
  | 'link_method'
  | 'link_confidence'
  | 'authority_cui'
  | 'supplier_cui'
  | 'contract_no'
  | 'notice_no'
  | 'modification_date'
  | 'value_before_ron'
  | 'value_after_ron'
  | 'value_delta_ron'
  | 'modification_type'
  | 'year'
>;

// ── status coercion (closed enums; unknown live tokens → 'unknown') ────────────

const PROCEDURE_STATUS_SET = new Set<ProcedureStatus>([
  'published',
  'in_evaluation',
  'awarded',
  'cancelled',
  'suspended',
  'unknown',
]);
const CONTRACT_STATUS_SET = new Set<ContractStatus>([
  'awarded',
  'in_progress',
  'closed',
  'cancelled',
  'unknown',
]);
const DA_STATUS_SET = new Set<DaStatus>([
  'offered',
  'awarded',
  'finalized',
  'cancelled',
  'unknown',
]);
const DA_SOURCE_SET = new Set<DaSourceSystem>(['elicitatie_da', 'seap_da', 'seap_dan']);

const procedureStatus = (s: string): ProcedureStatus =>
  PROCEDURE_STATUS_SET.has(s as ProcedureStatus) ? (s as ProcedureStatus) : 'unknown';
const contractStatus = (s: string): ContractStatus =>
  CONTRACT_STATUS_SET.has(s as ContractStatus) ? (s as ContractStatus) : 'unknown';
const daStatus = (s: string): DaStatus =>
  DA_STATUS_SET.has(s as DaStatus) ? (s as DaStatus) : 'unknown';
const daSourceSystem = (s: string): DaSourceSystem =>
  DA_SOURCE_SET.has(s as DaSourceSystem) ? (s as DaSourceSystem) : 'seap_da';

// ── derivations ────────────────────────────────────────────────────────────────

const cpvDivision = (cpv: string | null): string | null => {
  if (cpv === null) return null;
  const m = /^(\d{2})/u.exec(cpv.trim());
  return m?.[1] ?? null;
};

/** A currency token is exposable only if it LOOKS like one (3 alpha chars). */
const ISO_LIKE = /^[A-Za-z]{3}$/u;

/**
 * Map the repurposed `currency` flag carrier to the derived booleans + the
 * sanitized token. The raw column is never returned: a non-ISO-like value (the
 * garbage tail) becomes `null`, and `valueSuspect` carries the honest signal.
 */
export const currencyFlags = (
  currency: string | null,
  valueRon: string | null
): { isRon: boolean; valueSuspect: boolean; currency: string | null } => {
  const cur = (currency ?? '').trim();
  const isRon = cur === '' || cur.toUpperCase() === 'RON';
  const valueSuspect = valueRon === null && !isRon;
  const token = isRon ? 'RON' : ISO_LIKE.test(cur) ? cur.toUpperCase() : null;
  return { isRon, valueSuspect, currency: token };
};

const linkMethod = (m: string | null): ProcurementModification['linkMethod'] =>
  m === 'notice_no' || m === 'authority_cui+contract_no' ? m : null;

const deltaPct = (before: string | null, delta: string | null): number | null => {
  if (before === null || delta === null) return null;
  const b = Number(before);
  const d = Number(delta);
  if (!Number.isFinite(b) || b === 0 || !Number.isFinite(d)) return null;
  return d / b;
};

// ── mappers ──────────────────────────────────────────────────────────────────

export const mapProcedure = (r: ProcedureRow): ProcurementProcedure => {
  // Procedures carry estimated + awarded value; the F1/F7 flag nulls the RON value
  // for non-RON. Use awarded value when present, else estimated, to derive the flag.
  const flags = currencyFlags(r.currency, r.awarded_value_ron ?? r.estimated_value_ron);
  return {
    procedureId: r.procedure_id,
    sourceSystem: r.source_system,
    sourceUrl: r.source_url,
    noticeNo: r.notice_no,
    noticeKind: r.notice_kind,
    procedureType: r.procedure_type,
    contractKind: r.contract_kind,
    title: r.title,
    authorityCui: r.authority_cui,
    authorityName: r.authority_name,
    cpvCode: r.cpv_code,
    cpvDivisionCode: cpvDivision(r.cpv_code),
    estimatedValueRon: r.estimated_value_ron,
    awardedValueRon: r.awarded_value_ron,
    currency: flags.currency,
    isRon: flags.isRon,
    valueSuspect: flags.valueSuspect,
    status: procedureStatus(r.status),
    countyName: r.county_name,
    publicationDate: r.publication_date,
    stateDate: r.state_date,
  };
};

export const mapContract = (r: ContractRow): ProcurementContract => {
  const flags = currencyFlags(r.currency, r.value_ron);
  return {
    contractId: r.contract_id,
    contractKey: r.contract_key,
    sourceSystem: r.source_system,
    sourceUrl: r.source_url,
    procedureId: r.procedure_id,
    noticeNo: r.notice_no,
    contractNo: r.contract_no,
    contractDate: r.contract_date,
    title: r.title,
    authorityCui: r.authority_cui,
    authorityName: r.authority_name,
    supplierCui: r.supplier_cui,
    supplierName: r.supplier_name,
    cpvCode: r.cpv_code,
    cpvDivisionCode: cpvDivision(r.cpv_code),
    valueRon: r.value_ron,
    estimatedValueRon: r.estimated_value_ron,
    currency: flags.currency,
    isRon: flags.isRon,
    valueSuspect: flags.valueSuspect,
    status: contractStatus(r.status),
    countyName: r.county_name,
    isCanonical: r.is_canonical,
    dupGroupId: r.dup_group_id,
  };
};

export const mapDirectAcquisition = (r: DaRow): ProcurementDirectAcquisition => {
  const flags = currencyFlags(r.currency, r.value_ron);
  return {
    daId: r.da_id,
    daKey: r.da_key,
    sourceSystem: daSourceSystem(r.source_system),
    sourceUrl: r.source_url,
    uniqueCode: r.unique_code,
    title: r.title,
    authorityCui: r.authority_cui,
    authorityName: r.authority_name,
    supplierCui: r.supplier_cui,
    supplierName: r.supplier_name,
    cpvCode: r.cpv_code,
    cpvDivisionCode: cpvDivision(r.cpv_code),
    valueRon: r.value_ron,
    estimatedValueRon: r.estimated_value_ron,
    currency: flags.currency,
    isRon: flags.isRon,
    valueSuspect: flags.valueSuspect,
    status: daStatus(r.status),
    countyName: r.county_name,
    publicationDate: r.publication_date,
    finalizationDate: r.finalization_date,
    isCanonical: r.is_canonical,
    dupGroupId: r.dup_group_id,
  };
};

export const mapModification = (r: ModificationRow): ProcurementModification => ({
  modificationId: r.modification_id,
  contractId: r.contract_id,
  sourceUrl: r.source_url,
  linkMethod: linkMethod(r.link_method),
  linkConfidence: r.link_confidence,
  authorityCui: r.authority_cui,
  supplierCui: r.supplier_cui,
  contractNo: r.contract_no,
  noticeNo: r.notice_no,
  modificationDate: r.modification_date,
  valueBeforeRon: r.value_before_ron,
  valueAfterRon: r.value_after_ron,
  valueDeltaRon: r.value_delta_ron,
  deltaPct: deltaPct(r.value_before_ron, r.value_delta_ron),
  modificationType: r.modification_type,
  year: r.year,
});

export const mapDuplicateRef = (r: { id: string; source_system: string }): DuplicateRef => ({
  sourceSystem: r.source_system,
  id: r.id,
});

export const mapTedRef = (r: { publication_number: string; source_url: string }): TedRef => ({
  tedNoticeNo: r.publication_number,
  sourceUrl: r.source_url,
});
