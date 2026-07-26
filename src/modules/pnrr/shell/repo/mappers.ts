/**
 * PNRR repo — row → view-model mappers (plan §2). Pure functions: snake_case
 * column rows → camelCase domain types. Money already arrives as `::text`
 * strings; `num()` parses the bounded 0..100 progress ratios to Float (never
 * money). Role/measure-type values are validated to their known sets.
 */

import {
  PNRR_CONTRACTOR_ROLES,
  type PnrrAcquisition,
  type PnrrAnnouncement,
  type PnrrCommitment,
  type PnrrCommitmentSnapshot,
  type PnrrComponent,
  type PnrrContractor,
  type PnrrContractorRole,
  type PnrrEntity,
  type PnrrHub,
  type PnrrLot,
  type PnrrMeasure,
  type PnrrMeasureType,
  type PnrrPayment,
  type PnrrPaymentDirection,
  type PnrrProgramIndicator,
} from '../../core/types.js';

/** Parse a numeric string to a finite number (Float-edge), else null. */
export const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const roleOf = (raw: string): PnrrContractorRole =>
  (PNRR_CONTRACTOR_ROLES as readonly string[]).includes(raw)
    ? (raw as PnrrContractorRole)
    : 'unknown';

const PROCUREMENT_VALUE_REASON = 'participant_allocation_unresolved';

export const publicOrganizationIdentity = (
  cui: string | null,
  name: string | null
): { cui: string | null; name: string | null } =>
  cui !== null && /^[0-9]{1,10}$/u.test(cui) ? { cui, name } : { cui: null, name: null };

const directionOf = (raw: string | null): PnrrPaymentDirection | null =>
  raw === 'disbursement' || raw === 'reversal' || raw === 'zero_adjustment' ? raw : null;

const hubsOf = (raw: readonly string[] | null): readonly PnrrHub[] => {
  if (raw === null) return [];
  return raw.filter((r): r is PnrrHub => r === 'public_entities' || r === 'companies');
};

export interface EntityRow {
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
  hubs: string[] | null;
}

export const mapEntity = (r: EntityRow): PnrrEntity => ({
  cui: r.cui,
  name: r.resolved_name,
  nameSource: r.name_source,
  caenCode: r.caen_code,
  isActive: r.is_active,
  isVatPayer: r.is_vat_payer,
  roles: {
    beneficiary: r.is_beneficiary === true,
    applicant: r.is_applicant === true,
    winner: r.is_winner === true,
    subcontractor: r.is_subcontractor === true,
  },
  hubs: hubsOf(r.hubs),
  firstSeenSource: r.first_seen_source,
});

export interface PaymentRow {
  payment_key: string;
  beneficiary_cui: string | null;
  beneficiary_name: string | null;
  component_code: string | null;
  measure_fenix: string | null;
  measure_raw: string | null;
  amount_lei: string | null;
  amount_eur: string | null;
  payment_direction: string | null;
  payment_date: string | null;
  county_name: string | null;
  county_siruta: string | null;
  locality_name: string | null;
  caen_division: string | null;
  financing_source: string | null;
  source_system: string | null;
  retrieved_at: string | null;
}

export const mapPayment = (r: PaymentRow): PnrrPayment => {
  const beneficiary = publicOrganizationIdentity(r.beneficiary_cui, r.beneficiary_name);
  return {
    paymentKey: r.payment_key,
    beneficiaryCui: beneficiary.cui,
    beneficiaryName: beneficiary.name,
    componentCode: r.component_code,
    measureFenix: r.measure_fenix,
    measureRaw: r.measure_raw,
    amountLei: r.amount_lei,
    amountEur: r.amount_eur,
    paymentDirection: directionOf(r.payment_direction),
    paymentDate: r.payment_date,
    countyName: r.county_name,
    countySiruta: r.county_siruta,
    localityName: r.locality_name,
    caenDivision: r.caen_division,
    financingSource: r.financing_source,
    sourceSystem: r.source_system,
    retrievedAt: r.retrieved_at,
  };
};

export interface CommitmentRow {
  commitment_key: string;
  beneficiary_cui: string | null;
  beneficiary_name: string | null;
  id_angajament: string | null;
  contract_number: string | null;
  contract_title?: string | null;
  component_code: string | null;
  measure_code: string | null;
  total_value: string | null;
  eu_value: string | null;
  national_public_value: string | null;
  vat_value: string | null;
  ineligible_value: string | null;
  financial_progress: string | null;
  physical_progress: string | null;
  commitment_date: string | null;
  start_date?: string | null;
  end_date: string | null;
  status: string | null;
  county_name: string | null;
  county_siruta: string | null;
  locality_name?: string | null;
  source_system?: string | null;
  source_url?: string | null;
  aggregation_state?: string;
  envelope_observation_count?: number;
  quality_issues?: string[];
  date_quality?: string;
  reported_total_value?: string | null;
  reported_eu_value?: string | null;
  retrieved_at: string | null;
  progress_count: string;
}

export const mapCommitment = (
  r: CommitmentRow,
  latestProgress: PnrrCommitmentSnapshot | null
): PnrrCommitment => {
  const beneficiary = publicOrganizationIdentity(r.beneficiary_cui, r.beneficiary_name);
  return {
    commitmentKey: r.commitment_key,
    beneficiaryCui: beneficiary.cui,
    beneficiaryName: beneficiary.name,
    idAngajament: r.id_angajament,
    contractNumber: r.contract_number,
    contractTitle: r.contract_title ?? null,
    componentCode: r.component_code,
    measureCode: r.measure_code,
    totalValue: r.total_value,
    euValue: r.eu_value,
    nationalPublicValue: r.national_public_value,
    vatValue: r.vat_value,
    ineligibleValue: r.ineligible_value,
    financialProgress: num(r.financial_progress),
    physicalProgress: num(r.physical_progress),
    commitmentDate: r.commitment_date,
    startDate: r.start_date ?? null,
    endDate: r.end_date,
    status: r.status ?? '',
    countyName: r.county_name,
    countySiruta: r.county_siruta,
    localityName: r.locality_name ?? null,
    sourceSystem: r.source_system ?? null,
    sourceUrl: r.source_url ?? null,
    aggregationState: r.aggregation_state ?? 'legacy_unversioned',
    envelopeObservationCount: r.envelope_observation_count ?? 1,
    qualityIssues: r.quality_issues ?? [],
    dateQuality: r.date_quality ?? 'unknown',
    reportedTotalValue: r.reported_total_value ?? null,
    reportedEuValue: r.reported_eu_value ?? null,
    progressCount: Number(r.progress_count),
    latestProgress,
    retrievedAt: r.retrieved_at,
  };
};

export interface SnapshotRow {
  snapshot_id: string;
  source_record_id: string;
  snapshot_date: string;
  beneficiary_cui: string | null;
  contract_number: string | null;
  commitment_key: string | null;
  link_confidence: number | null;
  financial_progress: string | null;
  physical_progress: string | null;
  stage: string | null;
  received_eur: string | null;
  paid_eur: string | null;
  allocated_eur: string | null;
}

export const mapSnapshot = (r: SnapshotRow): PnrrCommitmentSnapshot => ({
  snapshotId: r.snapshot_id,
  sourceRecordId: r.source_record_id,
  snapshotDate: r.snapshot_date,
  beneficiaryCui: publicOrganizationIdentity(r.beneficiary_cui, null).cui,
  contractNumber: r.contract_number,
  commitmentKey: r.commitment_key,
  linkConfidence: num(r.link_confidence),
  financialProgress: num(r.financial_progress),
  physicalProgress: num(r.physical_progress),
  stage: r.stage,
  receivedEur: r.received_eur,
  paidEur: r.paid_eur,
  allocatedEur: r.allocated_eur,
});

export interface ProgramIndicatorRow {
  snapshot_id: string;
  snapshot_date: string;
  nr_projects: number | null;
  allocated_eur: string | null;
  received_eur: string | null;
  paid_eur: string | null;
}

export const mapProgramIndicator = (r: ProgramIndicatorRow): PnrrProgramIndicator => ({
  snapshotId: r.snapshot_id,
  snapshotDate: r.snapshot_date,
  nrProjects: r.nr_projects,
  allocatedEur: r.allocated_eur,
  receivedEur: r.received_eur,
  paidEur: r.paid_eur,
});

export interface AnnouncementRow {
  announcement_key: string;
  platform_project_id: string | null;
  applicant_cui: string | null;
  applicant_name: string | null;
  project_name: string | null;
  call_name: string | null;
  component_code: string | null;
  budget_value: string | null;
  status: string | null;
  county_siruta: string | null;
}

export const mapAnnouncement = (r: AnnouncementRow): PnrrAnnouncement => {
  const applicant = publicOrganizationIdentity(r.applicant_cui, r.applicant_name);
  return {
    announcementKey: r.announcement_key,
    platformProjectId: r.platform_project_id,
    applicantCui: applicant.cui,
    applicantName: applicant.name,
    projectName: r.project_name,
    callName: r.call_name,
    componentCode: r.component_code,
    budgetValue: r.budget_value,
    status: r.status ?? '',
    countySiruta: r.county_siruta,
  };
};

export interface AcquisitionRow {
  acquisition_key: string;
  announcement_key: string | null;
  beneficiary_cui: string | null;
  beneficiary_name: string | null;
  procedure_type: string | null;
  signed_at: string | null;
  full_contract_value: string | null;
  currency: string | null;
  award_criterion: string | null;
  framework_agreement: boolean | null;
  has_association_leader: boolean | null;
  has_third_party_support: boolean | null;
  has_subcontractor: boolean | null;
  retrieved_at: string | null;
  contractor_count: string;
}

export const mapAcquisition = (
  r: AcquisitionRow,
  includeReportedValue = false
): PnrrAcquisition => {
  const beneficiary = publicOrganizationIdentity(r.beneficiary_cui, r.beneficiary_name);
  return {
    acquisitionKey: r.acquisition_key,
    announcementKey: r.announcement_key,
    beneficiaryCui: beneficiary.cui,
    beneficiaryName: beneficiary.name,
    procedureType: r.procedure_type,
    signedAt: r.signed_at,
    fullContractValue: includeReportedValue ? r.full_contract_value : null,
    valueAggregationState: includeReportedValue ? 'reported_unresolved' : 'unavailable',
    valueReason: PROCUREMENT_VALUE_REASON,
    currency: r.currency,
    awardCriterion: r.award_criterion,
    frameworkAgreement: r.framework_agreement,
    hasAssociationLeader: r.has_association_leader,
    hasThirdPartySupport: r.has_third_party_support,
    hasSubcontractor: r.has_subcontractor,
    contractorCount: Number(r.contractor_count),
    retrievedAt: r.retrieved_at,
  };
};

export interface LotRow {
  lot_key: string;
  announcement_key: string | null;
  lot_number: string | null;
  description: string | null;
}

export const mapLot = (r: LotRow): PnrrLot => ({
  lotKey: r.lot_key,
  announcementKey: r.announcement_key,
  lotNumber: r.lot_number,
  description: r.description,
});

export interface ContractorRow {
  contractor_key: string;
  acquisition_key: string | null;
  role: string;
  contractor_cui: string | null;
  contractor_name: string | null;
  contractor_country: string | null;
  contract_value: string | null;
  currency: string | null;
  confidence: string | null;
  validation_status: string | null;
}

export const mapContractor = (r: ContractorRow): PnrrContractor => {
  const contractor = publicOrganizationIdentity(r.contractor_cui, r.contractor_name);
  return {
    contractorKey: r.contractor_key,
    acquisitionKey: r.acquisition_key,
    role: roleOf(r.role),
    sourceRole: r.role,
    contractorCui: contractor.cui,
    contractorName: contractor.name,
    contractorCountry: r.contractor_country,
    contractValue: null,
    valueAggregationState: 'unavailable',
    valueReason: PROCUREMENT_VALUE_REASON,
    currency: r.currency,
    confidence: r.confidence,
    validationStatus: r.validation_status,
  };
};

export interface ComponentRow {
  component_code: string;
  component_name: string | null;
  pillar: string | null;
}

export const mapComponent = (r: ComponentRow): PnrrComponent => ({
  componentCode: r.component_code,
  componentName: r.component_name,
  pillar: r.pillar,
});

export interface MeasureRow {
  fenix_reference: string;
  component_code: string | null;
  measure_type: string | null;
  measure_number: number | null;
  measure_name: string | null;
}

const measureTypeOf = (raw: string | null): PnrrMeasureType | null =>
  raw === 'investment' || raw === 'reform' ? raw : null;

export const mapMeasure = (r: MeasureRow): PnrrMeasure => ({
  fenixReference: r.fenix_reference,
  componentCode: r.component_code,
  measureType: measureTypeOf(r.measure_type),
  measureNumber: r.measure_number,
  measureName: r.measure_name,
});
