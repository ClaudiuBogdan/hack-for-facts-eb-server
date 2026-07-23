/**
 * PNRR module — GraphQL SDL slice (plan §6). All types `Pnrr*`-prefixed (§14.8);
 * extends root `Query` + `type Entity`. Filter inputs are GENERATED from the §7
 * specs via the kernel `toGraphQLInput(spec)` so the surfaces never drift. Enum
 * values are deliberately DB-identical (snake_case) — they mirror the
 * `contractors.role` / `flow_type` strings verbatim (no value-mapping layer, §6).
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrMeasuresFilterSpec,
  pnrrPaymentsFilterSpec,
} from '../../core/filters.js';

const filterInputs = [
  pnrrEntitiesFilterSpec,
  pnrrPaymentsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrAcquisitionsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrMeasuresFilterSpec,
]
  .map((spec) => toGraphQLInput(spec))
  .join('\n\n');

const objectsAndQuery = /* GraphQL */ `
  enum PnrrContractorRole {
    winning_bidder
    foreign_winning_bidder
    subcontractor
    association_leader
    third_party_support
  }
  enum PnrrMeasureType {
    investment
    reform
  }
  enum PnrrPaymentGroupBy {
    component
    measure
    county
    year
  }
  enum PnrrContractorRankBy {
    value
    awards
  }
  enum PnrrResolveDim {
    entity
    component
    measure
    county
    contractor
  }

  type PnrrEntityRoles {
    beneficiary: Boolean!
    applicant: Boolean!
    winner: Boolean!
    subcontractor: Boolean!
  }

  "A reconciled PNRR entity (CUI spine). name/caenCode are a rebuildable cache."
  type PnrrEntity {
    cui: CUI!
    name: String
    nameSource: String
    caenCode: String
    isActive: Boolean
    isVatPayer: Boolean
    roles: PnrrEntityRoles!
    "Identity registries this CUI links to (link, not merge): public_entities | companies."
    hubs: [String!]!
    firstSeenSource: String
    "Ledger + commitment + procurement rollup (PII-free). Resolved via the same usecase as Entity.pnrr."
    profile: PnrrEntityProfile
  }

  type PnrrComponentTotal {
    componentCode: String
    count: Int!
    totalLei: Money
  }
  """
  Payment money is directional: rows are signed (disbursement > 0,
  reversal < 0, zero_adjustment = 0). totalLei is the signed NET;
  grossLei − reversalLei = totalLei over any window.
  """
  type PnrrPaymentSummary {
    count: Int!
    "Signed NET (disbursements minus reversals) — not gross cash."
    totalLei: Money
    totalEur: Money
    "Disbursement rows only (positive)."
    grossLei: Money
    "Reversal rows as a positive analytical magnitude."
    reversalLei: Money
    zeroAdjustmentCount: Int!
    firstDate: Date
    lastDate: Date
    byComponent: [PnrrComponentTotal!]!
  }
  type PnrrCommitmentSummary {
    count: Int!
    "Additive envelopes only — covers count − unresolvedCount rows (unresolved envelopes carry no summable value)."
    totalValue: Money
    euValue: Money
    "Rows whose envelope is unresolved (NULL money by the envelope law)."
    unresolvedCount: Int!
    avgFinancialProgress: Float
    avgPhysicalProgress: Float
  }
  type PnrrProcurementSummary {
    acquisitionsAsBeneficiary: Int!
    acquisitionsValue: Money
    wonAsContractor: Int!
    wonValue: Money
  }

  "Entity rollup. Grains are kept separate (see grainNote) and never summed."
  type PnrrEntityProfile {
    cui: CUI!
    payments: PnrrPaymentSummary!
    commitments: PnrrCommitmentSummary!
    procurement: PnrrProcurementSummary!
    grainNote: String!
    dataAsOf: DateTime
  }

  "A source-native cash disbursement (the PNRR grain). amount_eur is stored, not recomputed."
  type PnrrPayment {
    paymentKey: ID!
    beneficiaryCui: CUI
    beneficiaryName: String
    componentCode: String
    measureFenix: String
    measureRaw: String
    amountLei: Money
    amountEur: Money
    "disbursement | reversal | zero_adjustment (rows are signed accordingly)."
    paymentDirection: String
    paymentDate: Date
    countyName: String
    countySiruta: SIRUTA
    localityName: String
    caenDivision: String
    financingSource: String
    sourceSystem: String
    retrievedAt: DateTime
  }

  "An obligation fact (not a cash disbursement — never summed with payments)."
  type PnrrCommitment {
    commitmentKey: ID!
    beneficiaryCui: CUI
    beneficiaryName: String
    idAngajament: String
    contractNumber: String
    componentCode: String
    measureCode: String
    totalValue: Money
    euValue: Money
    nationalPublicValue: Money
    vatValue: Money
    ineligibleValue: Money
    financialProgress: Float
    physicalProgress: Float
    commitmentDate: Date
    endDate: Date
    status: String!
    countyName: String
    countySiruta: SIRUTA
    "Number of MIPE progress snapshots for this commitment's contract."
    progressCount: Int!
    "The most recent progress snapshot (cheap single-row), or null."
    latestProgress: PnrrCommitmentSnapshot
    retrievedAt: DateTime
  }

  "A MIPE progress snapshot. Node identity is the composite (snapshotId, sourceRecordId)."
  type PnrrCommitmentSnapshot {
    snapshotId: ID!
    sourceRecordId: ID!
    snapshotDate: Date!
    beneficiaryCui: CUI
    contractNumber: String
    commitmentKey: ID
    linkConfidence: Float
    financialProgress: Float
    physicalProgress: Float
    stage: String
    receivedEur: Money
    paidEur: Money
    allocatedEur: Money
  }

  type PnrrProgramIndicator {
    snapshotId: ID!
    snapshotDate: Date!
    nrProjects: Int
    allocatedEur: Money
    receivedEur: Money
    paidEur: Money
  }

  "A PNRR procurement announcement (applications/calls)."
  type PnrrAnnouncement {
    announcementKey: ID!
    platformProjectId: String
    applicantCui: CUI
    applicantName: String
    projectName: String
    callName: String
    componentCode: String
    budgetValue: Money
    status: String!
    countySiruta: SIRUTA
  }

  type PnrrLot {
    lotKey: ID!
    announcementKey: ID
    lotNumber: String
    description: String
  }

  "An awarded PNRR contract. beneficiaryCui = the PNRR beneficiary running the procurement (== announcement applicant)."
  type PnrrAcquisition {
    acquisitionKey: ID!
    announcementKey: ID
    beneficiaryCui: CUI
    beneficiaryName: String
    procedureType: String
    signedAt: Date
    fullContractValue: Money
    currency: String
    awardCriterion: String
    frameworkAgreement: Boolean
    hasAssociationLeader: Boolean
    hasThirdPartySupport: Boolean
    hasSubcontractor: Boolean
    "Number of contractors (winners/subs) on this acquisition."
    contractorCount: Int!
    retrievedAt: DateTime
    "Bounded child: the winner/subcontractor graph for this acquisition."
    contractors: [PnrrContractor!]!
  }

  type PnrrAcquisitionDetail {
    acquisition: PnrrAcquisition!
    announcement: PnrrAnnouncement
    lots: [PnrrLot!]!
    contractors: [PnrrContractor!]!
  }

  type PnrrContractor {
    contractorKey: ID!
    acquisitionKey: ID
    role: PnrrContractorRole!
    contractorCui: CUI
    contractorName: String
    contractorCountry: String
    contractValue: Money
    currency: String
    confidence: String
    validationStatus: String
  }

  type PnrrContractorRankRow {
    contractorCui: CUI
    contractorName: String
    awardCount: Int!
    totalValue: Money
    roles: [PnrrContractorRole!]!
  }

  type PnrrComponent {
    componentCode: ID!
    componentName: String
    pillar: String
  }
  type PnrrMeasure {
    fenixReference: ID!
    componentCode: String
    measureType: PnrrMeasureType
    measureNumber: Int
    measureName: String
  }

  type PnrrPaymentAggRow {
    key: String!
    label: String
    count: Int!
    "Signed NET (disbursements minus reversals) — not gross cash."
    totalLei: Money
    totalEur: Money
    "Disbursement rows only (positive)."
    grossLei: Money
    "Reversal rows as a positive analytical magnitude; grossLei − reversalLei = totalLei."
    reversalLei: Money
    zeroAdjustmentCount: Int!
  }

  "A name→value discovery hit (module-local resolve surface)."
  type PnrrResolveHit {
    dim: PnrrResolveDim!
    value: String!
    label: String!
    score: Float
  }

  type PnrrEntityConnection {
    edges: [PnrrEntityEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrEntityEdge {
    node: PnrrEntity!
    cursor: String!
  }
  type PnrrPaymentConnection {
    edges: [PnrrPaymentEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrPaymentEdge {
    node: PnrrPayment!
    cursor: String!
  }
  type PnrrCommitmentConnection {
    edges: [PnrrCommitmentEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrCommitmentEdge {
    node: PnrrCommitment!
    cursor: String!
  }
  type PnrrAcquisitionConnection {
    edges: [PnrrAcquisitionEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrAcquisitionEdge {
    node: PnrrAcquisition!
    cursor: String!
  }
  type PnrrContractorConnection {
    edges: [PnrrContractorEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrContractorEdge {
    node: PnrrContractor!
    cursor: String!
  }

  extend type Query {
    "PNRR entity directory (CUI spine). Default sort cui asc."
    pnrrEntities(filter: PnrrEntitiesFilter, first: Int = 20, after: String): PnrrEntityConnection!
    pnrrEntity(cui: CUI!): PnrrEntity
    pnrrEntityProfile(cui: CUI!): PnrrEntityProfile
    "Source-native PNRR cash disbursements. Needs an indexed driving predicate."
    pnrrPayments(filter: PnrrPaymentsFilter, first: Int = 20, after: String): PnrrPaymentConnection!
    pnrrPaymentAggregate(
      filter: PnrrPaymentsFilter
      groupBy: PnrrPaymentGroupBy!
    ): [PnrrPaymentAggRow!]!
    pnrrCommitments(
      filter: PnrrCommitmentsFilter
      first: Int = 20
      after: String
    ): PnrrCommitmentConnection!
    "MIPE progress series for one commitment (bounded; resilient to unlinked snapshots)."
    pnrrCommitmentProgress(commitmentKey: ID!): [PnrrCommitmentSnapshot!]!
    pnrrAcquisitions(
      filter: PnrrAcquisitionsFilter
      first: Int = 20
      after: String
    ): PnrrAcquisitionConnection!
    pnrrAcquisition(key: ID!): PnrrAcquisitionDetail
    pnrrContractors(
      filter: PnrrContractorsFilter
      first: Int = 20
      after: String
    ): PnrrContractorConnection!
    "Top PNRR contractors from source facts (self-awards excluded)."
    pnrrContractorRank(
      filter: PnrrContractorsFilter
      by: PnrrContractorRankBy = value
      limit: Int = 20
    ): [PnrrContractorRankRow!]!
    pnrrComponents: [PnrrComponent!]!
    pnrrMeasures(filter: PnrrMeasuresFilter): [PnrrMeasure!]!
    pnrrProgramIndicators: [PnrrProgramIndicator!]!
    "Resolve a free-text query to a filter value (name→CUI, label→component, etc.)."
    pnrrResolve(dim: PnrrResolveDim!, q: String!, limit: Int = 10): [PnrrResolveHit!]!
  }

  extend type Entity {
    "PNRR rollup for this entity by CUI (via the cross-source contributor)."
    pnrr: PnrrEntityProfile
  }
`;

export const pnrrTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
