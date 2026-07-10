/**
 * Procurement module — GraphQL SDL slice.
 *
 * This is the CLIENT CONTRACT (docs/design/procurement/graphql-api-spec.md in the
 * client repo), hand-authored. The kernel's `toGraphQLInput(spec)` generator cannot
 * express it: it emits `between: { from, to }`-style operator objects, whereas the
 * contract asks for `{ gte, lte }`, a `q: { contains }` facet, and per-grain filter
 * inputs. `shell/graphql/arg-translation.ts` lowers the contract's inputs onto the
 * core filter types.
 *
 * Money and bigint counts are `String` (decimal strings; §14.1 precision), matching
 * the client's Zod schemas literally. `Date` is the kernel's `YYYY-MM-DD` scalar.
 *
 * The analyst/agent surface (`procurementRepeatedPairs`, `procurementConcentration`,
 * `procurementAuthorityCpvSpend`, `procurementTopSuppliersByRegionCpv`,
 * `procurementSameDayCandidates`, `procurementResolve`, `extend type Entity`) is
 * UNCHANGED — the MCP tools resolve through the same usecases.
 */

export const procurementTypeDefs = /* GraphQL */ `
  enum ProcurementGrain {
    direct_acquisition
    procurement_contract
  }
  enum ProcurementResolveDim {
    authority
    supplier
    cpvDivision
    cpv
    region
    county
  }
  enum ProcurementSort {
    date_desc
    date_asc
    value_desc
    value_asc
  }

  "A counterparty as the procurement source records it (no identity join)."
  type ProcurementParty {
    cui: String
    name: String
    displayName: String
  }

  input StringEqInput {
    eq: String!
  }
  input StringInInput {
    in: [String!]!
  }
  "Server-bounded ILIKE (3–100 chars) over the grain's title/number columns."
  input StringQInput {
    contains: String!
  }
  input DateRangeInput {
    gte: Date
    lte: Date
  }
  "RON decimal strings — never floats."
  input DecimalRangeInput {
    gte: String
    lte: String
  }

  # ── grain nodes ─────────────────────────────────────────────────────────────

  "A tender/notice lifecycle row (e-licitatie CA ∪ SEAP notices)."
  type ProcurementProcedure {
    id: ID!
    noticeNo: String
    noticeKind: String
    procedureType: String
    contractKind: String
    title: String
    authority: ProcurementParty!
    cpvCode: String
    cpvDivisionCode: String
    estimatedValueRon: String
    awardedValueRon: String
    currency: String
    isRon: Boolean!
    valueSuspect: Boolean!
    status: String!
    countyName: String
    publicationDate: Date
    stateDate: Date
    sourceSystem: String!
    sourceUrl: String
    "Always true: procurement.procedures carries no dedup columns."
    isCanonical: Boolean!
    "Always null: procurement.procedures carries no dup_group_id."
    dupGroupId: String
  }

  "A supplier-level award (SEAP contracts ∪ e-licitatie CA awards)."
  type ProcurementContract {
    id: ID!
    contractNo: String
    contractDate: Date
    procedureId: ID
    noticeNo: String
    title: String
    authority: ProcurementParty!
    supplier: ProcurementParty!
    cpvCode: String
    cpvDivisionCode: String
    valueRon: String
    estimatedValueRon: String
    currency: String
    isRon: Boolean!
    valueSuspect: Boolean!
    status: String!
    sourceSystem: String!
    sourceUrl: String
    isCanonical: Boolean!
    dupGroupId: String
    "The modification trail, modificationDate ascending."
    modifications: [ProcurementContractModification!]!
  }

  "A catalog buy (e-licitatie DA + SEAP DA/DAN; the 26M-row grain)."
  type ProcurementDirectAcquisition {
    id: ID!
    uniqueCode: String
    title: String
    authority: ProcurementParty!
    supplier: ProcurementParty!
    cpvCode: String
    cpvDivisionCode: String
    valueRon: String
    estimatedValueRon: String
    currency: String
    isRon: Boolean!
    valueSuspect: Boolean!
    status: String!
    countyName: String
    publicationDate: Date
    finalizationDate: Date
    sourceSystem: String!
    sourceUrl: String
    isCanonical: Boolean!
    dupGroupId: String
  }

  "A SEAP contract modification. valueDeltaRon may be negative."
  type ProcurementContractModification {
    id: ID!
    contractId: ID
    linkMethod: String
    linkConfidence: Float
    modificationDate: Date
    valueBeforeRon: String
    valueAfterRon: String
    valueDeltaRon: String
    modificationType: String
    authority: ProcurementParty!
    supplier: ProcurementParty!
    contractNo: String
    noticeNo: String
    sourceUrl: String
    "Null when the modification could not be linked to a contract."
    parentContract: ProcurementContract
  }

  # ── search (offset) ─────────────────────────────────────────────────────────

  input ProcurementProceduresFilter {
    q: StringQInput
    authorityCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    sourceSystem: StringInInput
    status: StringInInput
    publicationDate: DateRangeInput
    "Bounds awardedValueRon."
    valueRon: DecimalRangeInput
  }

  input ProcurementContractsFilter {
    q: StringQInput
    authorityCui: StringEqInput
    supplierCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    sourceSystem: StringInInput
    status: StringInInput
    contractDate: DateRangeInput
    valueRon: DecimalRangeInput
  }

  """
  The 26M-row grain. A search REQUIRES authorityCui, supplierCui, or a fully-bounded
  publicationDate range of ≤ 366 days: nothing else bounds the rows the planner must
  sort. CPV and q refine such a filter but cannot stand alone.
  publicationDate binds to finalization_date (publication_date is NULL on elicitatie_da).
  """
  input ProcurementDirectAcquisitionsFilter {
    q: StringQInput
    authorityCui: StringEqInput
    supplierCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    sourceSystem: StringInInput
    status: StringInInput
    publicationDate: DateRangeInput
    valueRon: DecimalRangeInput
  }

  input ProcurementModificationsFilter {
    q: StringQInput
    authorityCui: StringEqInput
    supplierCui: StringEqInput
    modificationDate: DateRangeInput
    "contractId IS (NOT) NULL."
    linked: Boolean
    "value_delta_ron / nullif(value_before_ron, 0) >= pct."
    minDeltaPct: Float
  }

  """
  \`total\` is null when the exact count exceeds 10 000 OR the count timed out;
  \`totalEstimated\` then marks it. Clients render "10000+".
  """
  type ProcurementProceduresPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementProcedure!]!
  }
  type ProcurementContractsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementContract!]!
  }
  type ProcurementDirectAcquisitionsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementDirectAcquisition!]!
  }
  type ProcurementModificationsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementContractModification!]!
  }

  # ── detail bundles ──────────────────────────────────────────────────────────

  "A dedup-suppressed sibling of this canonical row."
  type ProcurementDuplicateRef {
    sourceSystem: String!
    id: ID!
  }

  type ProcurementLotWinner {
    lotLabel: String!
    winner: ProcurementParty!
    valueRon: String
    currency: String
    isRon: Boolean!
    valueSuspect: Boolean!
  }

  "The EU Tenders-Electronic-Daily notice. ~9% of procedures carry one."
  type ProcurementTedRef {
    tedNoticeNo: String!
    sourceUrl: String!
  }

  type ProcurementProcedureDetail {
    procedure: ProcurementProcedure!
    "Canonical contracts awarded under this procedure."
    contracts: [ProcurementContract!]!
    "Always null in v1: procedure_lots carries no winner identity and no awarded value."
    perLotWinners: [ProcurementLotWinner!]
    "Always empty: procedures carry no dup_group_id."
    duplicates: [ProcurementDuplicateRef!]!
    ted: ProcurementTedRef
    gate: ProcurementCapabilityGate!
  }

  type ProcurementContractDetail {
    contract: ProcurementContract!
    procedure: ProcurementProcedure
    duplicates: [ProcurementDuplicateRef!]!
    "Inherited from the contract's procedure; contracts carry no direct TED link."
    ted: ProcurementTedRef
    gate: ProcurementCapabilityGate!
  }

  type ProcurementDirectAcquisitionDetail {
    directAcquisition: ProcurementDirectAcquisition!
    duplicates: [ProcurementDuplicateRef!]!
    gate: ProcurementCapabilityGate!
  }

  # ── aggregates (one shared scope) ───────────────────────────────────────────

  """
  Empty scope = platform-wide. \`cpvCode\` is rejected in v1: the monthly rollups are
  keyed on the 2-digit division. Months are \`YYYY-MM\`.
  """
  input ProcurementScopeFilter {
    authorityCui: String
    supplierCui: String
    cpvDivision: String
    cpvCode: String
    monthFrom: String
    monthTo: String
  }

  type ProcurementStats {
    "Sums only the in-scope grains whose spend the gate approves; null when none is."
    totalValueRon: String
    contractsCount: String!
    directAcquisitionsCount: String!
    proceduresCount: String!
    buyersCount: String!
    suppliersCount: String!
    firstFlowDate: Date
    lastFlowDate: Date
  }

  "One ranked counterparty ON ONE GRAIN. Rows from different grains are never summed."
  type ProcurementTopPartyRow {
    authority: ProcurementParty
    supplier: ProcurementParty
    sourceGrain: String!
    flowCount: String!
    amountRonSum: String
    amountPresentCount: String!
    amountMissingCount: String!
    firstFlowDate: Date
    lastFlowDate: Date
    evidenceRefsSample: [String!]!
  }

  type ProcurementCategoryRow {
    cpvDivisionCode: String
    cpvDivisionLabelEn: String
    cpvDivisionLabelRo: String
    sourceGrain: String!
    flowCount: String!
    amountRonSum: String
    amountPresentCount: String!
    amountMissingCount: String!
  }

  "One point per month. flowCount spans every in-scope grain; the amounts only the spend-approved ones."
  type ProcurementMonthlyPoint {
    month: String!
    flowCount: String!
    amountRonSum: String
    amountPresentCount: String!
    amountMissingCount: String!
  }

  # ── supplier records (cursor over two tables, merged) ────────────────────────

  union ProcurementFlowRecord = ProcurementContract | ProcurementDirectAcquisition

  type ProcurementPageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }
  type ProcurementRecordEdge {
    cursor: String!
    node: ProcurementFlowRecord!
  }
  type ProcurementRecordConnection {
    "Always null: an exact count over a 3.3M and a 26M-row table is not affordable."
    total: Int
    edges: [ProcurementRecordEdge!]!
    pageInfo: ProcurementPageInfo!
  }

  # ── meta ────────────────────────────────────────────────────────────────────

  """
  The per-grain capability gate, read live. \`cadence\` is always null — nothing
  declares a refresh schedule and the matviews demonstrably drift; \`dataAsOf\`
  (the matview refresh watermark) carries the freshness truth instead.
  """
  type ProcurementCapabilityGate {
    sourceGrain: String!
    rowsCount: String!
    authorityCuiCoverageRate: String!
    supplierCuiCoverageRate: String!
    amountCoverageRate: String!
    cpvCoverageRate: String!
    dateCoverageRate: String!
    filterAnswersAllowed: Boolean!
    spendRankingsAllowed: Boolean!
    supplierRegionFiltersAllowed: Boolean!
    blockers: [String!]!
    dataAsOf: Date
    cadence: String
  }

  "Official CPV-2008 division (2-digit). The ONLY reliable CPV hierarchy (cpv_codes is corrupt)."
  type ProcurementCpvDivision {
    divisionCode: String!
    labelEn: String!
    labelRo: String
  }

  "A name→value discovery hit (Entity Resolution Gate output)."
  type ProcurementResolveHit {
    dim: String!
    value: String!
    label: String!
    kind: String!
    score: Float
  }

  # ── the retained analyst / MCP surface ──────────────────────────────────────

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

  type ProcurementEdgeResult {
    grain: ProcurementGrain!
    items: [ProcurementEdge!]!
    caveats: [String!]!
    refreshedAt: DateTime
    projectionVersion: String
  }
  type ProcurementAuthorityCpvResult {
    grain: ProcurementGrain!
    items: [ProcurementAuthorityCpvRow!]!
    caveats: [String!]!
    refreshedAt: DateTime
  }
  type ProcurementSupplierCpvResult {
    grain: ProcurementGrain!
    items: [ProcurementSupplierCpvRow!]!
    caveats: [String!]!
  }

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
    # search (offset; page * pageSize ≤ 10 000)
    procurementProcedures(
      filter: ProcurementProceduresFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
    ): ProcurementProceduresPage!
    procurementContracts(
      filter: ProcurementContractsFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
    ): ProcurementContractsPage!
    procurementDirectAcquisitions(
      filter: ProcurementDirectAcquisitionsFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
    ): ProcurementDirectAcquisitionsPage!
    procurementModifications(
      filter: ProcurementModificationsFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
    ): ProcurementModificationsPage!

    # detail (null for an unknown id)
    procurementProcedure(id: ID!): ProcurementProcedureDetail
    procurementContract(id: ID!): ProcurementContractDetail
    procurementDirectAcquisition(id: ID!): ProcurementDirectAcquisitionDetail

    # aggregates — the same 5 queries serve the landing page (empty scope), the CPV
    # category page ({ cpvDivision }) and the supplier slice ({ supplierCui }).
    # \`grain\` is procurement_contract | direct_acquisition | null (= both).
    procurementStats(scope: ProcurementScopeFilter, grain: String): ProcurementStats!
    procurementTopAuthorities(
      scope: ProcurementScopeFilter
      grain: String
      topN: Int
    ): [ProcurementTopPartyRow!]!
    procurementTopSuppliers(
      scope: ProcurementScopeFilter
      grain: String
      topN: Int
    ): [ProcurementTopPartyRow!]!
    procurementCategoryBreakdown(
      scope: ProcurementScopeFilter
      grain: String
    ): [ProcurementCategoryRow!]!
    procurementSpendOverTime(
      scope: ProcurementScopeFilter
      grain: String
    ): [ProcurementMonthlyPoint!]!

    # supplier recent records (canonical flows only, date desc)
    procurementSupplierRecords(
      supplierCui: ID!
      first: Int
      after: String
    ): ProcurementRecordConnection!

    # meta
    procurementGrainQuality: [ProcurementCapabilityGate!]!
    procurementCpvDivisions: [ProcurementCpvDivision!]!
    procurementResolve(
      dim: ProcurementResolveDim!
      q: String!
      limit: Int = 10
    ): [ProcurementResolveHit!]!

    # analyst / MCP surface (unchanged)
    "PC-6: repeated buyer↔supplier pairs anchored on one side."
    procurementRepeatedPairs(
      authorityCui: CUI
      supplierCui: CUI
      grain: ProcurementGrain = direct_acquisition
      minMonths: Int = 2
      topN: Int = 20
    ): ProcurementEdgeResult!
    "PC-5: supplier concentration / HHI for an authority (count-based when spend gate-suppressed)."
    procurementConcentration(
      authorityCui: CUI!
      grain: ProcurementGrain = direct_acquisition
      monthFrom: Date
      monthTo: Date
    ): ProcurementConcentration!
    "PC-4: authority spend by CPV division × period."
    procurementAuthorityCpvSpend(
      authorityCui: CUI!
      grain: ProcurementGrain = direct_acquisition
      cpvDivision: [String!]
      monthFrom: Date
      monthTo: Date
      topN: Int = 50
    ): ProcurementAuthorityCpvResult!
    "PC-2: top suppliers to a (buyer) region × CPV division."
    procurementTopSuppliersByRegionCpv(
      region: String!
      cpvDivision: String!
      grain: ProcurementGrain = direct_acquisition
      monthFrom: Date
      monthTo: Date
      topN: Int = 20
    ): ProcurementSupplierCpvResult!
    "PC-7: same-day DA splitting candidates (requires authorityCui or a date window)."
    procurementSameDayCandidates(
      authorityCui: CUI
      dateFrom: Date
      dateTo: Date
      cpvDivision: String
      minSameDayCount: Int = 2
      page: Int = 1
      pageSize: Int = 20
    ): [ProcurementSameDayCandidate!]!
  }

  extend type Entity {
    "Procurement rollup for this entity by CUI (via the cross-source contributor; grain-separated)."
    procurement: ProcurementEntitySummary
  }
`;
