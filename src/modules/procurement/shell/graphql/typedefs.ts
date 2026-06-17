/**
 * Procurement module — GraphQL SDL slice (plan §6). All types `Procurement`-
 * prefixed (§14.8); extends root `Query` + `type Entity`. Filter inputs are
 * GENERATED from the §7 specs via `toGraphQLInput(spec)` so the surfaces never
 * drift. Fact lists are Relay connections (cursor, NO COUNT on 20M rows). Aggregates
 * are bounded top-N lists carrying the grain + caveats + as-of watermark. The DA
 * connection's `filter` arg is NON-NULL to structurally signal the selective-filter
 * rule (the runtime `requiresSelective` check still enforces it — a `{}` wrapper trips it).
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import {
  contractFilterSpec,
  daFilterSpec,
  modificationFilterSpec,
  procedureFilterSpec,
} from '../../core/filters.js';

const filterInputs = [procedureFilterSpec, contractFilterSpec, daFilterSpec, modificationFilterSpec]
  .map((spec) => toGraphQLInput(spec))
  .join('\n\n');

const objectsAndQuery = /* GraphQL */ `
  enum ProcurementGrain { direct_acquisition procurement_contract }
  enum ProcurementProcedureStatus { published in_evaluation awarded cancelled suspended unknown }
  enum ProcurementContractStatus { awarded in_progress closed cancelled unknown }
  enum ProcurementDaStatus { offered awarded finalized cancelled unknown }
  enum ProcurementDaSourceSystem { elicitatie_da seap_da seap_dan }
  enum ProcurementResolveDim { authority supplier cpvDivision cpv region county }

  "Official CPV-2008 division (2-digit). The ONLY reliable CPV hierarchy (cpv_codes is corrupt)."
  type ProcurementCpvDivision { code: String! labelEn: String! labelRo: String }

  "A name→value discovery hit (Entity Resolution Gate output)."
  type ProcurementResolveHit { value: String! label: String kind: String! confidence: Float! }

  "A tender/notice lifecycle row (e-licitatie CA ∪ SEAP notices)."
  type ProcurementProcedure {
    procedureId: ID!
    noticeNo: String
    noticeKind: String
    procedureType: String
    contractKind: String
    title: String
    authority: Entity
    authorityCui: CUI
    authorityName: String
    cpvCode: String
    cpvDivision: ProcurementCpvDivision
    estimatedValueRon: Money
    awardedValueRon: Money
    "True iff the value columns are RON (non-RON rows have value_ron nulled — audit F1/F7)."
    isRon: Boolean!
    valueSuspect: Boolean!
    status: ProcurementProcedureStatus!
    countyName: String
    publicationDate: Date
    stateDate: Date
  }

  "A supplier-level award (SEAP contracts family)."
  type ProcurementContract {
    contractId: ID!
    contractKey: String!
    procedureId: ID
    noticeNo: String
    contractNo: String
    contractDate: Date
    title: String
    authority: Entity
    supplier: Entity
    authorityCui: CUI
    authorityName: String
    supplierCui: CUI
    supplierName: String
    cpvCode: String
    cpvDivision: ProcurementCpvDivision
    valueRon: Money
    estimatedValueRon: Money
    isRon: Boolean!
    valueSuspect: Boolean!
    status: ProcurementContractStatus!
    countyName: String
    isCanonical: Boolean!
    dupGroupId: ID
    modifications: [ProcurementModification!]!
  }

  "A catalog buy (elicitatie DA + SEAP DA/DAN; the high-volume grain)."
  type ProcurementDirectAcquisition {
    daId: ID!
    daKey: String!
    sourceSystem: ProcurementDaSourceSystem!
    uniqueCode: String
    title: String
    authority: Entity
    supplier: Entity
    authorityCui: CUI
    authorityName: String
    supplierCui: CUI
    supplierName: String
    cpvCode: String
    cpvDivision: ProcurementCpvDivision
    valueRon: Money
    estimatedValueRon: Money
    isRon: Boolean!
    valueSuspect: Boolean!
    status: ProcurementDaStatus!
    countyName: String
    publicationDate: Date
    finalizationDate: Date
    isCanonical: Boolean!
    dupGroupId: ID
  }

  "A SEAP contract modification (PC-8). deltaPct = delta / before."
  type ProcurementModification {
    modificationId: ID!
    contractId: ID
    linkMethod: String
    linkConfidence: Float
    authorityCui: CUI
    supplierCui: CUI
    contractNo: String
    noticeNo: String
    modificationDate: Date
    valueBeforeRon: Money
    valueAfterRon: Money
    valueDeltaRon: Money
    deltaPct: Float
    modificationType: String
    year: Int
  }

  "An authority↔supplier money edge (org_edge rollup; one grain)."
  type ProcurementEdge {
    authorityCui: CUI!
    authorityName: String
    supplierCui: CUI!
    supplierName: String
    grain: ProcurementGrain!
    flowCount: BigInt!
    amountRonSum: Money
    amountPresentCount: BigInt!
    amountMissingCount: BigInt!
    firstFlowDate: Date
    lastFlowDate: Date
    evidenceRefsSample: [String!]!
  }

  "Supplier concentration for one authority (PC-5). basis=count when spend is gate-suppressed."
  type ProcurementConcentration {
    authorityCui: CUI!
    grain: ProcurementGrain!
    supplierCount: Int!
    basis: String!
    top1Share: Float
    top5Share: Float
    hhi: Float
    totalRon: Money
    caveats: [String!]!
  }

  "Authority spend by CPV division × period (PC-4)."
  type ProcurementAuthorityCpvRow {
    authorityCui: CUI!
    cpvDivisionCode: String!
    cpvDivisionLabelEn: String
    grain: ProcurementGrain!
    flowCount: BigInt!
    amountRonSum: Money
    "Supplier-MONTH occurrences over the period (the MV is monthly-grained), NOT period-distinct suppliers."
    supplierMonthCount: BigInt!
    firstFlowDate: Date
    lastFlowDate: Date
  }

  "A supplier's total to a (buyer) region × CPV division, across all buyers (PC-2)."
  type ProcurementSupplierCpvRow {
    supplierCui: CUI!
    supplierName: String
    authorityRegion: String
    cpvDivisionCode: String!
    grain: ProcurementGrain!
    flowCount: BigInt!
    amountRonSum: Money
    distinctAuthorityCount: BigInt!
  }

  "A same-day direct-acquisition splitting CANDIDATE (PC-7; a review signal, NOT illegality)."
  type ProcurementSameDayCandidate {
    candidateDate: Date!
    authorityCui: CUI!
    authorityName: String
    supplierCui: CUI!
    supplierName: String
    cpvCode: String
    cpvDivisionCode: String
    sameDayCount: BigInt!
    sameDayTotalRon: Money
    maxSingleAmountRon: Money
    evidenceRefsSample: [String!]!
  }

  "The grain gate (aggregate_quality_by_grain) — what aggregate answers are allowed, read live."
  type ProcurementGrainQuality {
    grain: ProcurementGrain!
    rowsCount: BigInt!
    authorityCuiCoverageRate: Float!
    supplierCuiCoverageRate: Float!
    amountCoverageRate: Float!
    cpvCoverageRate: Float!
    dateCoverageRate: Float!
    authorityTerritoryCoverageRate: Float!
    filterAnswersAllowed: Boolean!
    spendRankingsAllowed: Boolean!
    supplierRegionFiltersAllowed: Boolean!
    blockers: [String!]!
    refreshedAt: DateTime
    projectionVersion: String!
  }

  # ── grain-labelled aggregate envelopes (carry the gate caveats + as-of) ──
  type ProcurementEdgeResult { grain: ProcurementGrain! items: [ProcurementEdge!]! caveats: [String!]! refreshedAt: DateTime projectionVersion: String }
  type ProcurementAuthorityCpvResult { grain: ProcurementGrain! items: [ProcurementAuthorityCpvRow!]! caveats: [String!]! refreshedAt: DateTime }
  type ProcurementSupplierCpvResult { grain: ProcurementGrain! items: [ProcurementSupplierCpvRow!]! caveats: [String!]! }

  # ── Relay connections (cursor parity with the repo; no COUNT) ──
  type ProcurementProcedureConnection { edges: [ProcurementProcedureEdge!]! pageInfo: PageInfo! }
  type ProcurementProcedureEdge { node: ProcurementProcedure! cursor: String! }
  type ProcurementContractConnection { edges: [ProcurementContractEdge!]! pageInfo: PageInfo! }
  type ProcurementContractEdge { node: ProcurementContract! cursor: String! }
  type ProcurementDirectAcquisitionConnection { edges: [ProcurementDirectAcquisitionEdge!]! pageInfo: PageInfo! }
  type ProcurementDirectAcquisitionEdge { node: ProcurementDirectAcquisition! cursor: String! }
  type ProcurementModificationConnection { edges: [ProcurementModificationEdge!]! pageInfo: PageInfo! }
  type ProcurementModificationEdge { node: ProcurementModification! cursor: String! }

  "Detail composites."
  type ProcurementProcedureDetail { procedure: ProcurementProcedure! contracts: [ProcurementContract!]! }
  type ProcurementContractDetail { contract: ProcurementContract! procedure: ProcurementProcedure modifications: [ProcurementModification!]! }

  # ── Entity-360 slice (via the contributor, §14.7) ──
  type ProcurementRoleSummary {
    contractCount: BigInt!
    daCount: BigInt!
    contractTotalRon: Money
    daTotalRon: Money
    top: [ProcurementEdge!]!
    rankBasis: String!
  }
  type ProcurementEntitySummary {
    cui: CUI!
    asAuthority: ProcurementRoleSummary!
    asSupplier: ProcurementRoleSummary!
    spendByCpvDivision: [ProcurementAuthorityCpvRow!]!
    caveats: [String!]!
    refreshedAt: DateTime
  }

  extend type Query {
    "A single procedure by id + its head contracts."
    procurementProcedure(id: ID!): ProcurementProcedure
    procurementProcedureDetail(id: ID!): ProcurementProcedureDetail
    "Procedures (cursor; index-bounded)."
    procurementProcedures(filter: ProcurementProcedureFilter, first: Int = 20, after: String): ProcurementProcedureConnection!
    "A single contract + its modifications + procedure."
    procurementContract(id: ID!): ProcurementContract
    procurementContractDetail(id: ID!): ProcurementContractDetail
    "Contracts (cursor; canonical-only by default)."
    procurementContracts(filter: ProcurementContractRowFilter, first: Int = 20, after: String): ProcurementContractConnection!
    "Direct acquisitions (cursor). A SELECTIVE filter is REQUIRED (20M rows) — \`filter\` is non-null + runtime-checked."
    procurementDirectAcquisitions(filter: ProcurementDirectAcquisitionFilter!, first: Int = 20, after: String): ProcurementDirectAcquisitionConnection!
    procurementDirectAcquisition(id: ID!): ProcurementDirectAcquisition
    "Modifications (cursor). \`minDeltaPct\` is PC-8 (value change ≥ pct)."
    procurementModifications(filter: ProcurementModificationFilter, minDeltaPct: Float, first: Int = 20, after: String): ProcurementModificationConnection!
    "PC-1: top suppliers of an authority (grain-scoped; gate-aware ordering)."
    procurementTopSuppliers(authorityCui: CUI!, grain: ProcurementGrain = direct_acquisition, monthFrom: Date, monthTo: Date, topN: Int = 20): ProcurementEdgeResult!
    "PC-3: top authorities buying from a supplier."
    procurementTopAuthorities(supplierCui: CUI!, grain: ProcurementGrain = direct_acquisition, monthFrom: Date, monthTo: Date, topN: Int = 20): ProcurementEdgeResult!
    "PC-6: repeated buyer↔supplier pairs anchored on one side."
    procurementRepeatedPairs(authorityCui: CUI, supplierCui: CUI, grain: ProcurementGrain = direct_acquisition, minMonths: Int = 2, topN: Int = 20): ProcurementEdgeResult!
    "PC-5: supplier concentration / HHI for an authority (count-based when spend gate-suppressed)."
    procurementConcentration(authorityCui: CUI!, grain: ProcurementGrain = direct_acquisition, monthFrom: Date, monthTo: Date): ProcurementConcentration!
    "PC-4: authority spend by CPV division × period."
    procurementAuthorityCpvSpend(authorityCui: CUI!, grain: ProcurementGrain = direct_acquisition, cpvDivision: [String!], monthFrom: Date, monthTo: Date, topN: Int = 50): ProcurementAuthorityCpvResult!
    "PC-2: top suppliers to a (buyer) region × CPV division."
    procurementTopSuppliersByRegionCpv(region: String!, cpvDivision: String!, grain: ProcurementGrain = direct_acquisition, monthFrom: Date, monthTo: Date, topN: Int = 20): ProcurementSupplierCpvResult!
    "PC-7: same-day DA splitting candidates (requires authorityCui or a date window)."
    procurementSameDayCandidates(authorityCui: CUI, dateFrom: Date, dateTo: Date, cpvDivision: String, minSameDayCount: Int = 2, page: Int = 1, pageSize: Int = 20): [ProcurementSameDayCandidate!]!
    "The grain gate (what aggregate answers are allowed; read live)."
    procurementGrainQuality: [ProcurementGrainQuality!]!
    "Official CPV divisions (the reliable 45-row hierarchy)."
    procurementCpvDivisions: [ProcurementCpvDivision!]!
    "Resolve a free-text query to a procurement filter value (name→CUI, label→CPV/region)."
    procurementResolve(dim: ProcurementResolveDim!, q: String!, limit: Int = 10): [ProcurementResolveHit!]!
  }

  extend type Entity {
    "Procurement rollup for this entity by CUI (via the cross-source contributor; grain-separated)."
    procurement: ProcurementEntitySummary
  }
`;

export const procurementTypeDefs = `${objectsAndQuery}\n\n${filterInputs}`;
