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
 */

import {
  type ContractStatus,
  type DaSourceSystem,
  type DaStatus,
  type ProcedureStatus,
} from '../../core/constants.js';

import type {
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementEdge,
  ProcurementModification,
  ProcurementProcedure,
  ProcurementGrain,
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
  | 'procedure_id' | 'notice_no' | 'notice_kind' | 'procedure_type' | 'contract_kind'
  | 'title' | 'authority_cui' | 'authority_name' | 'cpv_code' | 'currency'
  | 'estimated_value_ron' | 'awarded_value_ron' | 'status' | 'county_name'
  | 'publication_date' | 'state_date'
>;
type ContractRow = Pick<
  ProcurementContractsTable,
  | 'contract_id' | 'contract_key' | 'procedure_id' | 'notice_no' | 'contract_no'
  | 'contract_date' | 'title' | 'authority_cui' | 'authority_name' | 'supplier_cui'
  | 'supplier_name' | 'cpv_code' | 'currency' | 'value_ron' | 'estimated_value_ron'
  | 'status' | 'county_name' | 'is_canonical' | 'dup_group_id'
>;
type DaRow = Pick<
  ProcurementDirectAcquisitionsTable,
  | 'da_id' | 'da_key' | 'source_system' | 'unique_code' | 'title' | 'authority_cui'
  | 'authority_name' | 'supplier_cui' | 'supplier_name' | 'cpv_code' | 'currency'
  | 'value_ron' | 'estimated_value_ron' | 'status' | 'county_name' | 'publication_date'
  | 'finalization_date' | 'is_canonical' | 'dup_group_id'
>;
type ModificationRow = Pick<
  ProcurementContractModificationsTable,
  | 'modification_id' | 'contract_id' | 'link_method' | 'link_confidence' | 'authority_cui'
  | 'supplier_cui' | 'contract_no' | 'notice_no' | 'modification_date'
  | 'value_before_ron' | 'value_after_ron' | 'value_delta_ron' | 'modification_type' | 'year'
>;

// ── status coercion (closed enums; unknown live tokens → 'unknown') ────────────

const PROCEDURE_STATUS_SET = new Set<ProcedureStatus>([
  'published', 'in_evaluation', 'awarded', 'cancelled', 'suspended', 'unknown',
]);
const CONTRACT_STATUS_SET = new Set<ContractStatus>([
  'awarded', 'in_progress', 'closed', 'cancelled', 'unknown',
]);
const DA_STATUS_SET = new Set<DaStatus>(['offered', 'awarded', 'finalized', 'cancelled', 'unknown']);
const DA_SOURCE_SET = new Set<DaSourceSystem>(['elicitatie_da', 'seap_da', 'seap_dan']);

const procedureStatus = (s: string): ProcedureStatus =>
  PROCEDURE_STATUS_SET.has(s as ProcedureStatus) ? (s as ProcedureStatus) : 'unknown';
const contractStatus = (s: string): ContractStatus =>
  CONTRACT_STATUS_SET.has(s as ContractStatus) ? (s as ContractStatus) : 'unknown';
const daStatus = (s: string): DaStatus => (DA_STATUS_SET.has(s as DaStatus) ? (s as DaStatus) : 'unknown');
const daSourceSystem = (s: string): DaSourceSystem =>
  DA_SOURCE_SET.has(s as DaSourceSystem) ? (s as DaSourceSystem) : 'seap_da';

// ── derivations ────────────────────────────────────────────────────────────────

const cpvDivision = (cpv: string | null): string | null => {
  if (cpv === null) return null;
  const m = /^(\d{2})/u.exec(cpv.trim());
  return m?.[1] ?? null;
};

/** Map the repurposed `currency` flag carrier to the two derived booleans. */
const currencyFlags = (
  currency: string | null,
  valueRon: string | null
): { isRon: boolean; valueSuspect: boolean } => {
  const cur = (currency ?? '').trim();
  const isRon = cur === '' || cur.toUpperCase() === 'RON';
  const valueSuspect = valueRon === null && !isRon;
  return { isRon, valueSuspect };
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

/** Map an aggregated org_edge row (grouped over months) to the edge view model. */
export const mapEdge = (r: {
  authority_cui: string;
  authority_name: string | null;
  supplier_cui: string;
  supplier_name: string | null;
  source_grain: string;
  flow_count: string;
  amount_ron_sum: string | null;
  amount_present_count: string;
  amount_missing_count: string;
  first_flow_date: string | null;
  last_flow_date: string | null;
  evidence_refs_sample: string[] | null;
}): ProcurementEdge => ({
  authorityCui: r.authority_cui,
  authorityName: r.authority_name,
  supplierCui: r.supplier_cui,
  supplierName: r.supplier_name,
  grain: r.source_grain as ProcurementGrain,
  flowCount: r.flow_count,
  amountRonSum: r.amount_ron_sum,
  amountPresentCount: r.amount_present_count,
  amountMissingCount: r.amount_missing_count,
  firstFlowDate: r.first_flow_date,
  lastFlowDate: r.last_flow_date,
  evidenceRefsSample: r.evidence_refs_sample ?? [],
});
