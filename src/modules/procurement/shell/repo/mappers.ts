/**
 * Procurement module — row → view-model mappers (plan §2). Pure functions; money
 * stays a STRING (§14.1). `cpvDivisionCode` is derived from the first two chars
 * of the (normalized 8-digit) `cpv_code`.
 *
 * Value semantics are the data layer's VALUE MODEL (rules v2): every valued
 * grain maps its resolution columns into the shared `ValueResolution` block
 * (`valueState` + rule label + the comparable measure); `valueAccepted` derives
 * from the frozen ACCEPTED set. The legacy `isRon`/`valueSuspect` currency-flag
 * derivation is retired — since the Phase-F loader (scrapper 5ad48fab) the
 * `currency` column is a clean RON/EUR/USD enum; the mapper still degrades a
 * non-ISO-like pre-Phase-F residue token to null.
 */

import {
  ACCEPTED_VALUE_STATE_SET,
  VALUE_COMPARABLE_BASES,
  VALUE_STATES,
  type ContractStatus,
  type DaSourceSystem,
  type DaStatus,
  type ProcedureStatus,
  type ValueComparableBasis,
  type ValueState,
} from '../../core/constants.js';

import type {
  DuplicateRef,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  TedRef,
  ValueResolution,
  DaDetailBody,
  DaItem,
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
  | 'value_state'
  | 'value_state_detail'
  | 'value_ron_comparable'
  | 'value_comparable_basis'
  | 'value_rules_version'
  | 'value_resolved_at'
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
  | 'value_state'
  | 'value_state_detail'
  | 'value_ron_comparable'
  | 'value_comparable_basis'
  | 'value_rules_version'
  | 'value_resolved_at'
  | 'canonical_value_source'
  | 'value_disagreement'
  | 'record_kind'
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
  | 'value_state'
  | 'value_state_detail'
  | 'value_ron_comparable'
  | 'value_comparable_basis'
  | 'value_rules_version'
  | 'value_resolved_at'
>;
type ModificationRow = Pick<
  ProcurementContractModificationsTable,
  | 'modification_id'
  | 'contract_id'
  | 'source_url'
  | 'link_method'
  | 'link_confidence'
  | 'authority_cui'
  | 'authority_name'
  | 'supplier_cui'
  | 'supplier_name'
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
 * Sanitize the currency token for exposure. Post-Phase-F rows carry a clean
 * RON/EUR/USD enum (or NULL = RON-implied); a pre-Phase-F residue token that
 * is not ISO-like degrades to null rather than reaching the wire.
 */
export const sanitizeCurrency = (currency: string | null): string | null => {
  const cur = (currency ?? '').trim();
  if (cur === '') return null;
  return ISO_LIKE.test(cur) ? cur.toUpperCase() : null;
};

const VALUE_STATE_SET = new Set<string>(VALUE_STATES);
const BASIS_SET = new Set<string>(VALUE_COMPARABLE_BASES);

type ValueRow = Pick<
  ProcurementDirectAcquisitionsTable,
  | 'value_state'
  | 'value_state_detail'
  | 'value_ron_comparable'
  | 'value_comparable_basis'
  | 'value_rules_version'
  | 'value_resolved_at'
>;

/**
 * Map the resolution columns to the shared block. An unknown state token (a
 * future engine version) degrades to null state — the row then reads as
 * unresolved rather than mislabeled; `valueAccepted` stays derivation-only.
 */
export const valueResolution = (r: ValueRow): ValueResolution => {
  const state =
    r.value_state !== null && VALUE_STATE_SET.has(r.value_state)
      ? (r.value_state as ValueState)
      : null;
  const basis =
    r.value_comparable_basis !== null && BASIS_SET.has(r.value_comparable_basis)
      ? (r.value_comparable_basis as ValueComparableBasis)
      : null;
  return {
    valueState: state,
    valueStateRule: r.value_state_detail?.rule ?? null,
    valueAccepted: state !== null && ACCEPTED_VALUE_STATE_SET.has(state),
    valueRonComparable: r.value_ron_comparable,
    valueComparableBasis: basis,
    valueRulesVersion: r.value_rules_version,
    valueResolvedAt: r.value_resolved_at,
  };
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
    currency: sanitizeCurrency(r.currency),
    status: procedureStatus(r.status),
    countyName: r.county_name,
    publicationDate: r.publication_date,
    stateDate: r.state_date,
    value: valueResolution(r),
  };
};

export const mapContract = (r: ContractRow): ProcurementContract => {
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
    currency: sanitizeCurrency(r.currency),
    status: contractStatus(r.status),
    countyName: r.county_name,
    isCanonical: r.is_canonical,
    dupGroupId: r.dup_group_id,
    value: valueResolution(r),
    canonicalValueSource: r.canonical_value_source,
    valueDisagreement: r.value_disagreement,
    // NULL = pre-v5 row; reads as contract_award (matches the filter's
    // coalesce so lists and rows agree). Unknown future kinds fail closed to
    // contract_award rather than crashing the mapper.
    recordKind: r.record_kind === 'framework_agreement' ? 'framework_agreement' : 'contract_award',
  };
};

export const mapDirectAcquisition = (r: DaRow): ProcurementDirectAcquisition => {
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
    currency: sanitizeCurrency(r.currency),
    status: daStatus(r.status),
    countyName: r.county_name,
    publicationDate: r.publication_date,
    finalizationDate: r.finalization_date,
    isCanonical: r.is_canonical,
    dupGroupId: r.dup_group_id,
    value: valueResolution(r),
  };
};

export const mapModification = (r: ModificationRow): ProcurementModification => ({
  modificationId: r.modification_id,
  contractId: r.contract_id,
  sourceUrl: r.source_url,
  linkMethod: linkMethod(r.link_method),
  linkConfidence: r.link_confidence,
  authorityCui: r.authority_cui,
  authorityName: r.authority_name,
  supplierCui: r.supplier_cui,
  supplierName: r.supplier_name,
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

// ── direct-acquisition detail (what was actually bought) ──────────────────────

/**
 * PRIVACY GATE. The data layer stores every free-text field in full and marks
 * the row `contact_pii` when a versioned detector finds an email, Romanian
 * mobile number or CNP in it — measured at 5.75% of detail bodies. The platform
 * rule is "extract everything; gate at the API", and THIS is that gate.
 *
 * Withheld text becomes `null` alongside `textRedacted: true`, never a silent
 * blank: a reader must be able to tell "we are not showing you this" apart from
 * "the source recorded nothing here". Structured fields (dates, counts, money,
 * the item basket) are unaffected — the detector only ever fires on prose.
 */
const PUBLIC_PRIVACY_CLASS = 'public';

export interface DaDetailBodyRow {
  description: string | null;
  delivery_condition: string | null;
  payment_condition: string | null;
  contract_type_text: string | null;
  is_eu_funded: boolean;
  eu_fund_text: string | null;
  ca_decision_date: string | null;
  ca_decision_deadline: string | null;
  supplier_decision_date: string | null;
  supplier_decision_deadline: string | null;
  ca_rejection_reason: string | null;
  supplier_rejection_reason: string | null;
  correction_reason: string | null;
  document_count: number;
  item_count: number;
  items_total: string | null;
  items_value_delta: string | null;
  items_reconciled: boolean | null;
  privacy_class: string;
  source_url: string;
}

export interface DaItemRow {
  da_item_id: string;
  item_index: number;
  catalog_item_code: string | null;
  catalog_item_name: string | null;
  catalog_item_description: string | null;
  item_measure_unit: string | null;
  cpv_code: string | null;
  cpv_text: string | null;
  item_quantity: string | null;
  unit_price: string | null;
  unit_estimated_price: string | null;
  catalog_unit_price: string | null;
  line_value: string | null;
  source_url: string;
}

export const mapDaItem = (r: DaItemRow): DaItem => ({
  catalogItemCode: r.catalog_item_code,
  catalogItemDescription: r.catalog_item_description,
  catalogItemName: r.catalog_item_name,
  catalogUnitPrice: r.catalog_unit_price,
  cpvCode: r.cpv_code,
  cpvText: r.cpv_text,
  daItemId: r.da_item_id,
  itemIndex: r.item_index,
  itemMeasureUnit: r.item_measure_unit,
  itemQuantity: r.item_quantity,
  lineValue: r.line_value,
  sourceUrl: r.source_url,
  unitEstimatedPrice: r.unit_estimated_price,
  unitPrice: r.unit_price,
});

export const mapDaDetailBody = (r: DaDetailBodyRow, items: readonly DaItemRow[]): DaDetailBody => {
  const redacted = r.privacy_class !== PUBLIC_PRIVACY_CLASS;
  const text = (value: string | null): string | null => (redacted ? null : value);
  return {
    caDecisionDate: r.ca_decision_date,
    caDecisionDeadline: r.ca_decision_deadline,
    caRejectionReason: text(r.ca_rejection_reason),
    contractTypeText: r.contract_type_text,
    correctionReason: text(r.correction_reason),
    deliveryCondition: text(r.delivery_condition),
    description: text(r.description),
    documentCount: r.document_count,
    euFundText: r.eu_fund_text,
    isEuFunded: r.is_eu_funded,
    itemCount: r.item_count,
    items: items.map(mapDaItem),
    itemsReconciled: r.items_reconciled,
    itemsTotal: r.items_total,
    itemsValueDelta: r.items_value_delta,
    paymentCondition: text(r.payment_condition),
    sourceUrl: r.source_url,
    supplierDecisionDate: r.supplier_decision_date,
    supplierDecisionDeadline: r.supplier_decision_deadline,
    supplierRejectionReason: text(r.supplier_rejection_reason),
    textRedacted: redacted,
  };
};
