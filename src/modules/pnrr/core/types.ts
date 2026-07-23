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
  | 'third_party_support';

export const PNRR_CONTRACTOR_ROLES: readonly PnrrContractorRole[] = [
  'winning_bidder',
  'foreign_winning_bidder',
  'subcontractor',
  'association_leader',
  'third_party_support',
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

export type PnrrContractorRankBy = 'value' | 'awards';

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
  readonly endDate: IsoDate | null;
  readonly status: string;
  readonly countyName: string | null;
  readonly countySiruta: Siruta | null;
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

export interface PnrrProgramIndicator {
  readonly snapshotId: string;
  readonly snapshotDate: IsoDate;
  readonly nrProjects: number | null;
  readonly allocatedEur: Money | null;
  readonly receivedEur: Money | null;
  readonly paidEur: Money | null;
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
  readonly contractorCui: Cui | null; // null for foreign
  readonly contractorName: string | null;
  readonly contractorCountry: string | null;
  readonly contractValue: Money | null;
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
  readonly wonAsContractor: number;
  readonly wonValue: Money | null;
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
  readonly awardCount: number;
  readonly totalValue: Money | null;
  readonly roles: readonly PnrrContractorRole[];
}

/** The grain caveat surfaced on profiles + MCP summaries (§14.6). */
export const PNRR_GRAIN_NOTE =
  'PNRR cash disbursed = SUM(payments). Commitments are obligations and acquisitions are awards — these are different grains and are never summed with payments or with each other.';
