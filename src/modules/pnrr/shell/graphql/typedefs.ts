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
  pnrrProjectsFilterSpec,
} from '../../core/filters.js';

const filterInputs = [
  pnrrEntitiesFilterSpec,
  pnrrPaymentsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrProjectsFilterSpec,
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
    unknown
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
    relationships
  }
  enum PnrrResolveDim {
    entity
    component
    measure
    county
    contractor
  }
  enum PnrrAnswerState {
    served
    degraded
    abstained
    legacy_unversioned
  }
  enum PnrrGrain {
    program
    payment
    commitment
    progress_observation
    organization
    place
    verification
  }
  enum PnrrAnalysisMeasure {
    count
    amount
    progress
    coverage
  }
  enum PnrrTimeRole {
    payment_date
    commitment_date
    snapshot_date
    retrieved_at
  }
  enum PnrrGeographyRole {
    beneficiary_county
    implementation_county
    inferred_uat
  }
  input PnrrAnalysisScopeInput {
    grain: PnrrGrain
    measure: PnrrAnalysisMeasure
    componentCode: String
    beneficiaryCui: CUI
    countySiruta: SIRUTA
    from: Date
    to: Date
    timeRole: PnrrTimeRole
    geographyRole: PnrrGeographyRole
    currency: String
    resolutionPolicyVersion: String
  }
  type PnrrAnalysisScope {
    grain: PnrrGrain!
    measure: PnrrAnalysisMeasure!
    componentCode: String
    beneficiaryCui: CUI
    countySiruta: SIRUTA
    from: Date
    to: Date
    timeRole: PnrrTimeRole!
    geographyRole: PnrrGeographyRole!
    currency: String
    resolutionPolicyVersion: String!
  }
  type PnrrCoverage {
    field: String!
    covered: Int!
    total: Int!
    percent: Float
  }
  type PnrrLaneFreshness {
    lane: String!
    state: PnrrAnswerState!
    asOf: DateTime
    suspended: Boolean!
    reasonCodes: [String!]!
  }
  type PnrrRelease {
    releaseId: ID!
    releaseKind: String!
    state: PnrrAnswerState!
    sourceSnapshotAt: DateTime
    completedAt: DateTime
    lanes: [PnrrLaneFreshness!]!
    limitation: String!
  }
  type PnrrCapability {
    id: ID!
    releaseId: ID!
    state: PnrrAnswerState!
    reasonCodes: [String!]!
    limitation: String
  }
  type PnrrAnswerMeta {
    scope: PnrrAnalysisScope!
    state: PnrrAnswerState!
    reasonCodes: [String!]!
    coverage: [PnrrCoverage!]!
    release: PnrrRelease!
    caveats: [String!]!
    provenance: [String!]!
  }
  type PnrrMoneyFact {
    factType: String!
    amount: Money
    currency: String!
    aggregationState: String!
    coveredCount: Int!
    totalCount: Int!
  }
  type PnrrProgramOverview {
    snapshotDate: Date
    projectCount: Int
    allocationEur: PnrrMoneyFact!
    receivedEur: PnrrMoneyFact!
    paidEur: PnrrMoneyFact!
  }
  type PnrrPaymentOverview {
    count: Int!
    netRon: PnrrMoneyFact!
    grossRon: PnrrMoneyFact!
    reversalRon: PnrrMoneyFact!
    firstDate: Date
    lastDate: Date
  }
  type PnrrCommitmentOverview {
    count: Int!
    additiveCount: Int!
    unresolvedCount: Int!
    additiveRon: PnrrMoneyFact!
  }
  type PnrrDeliveryOverview {
    observedCount: Int!
    completedCount: Int!
    overHundredCount: Int!
    missingFinancialProgressCount: Int!
    missingPhysicalProgressCount: Int!
  }
  type PnrrOverview {
    meta: PnrrAnswerMeta!
    program: PnrrProgramOverview!
    beneficiaryPayments: PnrrPaymentOverview!
    commitments: PnrrCommitmentOverview!
    delivery: PnrrDeliveryOverview!
  }
  type PnrrPlaceProfile {
    meta: PnrrAnswerMeta!
    countySiruta: SIRUTA!
    countyName: String
    paymentCount: Int!
    paymentNetRon: Money
    commitmentCount: Int!
    additiveCommitmentCount: Int!
    unresolvedCommitmentCount: Int!
    additiveCommitmentRon: Money
    projectObservationCount: Int!
    sourceLocalityLabelCount: Int!
    sourceLocalityLabelValue: Money
  }

  type PnrrPlaceSummary {
    countySiruta: SIRUTA!
    countyName: String!
    paymentCount: Int!
    paymentNetRon: Money
    commitmentCount: Int!
    additiveCommitmentCount: Int!
    unresolvedCommitmentCount: Int!
    additiveCommitmentRon: Money
    projectObservationCount: Int!
    sourceLocalityLabelCount: Int!
    sourceLocalityLabelValue: Money
  }
  type PnrrVerificationSummary {
    meta: PnrrAnswerMeta!
    ruleSetVersion: String!
    unresolvedCommitmentCount: Int!
    duplicatePaymentGroupCount: Int!
    missingCommitmentSourceUrlCount: Int!
    endBeforeStartCount: Int!
    overHundredProgressCount: Int!
    missingProgressLinkCount: Int!
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
    "Legacy count retained for compatibility. Prefer participantRelationCount."
    wonAsContractor: Int!
    "Legacy money retained for compatibility; null while acquisition values are unresolved."
    wonValue: Money
    participantRelationCount: Int!
    unknownRelationshipCount: Int!
    participantValue: Money
    valueAggregationState: String!
    valueReason: String!
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
    contractTitle: String
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
    startDate: Date
    endDate: Date
    status: String!
    countyName: String
    countySiruta: SIRUTA
    localityName: String
    sourceSystem: String
    sourceUrl: String
    aggregationState: String!
    envelopeObservationCount: Int!
    qualityIssues: [String!]!
    dateQuality: String!
    reportedTotalValue: Money
    reportedEuValue: Money
    "Number of MIPE progress snapshots for this commitment's contract."
    progressCount: Int!
    "The most recent progress snapshot explicitly linked to this commitment, or null."
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

  "A public MIPE project-progress observation. Progress fields are ratios: 1 means 100%."
  type PnrrProject {
    projectKey: ID!
    projectKeyVersion: String!
    sourceObservationId: ID!
    snapshotId: ID!
    snapshotDate: Date!
    endpointName: String!
    itemKey: String
    commitmentBusinessId: String
    contractNumber: String
    contractTitle: String
    beneficiaryCui: CUI
    beneficiaryName: String
    beneficiaryType: String
    componentCode: String
    measureCode: String
    submeasureCode: String
    responsibleInstitutionCode: String
    responsibleInstitutionName: String
    financingSource: String
    commitmentDate: Date
    startDate: Date
    endDate: Date
    lastFundingDate: Date
    totalValueRon: Money
    euContributionRon: Money
    nationalPublicValueRon: Money
    vatRon: Money
    ineligibleValueRon: Money
    receivedAmountRon: Money
    allocatedEur: Money
    paidEur: Money
    receivedEur: Money
    prefinancingEur: Money
    suspendedEur: Money
    revokedEur: Money
    projectCount: Float
    contractBeneficiaryCount: Float
    paymentBeneficiaryCount: Float
    nationalImpactProjectCount: Float
    paymentCount: Float
    beneficiaryCount: Float
    totalEur: Money
    totalRon: Money
    financialProgressRatio: Float
    physicalProgressRatio: Float
    countyName: String
    countySiruta: SIRUTA
    localityName: String
    impact: String
    timelineMonth: String
    timelineLabel: String
    status: String
    sourceSystem: String!
    sourceUrl: String!
    retrievedAt: DateTime!
    linkedCommitmentKey: ID
    commitmentRelationship: String
    commitmentAggregationState: String
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
    "reported_unresolved only on the dedicated detail query; otherwise null."
    valueAggregationState: String!
    valueReason: String!
    currency: String
    awardCriterion: String
    frameworkAgreement: Boolean
    hasAssociationLeader: Boolean
    hasThirdPartySupport: Boolean
    hasSubcontractor: Boolean
    "Number of source participant relationships on this acquisition."
    contractorCount: Int!
    retrievedAt: DateTime
    "Bounded child: source participant relationships for this acquisition."
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
    sourceRole: String!
    contractorCui: CUI
    contractorName: String
    contractorCountry: String
    contractValue: Money
    "reported_unresolved only inside acquisition detail; otherwise null."
    valueAggregationState: String!
    valueReason: String!
    currency: String
    confidence: String
    validationStatus: String
  }

  type PnrrContractorRankRow {
    contractorCui: CUI
    contractorName: String
    "Legacy count retained for compatibility. Prefer participantRelationCount."
    awardCount: Int!
    participantRelationCount: Int!
    unknownRelationshipCount: Int!
    totalValue: Money
    valueAggregationState: String!
    valueReason: String!
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
  type PnrrProjectConnection {
    edges: [PnrrProjectEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrProjectEdge {
    node: PnrrProject!
    cursor: String!
  }
  type PnrrProjectFacetValue {
    value: String!
    label: String
    count: Int!
  }
  type PnrrProjectFacets {
    totalCount: Int!
    components: [PnrrProjectFacetValue!]!
    measures: [PnrrProjectFacetValue!]!
    statuses: [PnrrProjectFacetValue!]!
    counties: [PnrrProjectFacetValue!]!
  }
  type PnrrFundingCall {
    callId: ID!
    title: String!
    budgetRon: Money
    totalEligibleValueRon: Money
    sourceSystem: String!
    sourceUrl: String!
    retrievedAt: DateTime!
  }
  type PnrrFundingCallConnection {
    edges: [PnrrFundingCallEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrFundingCallEdge {
    node: PnrrFundingCall!
    cursor: String!
  }
  type PnrrFundingApplicationListing {
    listingId: ID!
    listingCandidateKey: ID!
    callId: ID
    sourceRequestCallId: ID
    applicantCui: CUI
    applicantName: String
    sentAt: DateTime
    orderNumber: String
    completenessStatus: String!
    sourceSystem: String!
    sourceUrl: String!
    retrievedAt: DateTime!
  }
  type PnrrFundingApplicationListingConnection {
    edges: [PnrrFundingApplicationListingEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrFundingApplicationListingEdge {
    node: PnrrFundingApplicationListing!
    cursor: String!
  }
  type PnrrProgramRevision {
    revisionId: ID!
    identifierScheme: String!
    legalReference: String!
    celex: String
    legalStatus: String!
    isCurrentAdopted: Boolean!
    effectiveDate: Date
    sourceAuthority: String!
    sourceUrl: String!
    documentCount: Int!
    textReadyDocumentCount: Int!
    ocrRequiredDocumentCount: Int!
  }
  type PnrrProgramRevisionConnection {
    edges: [PnrrProgramRevisionEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrProgramRevisionEdge {
    node: PnrrProgramRevision!
    cursor: String!
  }
  type PnrrCatalogResource {
    resourceId: ID!
    packageId: ID
    resourceName: String
    format: String
    mimeType: String
    datastoreActive: Boolean
    fileUrl: String
    lastModified: DateTime
    declaredHash: String
    sourceSystem: String!
    sourceUrl: String!
    retrievedAt: DateTime!
  }
  type PnrrCatalogResourceConnection {
    edges: [PnrrCatalogResourceEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrCatalogResourceEdge {
    node: PnrrCatalogResource!
    cursor: String!
  }
  type PnrrDocumentReference {
    documentKey: ID!
    acquisitionKey: ID
    lotKey: ID
    announcementKey: ID
    programRevisionId: ID
    language: String
    documentRole: String
    fileName: String
    mimeType: String
    documentType: String
    sourceUrl: String!
    retrievedAt: DateTime
    contentSha256: String
    extractionState: String!
    hasObjectCustody: Boolean!
  }
  type PnrrDocumentReferenceConnection {
    edges: [PnrrDocumentReferenceEdge!]!
    pageInfo: PageInfo!
  }
  type PnrrDocumentReferenceEdge {
    node: PnrrDocumentReference!
    cursor: String!
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
    pnrrCurrentRelease: PnrrRelease!
    pnrrCapabilities(assertReleaseId: ID): [PnrrCapability!]!
    pnrrOverview(scope: PnrrAnalysisScopeInput, assertReleaseId: ID): PnrrOverview!
    "PNRR entity directory (CUI spine). Default sort cui asc."
    pnrrEntities(
      filter: PnrrEntitiesFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrEntityConnection!
    pnrrEntity(cui: CUI!, assertReleaseId: ID): PnrrEntity
    pnrrEntityProfile(cui: CUI!, assertReleaseId: ID): PnrrEntityProfile
    "Source-native PNRR cash disbursements. Needs an indexed driving predicate."
    pnrrPayments(
      filter: PnrrPaymentsFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrPaymentConnection!
    pnrrPaymentAggregate(
      filter: PnrrPaymentsFilter
      groupBy: PnrrPaymentGroupBy!
      assertReleaseId: ID
    ): [PnrrPaymentAggRow!]!
    pnrrCommitments(
      filter: PnrrCommitmentsFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrCommitmentConnection!
    pnrrProjects(
      filter: PnrrProjectsFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrProjectConnection!
    pnrrProject(key: ID!, assertReleaseId: ID): PnrrProject
    pnrrProjectHistory(key: ID!, assertReleaseId: ID): [PnrrProject!]!
    pnrrProjectFacets(filter: PnrrProjectsFilter, assertReleaseId: ID): PnrrProjectFacets!
    pnrrFundingCalls(
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrFundingCallConnection!
    pnrrFundingApplicationListings(
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrFundingApplicationListingConnection!
    pnrrProgramRevisions(
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrProgramRevisionConnection!
    pnrrCatalogResources(
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrCatalogResourceConnection!
    pnrrDocumentReferences(
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrDocumentReferenceConnection!
    pnrrCommitment(key: ID!, assertReleaseId: ID): PnrrCommitment
    "MIPE progress series for one commitment (bounded; resilient to unlinked snapshots)."
    pnrrCommitmentProgress(commitmentKey: ID!, assertReleaseId: ID): [PnrrCommitmentSnapshot!]!
    pnrrAcquisitions(
      filter: PnrrAcquisitionsFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrAcquisitionConnection!
    pnrrAcquisition(key: ID!, assertReleaseId: ID): PnrrAcquisitionDetail
    pnrrContractors(
      filter: PnrrContractorsFilter
      first: Int = 20
      after: String
      assertReleaseId: ID
    ): PnrrContractorConnection!
    "PNRR organizations ranked by participant-relation count; role policy and money unavailable."
    pnrrContractorRank(
      filter: PnrrContractorsFilter
      by: PnrrContractorRankBy = relationships
      limit: Int = 20
      assertReleaseId: ID
    ): [PnrrContractorRankRow!]!
    pnrrComponents(assertReleaseId: ID): [PnrrComponent!]!
    pnrrMeasures(filter: PnrrMeasuresFilter, assertReleaseId: ID): [PnrrMeasure!]!
    pnrrProgramIndicators(assertReleaseId: ID): [PnrrProgramIndicator!]!
    pnrrPlace(
      countySiruta: SIRUTA!
      scope: PnrrAnalysisScopeInput
      assertReleaseId: ID
    ): PnrrPlaceProfile
    pnrrPlaces(scope: PnrrAnalysisScopeInput, assertReleaseId: ID): [PnrrPlaceSummary!]!
    pnrrVerification(scope: PnrrAnalysisScopeInput, assertReleaseId: ID): PnrrVerificationSummary!
    "Resolve a free-text query to a filter value (name→CUI, label→component, etc.)."
    pnrrResolve(
      dim: PnrrResolveDim!
      q: String!
      limit: Int = 10
      assertReleaseId: ID
    ): [PnrrResolveHit!]!
  }

  extend type Entity {
    "PNRR rollup for this entity by CUI (via the cross-source contributor)."
    pnrr: PnrrEntityProfile
  }
`;

export const pnrrTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
