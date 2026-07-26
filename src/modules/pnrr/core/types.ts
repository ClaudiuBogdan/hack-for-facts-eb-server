/**
 * PNRR module — domain view-model types (plan §2).
 *
 * camelCase view models mapped from snake_case columns. All money is a nullable
 * `string` (§14.1 — never float), all dates `'YYYY-MM-DD'` strings, `org_id`
 * never appears (the cross-source key is CUI). Progress percentages are numeric
 * in the DB; they are surfaced as nullable `number` (Float) view-side because
 * they are bounded 0..100 ratios, not money.
 *
 * PII / internal columns are structurally absent (§8.2): no `contact_*`, no
 * `is_personal_recipient`, no `*_raw` (except `measureRaw`, which is the
 * human-readable measure label, not internal provenance), no provenance ids.
 */

import type { Cui, IsoDate, IsoDateTime, Money, Siruta } from '@/modules/shared/index.js';

/** `pnrr.contractors.role` — DB-identical values (no value-mapping layer, §6). */
export type PnrrContractorRole =
  | 'winning_bidder'
  | 'foreign_winning_bidder'
  | 'subcontractor'
  | 'association_leader'
  | 'third_party_support'
  | 'unknown';

export const PNRR_CONTRACTOR_ROLES: readonly PnrrContractorRole[] = [
  'winning_bidder',
  'foreign_winning_bidder',
  'subcontractor',
  'association_leader',
  'third_party_support',
  'unknown',
];

export type PnrrMeasureType = 'investment' | 'reform';

/** Group-by dimensions for `aggregatePayments`. */
export type PnrrPaymentGroupBy = 'component' | 'measure' | 'county' | 'year';
export const PNRR_PAYMENT_GROUP_BY: readonly PnrrPaymentGroupBy[] = [
  'component',
  'measure',
  'county',
  'year',
];

/** Hub registries an entity CUI may link to (link-not-merge — a CUI may have both). */
export type PnrrHub = 'public_entities' | 'companies';

/** Discovery/resolve dimensions (plan §7.4). Module-local — kernel has no ResolveHit yet. */
export type PnrrResolveDim = 'entity' | 'component' | 'measure' | 'county' | 'contractor';
export const PNRR_RESOLVE_DIMS: readonly PnrrResolveDim[] = [
  'entity',
  'component',
  'measure',
  'county',
  'contractor',
];

/** Procurement participant values and winning-role policy are unresolved. */
export type PnrrContractorRankBy = 'value' | 'awards' | 'relationships';

export type PnrrProcurementValueState =
  | 'additive'
  | 'reported_unresolved'
  | 'non_additive'
  | 'unavailable';

export type PnrrAnswerState = 'served' | 'degraded' | 'abstained';
export type PnrrGrain =
  | 'program'
  | 'payment'
  | 'commitment'
  | 'progress_observation'
  | 'organization'
  | 'place'
  | 'verification';
export type PnrrAnalysisMeasure = 'count' | 'amount' | 'progress' | 'coverage';
export type PnrrTimeRole = 'payment_date' | 'commitment_date' | 'snapshot_date' | 'retrieved_at';
export type PnrrGeographyRole = 'beneficiary_county' | 'implementation_county' | 'inferred_uat';

/**
 * Canonical analytical scope shared by GraphQL, REST and MCP. Optional fields
 * are source-native filters; the server echoes the normalized scope verbatim.
 */
export interface PnrrAnalysisScope {
  readonly grain: PnrrGrain;
  readonly measure: PnrrAnalysisMeasure;
  readonly componentCode: string | null;
  readonly beneficiaryCui: Cui | null;
  readonly countySiruta: Siruta | null;
  readonly from: IsoDate | null;
  readonly to: IsoDate | null;
  readonly timeRole: PnrrTimeRole;
  readonly geographyRole: PnrrGeographyRole;
  readonly currency: 'RON' | 'EUR' | null;
  readonly resolutionPolicyVersion: 'pnrr-resolution-v1';
}

export interface PnrrCoverage {
  readonly field: string;
  readonly covered: number;
  readonly total: number;
  readonly percent: number | null;
}

export interface PnrrLaneFreshness {
  readonly lane: string;
  readonly state: PnrrAnswerState | 'legacy_unversioned';
  readonly asOf: IsoDateTime | null;
  readonly suspended: boolean;
  readonly reasonCodes: readonly string[];
}

export interface PnrrRelease {
  readonly releaseId: string;
  readonly releaseKind: 'operational_snapshot' | 'backfill' | 'corrective';
  readonly state: PnrrAnswerState;
  readonly sourceSnapshotAt: IsoDateTime | null;
  readonly completedAt: IsoDateTime | null;
  readonly lanes: readonly PnrrLaneFreshness[];
  readonly limitation: string;
}

export interface PnrrCapability {
  readonly id: string;
  readonly releaseId: string;
  readonly state: PnrrAnswerState | 'legacy_unversioned';
  readonly reasonCodes: readonly string[];
  readonly limitation: string | null;
}

export interface PnrrAnswerMeta {
  readonly scope: PnrrAnalysisScope;
  readonly state: PnrrAnswerState;
  readonly reasonCodes: readonly string[];
  readonly coverage: readonly PnrrCoverage[];
  readonly release: PnrrRelease;
  readonly caveats: readonly string[];
  readonly provenance: readonly string[];
}

export interface PnrrMoneyFact {
  readonly factType:
    | 'plan_allocation'
    | 'eu_receipt'
    | 'national_reported_payment'
    | 'beneficiary_payment'
    | 'commitment';
  readonly amount: Money | null;
  readonly currency: 'RON' | 'EUR';
  readonly aggregationState: PnrrProcurementValueState;
  readonly coveredCount: number;
  readonly totalCount: number;
}

export interface PnrrOverview {
  readonly meta: PnrrAnswerMeta;
  readonly program: {
    readonly snapshotDate: IsoDate | null;
    readonly projectCount: number | null;
    readonly allocationEur: PnrrMoneyFact;
    readonly receivedEur: PnrrMoneyFact;
    readonly paidEur: PnrrMoneyFact;
  };
  readonly beneficiaryPayments: {
    readonly count: number;
    readonly netRon: PnrrMoneyFact;
    readonly grossRon: PnrrMoneyFact;
    readonly reversalRon: PnrrMoneyFact;
    readonly firstDate: IsoDate | null;
    readonly lastDate: IsoDate | null;
  };
  readonly commitments: {
    readonly count: number;
    readonly additiveCount: number;
    readonly unresolvedCount: number;
    readonly additiveRon: PnrrMoneyFact;
  };
  readonly delivery: {
    readonly observedCount: number;
    readonly completedCount: number;
    readonly overHundredCount: number;
    readonly missingFinancialProgressCount: number;
    readonly missingPhysicalProgressCount: number;
  };
}

export interface PnrrPlaceProfile {
  readonly meta: PnrrAnswerMeta;
  readonly countySiruta: Siruta;
  readonly countyName: string | null;
  readonly paymentCount: number;
  readonly paymentNetRon: Money | null;
  readonly commitmentCount: number;
  readonly additiveCommitmentCount: number;
  readonly unresolvedCommitmentCount: number;
  readonly additiveCommitmentRon: Money | null;
  readonly projectObservationCount: number;
  readonly sourceLocalityLabelCount: number;
  readonly sourceLocalityLabelValue: null;
}

export interface PnrrPlaceSummary {
  readonly countySiruta: Siruta;
  readonly countyName: string;
  readonly paymentCount: number;
  readonly paymentNetRon: Money | null;
  readonly commitmentCount: number;
  readonly additiveCommitmentCount: number;
  readonly unresolvedCommitmentCount: number;
  readonly additiveCommitmentRon: Money | null;
  readonly projectObservationCount: number;
  readonly sourceLocalityLabelCount: number;
  readonly sourceLocalityLabelValue: null;
}

export interface PnrrVerificationSummary {
  readonly meta: PnrrAnswerMeta;
  readonly ruleSetVersion: 'pnrr-verification-v1';
  readonly unresolvedCommitmentCount: number;
  readonly duplicatePaymentGroupCount: number;
  readonly missingCommitmentSourceUrlCount: number;
  readonly endBeforeStartCount: number;
  readonly overHundredProgressCount: number;
  readonly missingProgressLinkCount: number;
}

/** A name→value discovery hit. Module-local (see DESIGN.md: kernel should hoist a shared ResolveHit). */
export interface PnrrResolveHit {
  readonly dim: PnrrResolveDim;
  readonly value: string;
  readonly label: string;
  readonly score: number | null;
}

// ── identity spine ───────────────────────────────────────────────────────────

export interface PnrrEntityRoles {
  readonly beneficiary: boolean;
  readonly applicant: boolean;
  readonly winner: boolean;
  readonly subcontractor: boolean;
}

export interface PnrrEntity {
  readonly cui: Cui;
  readonly name: string | null; // resolved_name (rebuildable cache; ANAF>source)
  readonly nameSource: string | null;
  readonly caenCode: string | null;
  readonly isActive: boolean | null;
  readonly isVatPayer: boolean | null;
  readonly roles: PnrrEntityRoles;
  readonly hubs: readonly PnrrHub[]; // link, not merge
  readonly firstSeenSource: string | null;
}

// ── ledger ───────────────────────────────────────────────────────────────────

/**
 * Source-law payment direction: rows are signed (`disbursement` > 0,
 * `reversal` < 0, `zero_adjustment` = 0) and `gross − reversal = net` holds
 * over any filter window. Never hide reversals by summing only positives.
 */
export type PnrrPaymentDirection = 'disbursement' | 'reversal' | 'zero_adjustment';

export interface PnrrPayment {
  readonly paymentKey: string;
  readonly beneficiaryCui: Cui | null;
  readonly beneficiaryName: string | null;
  readonly componentCode: string | null;
  readonly measureFenix: string | null;
  readonly measureRaw: string | null;
  readonly amountLei: Money | null;
  readonly amountEur: Money | null;
  readonly paymentDirection: PnrrPaymentDirection | null;
  readonly paymentDate: IsoDate | null;
  readonly countyName: string | null;
  readonly countySiruta: Siruta | null;
  readonly localityName: string | null;
  readonly caenDivision: string | null;
  readonly financingSource: string | null;
  readonly sourceSystem: string | null;
  readonly retrievedAt: IsoDateTime | null;
}

export interface PnrrCommitment {
  readonly commitmentKey: string;
  readonly beneficiaryCui: Cui | null;
  readonly beneficiaryName: string | null;
  readonly idAngajament: string | null;
  readonly contractNumber: string | null;
  readonly contractTitle: string | null;
  readonly componentCode: string | null;
  readonly measureCode: string | null;
  readonly totalValue: Money | null;
  readonly euValue: Money | null;
  readonly nationalPublicValue: Money | null;
  readonly vatValue: Money | null;
  readonly ineligibleValue: Money | null;
  readonly financialProgress: number | null;
  readonly physicalProgress: number | null;
  readonly commitmentDate: IsoDate | null;
  readonly startDate: IsoDate | null;
  readonly endDate: IsoDate | null;
  readonly status: string;
  readonly countyName: string | null;
  readonly countySiruta: Siruta | null;
  readonly localityName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceUrl: string | null;
  readonly aggregationState: string;
  readonly envelopeObservationCount: number;
  readonly qualityIssues: readonly string[];
  readonly dateQuality: string;
  readonly reportedTotalValue: Money | null;
  readonly reportedEuValue: Money | null;
  readonly progressCount: number;
  readonly latestProgress: PnrrCommitmentSnapshot | null;
  readonly retrievedAt: IsoDateTime | null;
}

export interface PnrrCommitmentSnapshot {
  readonly snapshotId: string;
  readonly sourceRecordId: string; // composite node id: (snapshotId, sourceRecordId)
  readonly snapshotDate: IsoDate;
  readonly beneficiaryCui: Cui | null;
  readonly contractNumber: string | null;
  readonly commitmentKey: string | null; // nullable soft link
  readonly linkConfidence: number | null;
  readonly financialProgress: number | null;
  readonly physicalProgress: number | null;
  readonly stage: string | null;
  readonly receivedEur: Money | null;
  readonly paidEur: Money | null;
  readonly allocatedEur: Money | null;
}

/**
 * One public MIPE project-progress observation. `projectKey` is release-scoped
 * observation identity until persisted project_key_v1 membership is available.
 * Progress values are source ratios (1 = 100%), not percentages.
 */
export interface PnrrProject {
  readonly projectKey: string;
  readonly projectKeyVersion: 'mipe_observation_v1' | 'project_key_v1';
  readonly sourceObservationId: string;
  readonly snapshotId: string;
  readonly snapshotDate: IsoDate;
  readonly endpointName: string;
  readonly itemKey: string | null;
  readonly commitmentBusinessId: string | null;
  readonly contractNumber: string | null;
  readonly contractTitle: string | null;
  readonly beneficiaryCui: Cui | null;
  readonly beneficiaryName: string | null;
  readonly beneficiaryType: string | null;
  readonly componentCode: string | null;
  readonly measureCode: string | null;
  readonly submeasureCode: string | null;
  readonly responsibleInstitutionCode: string | null;
  readonly responsibleInstitutionName: string | null;
  readonly financingSource: string | null;
  readonly commitmentDate: IsoDate | null;
  readonly startDate: IsoDate | null;
  readonly endDate: IsoDate | null;
  readonly lastFundingDate: IsoDate | null;
  readonly totalValueRon: Money | null;
  readonly euContributionRon: Money | null;
  readonly nationalPublicValueRon: Money | null;
  readonly vatRon: Money | null;
  readonly ineligibleValueRon: Money | null;
  readonly receivedAmountRon: Money | null;
  readonly allocatedEur: Money | null;
  readonly paidEur: Money | null;
  readonly receivedEur: Money | null;
  readonly prefinancingEur: Money | null;
  readonly suspendedEur: Money | null;
  readonly revokedEur: Money | null;
  readonly projectCount: number | null;
  readonly contractBeneficiaryCount: number | null;
  readonly paymentBeneficiaryCount: number | null;
  readonly nationalImpactProjectCount: number | null;
  readonly paymentCount: number | null;
  readonly beneficiaryCount: number | null;
  readonly totalEur: Money | null;
  readonly totalRon: Money | null;
  readonly financialProgressRatio: number | null;
  readonly physicalProgressRatio: number | null;
  readonly countyName: string | null;
  readonly countySiruta: Siruta | null;
  readonly localityName: string | null;
  readonly impact: string | null;
  readonly timelineMonth: string | null;
  readonly timelineLabel: string | null;
  readonly status: string | null;
  readonly sourceSystem: string;
  readonly sourceUrl: string;
  readonly retrievedAt: IsoDateTime;
  readonly linkedCommitmentKey: string | null;
  readonly commitmentRelationship: 'candidate_project' | null;
  readonly commitmentAggregationState: string | null;
}

export interface PnrrProjectFacetValue {
  readonly value: string;
  readonly label: string | null;
  readonly count: number;
}

export interface PnrrProjectFacets {
  readonly totalCount: number;
  readonly components: readonly PnrrProjectFacetValue[];
  readonly measures: readonly PnrrProjectFacetValue[];
  readonly statuses: readonly PnrrProjectFacetValue[];
  readonly counties: readonly PnrrProjectFacetValue[];
}

export interface PnrrProgramIndicator {
  readonly snapshotId: string;
  readonly snapshotDate: IsoDate;
  readonly nrProjects: number | null;
  readonly allocatedEur: Money | null;
  readonly receivedEur: Money | null;
  readonly paidEur: Money | null;
}

export interface PnrrFundingCall {
  readonly callId: string;
  readonly title: string;
  readonly budgetRon: Money | null;
  readonly totalEligibleValueRon: Money | null;
  readonly sourceSystem: string;
  readonly sourceUrl: string;
  readonly retrievedAt: IsoDateTime;
}

export interface PnrrFundingApplicationListing {
  readonly listingId: string;
  readonly listingCandidateKey: string;
  readonly callId: string | null;
  readonly sourceRequestCallId: string | null;
  readonly applicantCui: Cui | null;
  readonly applicantName: string | null;
  readonly sentAt: IsoDateTime | null;
  readonly orderNumber: string | null;
  readonly completenessStatus: string;
  readonly sourceSystem: string;
  readonly sourceUrl: string;
  readonly retrievedAt: IsoDateTime;
}

export interface PnrrProgramRevision {
  readonly revisionId: string;
  readonly identifierScheme: string;
  readonly legalReference: string;
  readonly celex: string | null;
  readonly legalStatus: string;
  readonly isCurrentAdopted: boolean;
  readonly effectiveDate: IsoDate | null;
  readonly sourceAuthority: string;
  readonly sourceUrl: string;
  readonly documentCount: number;
  readonly textReadyDocumentCount: number;
  readonly ocrRequiredDocumentCount: number;
}

export interface PnrrCatalogResource {
  readonly resourceId: string;
  readonly packageId: string | null;
  readonly resourceName: string | null;
  readonly format: string | null;
  readonly mimeType: string | null;
  readonly datastoreActive: boolean | null;
  readonly fileUrl: string | null;
  readonly lastModified: IsoDateTime | null;
  readonly declaredHash: string | null;
  readonly sourceSystem: string;
  readonly sourceUrl: string;
  readonly retrievedAt: IsoDateTime;
}

export interface PnrrDocumentReference {
  readonly documentKey: string;
  readonly acquisitionKey: string | null;
  readonly lotKey: string | null;
  readonly announcementKey: string | null;
  readonly programRevisionId: string | null;
  readonly language: string | null;
  readonly documentRole: string | null;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly documentType: string | null;
  readonly sourceUrl: string;
  readonly retrievedAt: IsoDateTime | null;
  readonly contentSha256: string | null;
  readonly extractionState: string;
  readonly hasObjectCustody: boolean;
}

// ── procurement graph ─────────────────────────────────────────────────────────

export interface PnrrAnnouncement {
  readonly announcementKey: string;
  readonly platformProjectId: string | null;
  readonly applicantCui: Cui | null;
  readonly applicantName: string | null;
  readonly projectName: string | null;
  readonly callName: string | null;
  readonly componentCode: string | null;
  readonly budgetValue: Money | null;
  readonly status: string;
  readonly countySiruta: Siruta | null;
}

export interface PnrrAcquisition {
  readonly acquisitionKey: string;
  readonly announcementKey: string | null;
  /** The PNRR beneficiary running this procurement (== announcement applicant). */
  readonly beneficiaryCui: Cui | null;
  readonly beneficiaryName: string | null;
  readonly procedureType: string | null;
  readonly signedAt: IsoDate | null;
  readonly fullContractValue: Money | null;
  readonly valueAggregationState: PnrrProcurementValueState;
  readonly valueReason: string;
  readonly currency: string | null;
  readonly awardCriterion: string | null;
  readonly frameworkAgreement: boolean | null;
  readonly hasAssociationLeader: boolean | null;
  readonly hasThirdPartySupport: boolean | null;
  readonly hasSubcontractor: boolean | null;
  readonly contractorCount: number;
  readonly retrievedAt: IsoDateTime | null;
}

export interface PnrrLot {
  readonly lotKey: string;
  readonly announcementKey: string | null;
  readonly lotNumber: string | null;
  readonly description: string | null;
}

export interface PnrrContractor {
  readonly contractorKey: string;
  readonly acquisitionKey: string | null;
  readonly role: PnrrContractorRole;
  /** Exact source role retained when `role` must fall back to `unknown`. */
  readonly sourceRole: string;
  readonly contractorCui: Cui | null; // null for foreign
  readonly contractorName: string | null;
  readonly contractorCountry: string | null;
  readonly contractValue: Money | null;
  readonly valueAggregationState: PnrrProcurementValueState;
  readonly valueReason: string;
  readonly currency: string | null;
  readonly confidence: string | null;
  readonly validationStatus: string | null;
}

export interface PnrrAcquisitionDetail {
  readonly acquisition: PnrrAcquisition;
  readonly announcement: PnrrAnnouncement | null;
  readonly lots: readonly PnrrLot[];
  readonly contractors: readonly PnrrContractor[];
}

// ── taxonomy / dimensions ─────────────────────────────────────────────────────

export interface PnrrComponent {
  readonly componentCode: string;
  readonly componentName: string | null;
  readonly pillar: string | null;
}

export interface PnrrMeasure {
  readonly fenixReference: string;
  readonly componentCode: string | null;
  readonly measureType: PnrrMeasureType | null;
  readonly measureNumber: number | null;
  readonly measureName: string | null;
}

// ── aggregates / summaries / rank ──────────────────────────────────────────────

export interface PnrrPaymentAggRow {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
  /** Signed NET (disbursements minus reversals) — not gross cash. */
  readonly totalLei: Money | null;
  readonly totalEur: Money | null;
  /** Disbursement rows only (positive). */
  readonly grossLei: Money | null;
  /** Reversal rows as a positive analytical magnitude; gross − reversal = net. */
  readonly reversalLei: Money | null;
  readonly zeroAdjustmentCount: number;
}

export interface PnrrComponentTotal {
  readonly componentCode: string | null;
  readonly count: number;
  readonly totalLei: Money | null;
}

export interface PnrrPaymentSummary {
  readonly count: number;
  /** Signed NET (disbursements minus reversals) — not gross cash. */
  readonly totalLei: Money | null;
  readonly totalEur: Money | null;
  /** Disbursement rows only (positive). */
  readonly grossLei: Money | null;
  /** Reversal rows as a positive analytical magnitude; gross − reversal = net. */
  readonly reversalLei: Money | null;
  readonly zeroAdjustmentCount: number;
  readonly firstDate: IsoDate | null;
  readonly lastDate: IsoDate | null;
  readonly byComponent: readonly PnrrComponentTotal[];
}

export interface PnrrCommitmentSummary {
  readonly count: number;
  /**
   * Additive envelopes only — unresolved envelopes carry NULL money by the
   * commitment envelope law, so this total covers `count − unresolvedCount`
   * rows, not all of them.
   */
  readonly totalValue: Money | null;
  readonly euValue: Money | null;
  /** Rows whose envelope is unresolved (no summable value). */
  readonly unresolvedCount: number;
  readonly avgFinancialProgress: number | null; // unweighted row mean of financial_progress
  readonly avgPhysicalProgress: number | null; // unweighted row mean of physical_progress
}

export interface PnrrProcurementSummary {
  readonly acquisitionsAsBeneficiary: number;
  readonly acquisitionsValue: Money | null;
  /** Legacy field retained for API compatibility; counts source participant rows. */
  readonly wonAsContractor: number;
  /** Legacy money field retained but abstained until the acquisition value law is resolved. */
  readonly wonValue: Money | null;
  readonly participantRelationCount: number;
  readonly unknownRelationshipCount: number;
  readonly participantValue: Money | null;
  readonly valueAggregationState: 'unavailable';
  readonly valueReason: string;
}

export interface PnrrEntityProfile {
  readonly cui: Cui;
  readonly payments: PnrrPaymentSummary;
  readonly commitments: PnrrCommitmentSummary;
  readonly procurement: PnrrProcurementSummary;
  readonly grainNote: string;
  readonly dataAsOf: IsoDateTime | null;
}

export interface PnrrContractorRankRow {
  readonly contractorCui: Cui | null;
  readonly contractorName: string | null;
  /** Legacy field retained for API compatibility; mirrors participantRelationCount. */
  readonly awardCount: number;
  readonly participantRelationCount: number;
  readonly unknownRelationshipCount: number;
  readonly totalValue: Money | null;
  readonly valueAggregationState: 'unavailable';
  readonly valueReason: string;
  readonly roles: readonly PnrrContractorRole[];
}

/** The grain caveat surfaced on profiles + MCP summaries (§14.6). */
export const PNRR_GRAIN_NOTE =
  'PNRR cash disbursed = SUM(payments). Commitments are obligations and acquisitions are awards — these are different grains and are never summed with payments or with each other.';
