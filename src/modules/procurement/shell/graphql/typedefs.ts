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
 * The retained interface is record search/detail/supplier records, CPV discovery,
 * and the six generation-stamped analysis shapes. The old analyst queries, detail
 * gates, and Entity contributor were removed before deployment.
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

  """
  Value-model resolution (data-layer rules v2). valueRonComparable is the ONLY
  cross-row-comparable money; valueState explains why it is (not) present.
  Accepted states: official_exact, official_ron_equivalent, cross_source_exact,
  official_document_recovered. Others: source_missing, invalid_source_value,
  foreign_currency_only, ambiguous_grain (frameworks), conflicting_sources,
  not_applicable.
  """
  type ProcurementValueResolution {
    "Resolution state; null while a freshly loaded row awaits resolution."
    valueState: String
    "Engine rule label ('own_value', 'dup_group_rescue', 'framework_guard', …)."
    valueStateRule: String
    "True iff valueState is ACCEPTED (money is servable/comparable)."
    valueAccepted: Boolean!
    "Decimal string; basis 'official' (source) or 'derived_bnr' (BNR-converted)."
    valueRonComparable: String
    valueComparableBasis: String
    valueRulesVersion: Int
    valueResolvedAt: String
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
    status: String!
    countyName: String
    publicationDate: Date
    stateDate: Date
    value: ProcurementValueResolution!
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
    "The row's OWN parsed value evidence — compare rows via value.valueRonComparable."
    valueRon: String
    estimatedValueRon: String
    currency: String
    status: String!
    sourceSystem: String!
    sourceUrl: String
    isCanonical: Boolean!
    dupGroupId: String
    value: ProcurementValueResolution!
    "Winning evidence family when accepted ('seap_own' | 'elicitatie_ca_award' | 'dup_group')."
    canonicalValueSource: String
    "True when own/cross evidence disagrees (state 'conflicting_sources')."
    valueDisagreement: Boolean!
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
    "The row's OWN parsed value evidence — compare rows via value.valueRonComparable."
    valueRon: String
    estimatedValueRon: String
    currency: String
    status: String!
    countyName: String
    publicationDate: Date
    finalizationDate: Date
    value: ProcurementValueResolution!
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
    "Bounds the RESOLVED comparable value (value model)."
    valueRon: DecimalRangeInput
    "Value-model resolution states to include (e.g. the 4 accepted states)."
    valueState: StringInInput
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
    "Bounds the RESOLVED comparable value (value model)."
    valueRon: DecimalRangeInput
    "Value-model resolution states to include (e.g. the 4 accepted states)."
    valueState: StringInInput
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
    "Bounds the RESOLVED comparable value (value model)."
    valueRon: DecimalRangeInput
    "Value-model resolution states to include (e.g. the 4 accepted states)."
    valueState: StringInInput
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
  }

  type ProcurementContractDetail {
    contract: ProcurementContract!
    procedure: ProcurementProcedure
    duplicates: [ProcurementDuplicateRef!]!
    "Inherited from the contract's procedure; contracts carry no direct TED link."
    ted: ProcurementTedRef
  }

  type ProcurementDirectAcquisitionDetail {
    directAcquisition: ProcurementDirectAcquisition!
    duplicates: [ProcurementDuplicateRef!]!
  }

  # ── analysis surface (design §5 — one scope, six shapes, rollup-backed) ──────

  "Analysis grains, in the rollup vocabulary. Answers NEVER merge across grains."
  enum ProcurementAnalysisGrain {
    procedure
    contract
    direct_acquisition
  }

  enum ProcurementConcentrationBasis {
    count
    value
  }
  enum ProcurementAnswerability {
    served
    degraded
    abstained
  }
  enum ProcurementAnswerabilityReason {
    SPEND_COVERAGE_BELOW_GATE
    TIME_COVERAGE_BELOW_FLOOR
    GEO_COVERAGE_BELOW_FLOOR
    MISSING_QUALITY_VERDICT
    TIME_COVERAGE_DEGRADED
    GEO_COVERAGE_DEGRADED
    GENERATION_LACKS_CAPABILITY
  }
  enum ProcurementSeriesBucket {
    month
    quarter
    year
  }
  enum ProcurementAnalysisMeasure {
    recordCount
    withValueCount
    valueAwardedSum
    valueEstimatedSum
    avgValueAwarded
    distinctSuppliers
    distinctAuthorities
  }
  enum ProcurementBreakdownDimension {
    authority
    supplier
    cpvDivision
    cpvCode
    status
    procedureType
    buyerRegion
  }

  """
  ONE scope for every analysis shape. Empty = platform-wide; absent \`grain\` = all
  grains the combinations matrix supports for the used dimensions. \`from\`/\`to\`
  are \`YYYY-MM\` (XOR \`year\`); \`cpvDivision\` XOR \`cpvCode\`. Unsupported
  combinations are rejected with the specific missing capability named.
  """
  input ProcurementAnalysisScopeInput {
    authorityCui: String
    supplierCui: String
    cpvDivision: String
    cpvCode: String
    buyerCounty: String
    buyerRegion: String
    supplierCounty: String
    supplierRegion: String
    status: String
    procedureType: String
    grain: ProcurementAnalysisGrain
    from: String
    to: String
    year: Int
  }

  type ProcurementAnswerCounts {
    rows: String!
    withValue: String!
  }
  "The scope's undated bucket — records no period can claim (design §3.2)."
  type ProcurementUndatedInScope {
    count: String!
    valueRon: String
  }

  """
  The uniform answer envelope (design §3.4). Money is AWARDED value, not payments;
  \`provisional\` is true where terminality is underivable (all contract-grain money).
  \`counts\`/\`undatedInScope\` are null on a gate-BLOCKED block: nothing was read,
  so nothing is fabricated (the caveats explain the block).
  """
  type ProcurementAnswerMeta {
    answerability: ProcurementAnswerability!
    reason: ProcurementAnswerabilityReason
    policyKey: String!
    grain: ProcurementAnalysisGrain!
    valueBasis: String
    dateBasis: String!
    population: String!
    buildId: String!
    counts: ProcurementAnswerCounts
    undatedInScope: ProcurementUndatedInScope
    provisional: Boolean!
    caveats: [String!]!
    canonicalScope: String!
  }

  """
  One LABELED per-grain stats block. Blocks sit side by side; nothing sums them.
  Count fields are null only when the block is gate-BLOCKED (time/geo abstain).
  """
  type ProcurementStatsBlock {
    grain: ProcurementAnalysisGrain!
    recordCount: String
    withValueCount: String
    withEstimatedCount: String
    "Σ awarded value (RON, decimal string); null when the spend gate abstains."
    valueAwardedSum: String
    "Σ estimated value — a separate labeled metric, never in totals or rankings."
    valueEstimatedSum: String
    avgValueAwarded: String
    minMonth: String
    maxMonth: String
    meta: ProcurementAnswerMeta!
  }
  type ProcurementStatsResult {
    blocks: [ProcurementStatsBlock!]!
  }

  type ProcurementSeriesPoint {
    bucket: String!
    value: String
  }
  type ProcurementSeriesBlock {
    grain: ProcurementAnalysisGrain!
    measure: ProcurementAnalysisMeasure!
    bucket: ProcurementSeriesBucket!
    points: [ProcurementSeriesPoint!]!
    meta: ProcurementAnswerMeta!
  }

  "top-N + other + unknown; the three sum exactly to the scope's stats totals."
  type ProcurementBreakdownBucket {
    "The dimension value; null for other/unknown buckets."
    key: String
    kind: String!
    recordCount: String!
    withValueCount: String!
    valueAwardedSum: String
    "Share of the scope total on the ranking basis (decimal string)."
    shareOfScope: String
  }
  type ProcurementBreakdownBlock {
    grain: ProcurementAnalysisGrain!
    dimension: ProcurementBreakdownDimension!
    rankedBy: String!
    buckets: [ProcurementBreakdownBucket!]!
    meta: ProcurementAnswerMeta!
  }

  """
  HHI/top-shares over supplier keys within scope (decimal strings, 0..1).
  supplierCount = distinct KNOWN suppliers in scope; the shares/HHI cover the
  positive-basis subset (caveats disclose the split + unknown-supplier weight).
  """
  type ProcurementConcentrationBlock {
    grain: ProcurementAnalysisGrain!
    basis: String!
    supplierCount: Int
    top1Share: String
    top5Share: String
    hhi: String
    totalRon: String
    meta: ProcurementAnswerMeta!
  }

  "A validated derivation over two stats reads (design §3.3) — never a partial ratio."
  type ProcurementShareResult {
    share: String
    answerability: ProcurementAnswerability!
    reason: ProcurementAnswerabilityReason
    numerator: ProcurementStatsBlock!
    denominator: ProcurementStatsBlock!
    caveats: [String!]!
  }

  type ProcurementFacetsResult {
    blocks: [ProcurementBreakdownBlock!]!
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

    # analysis surface — one scope, six shapes over the scraper-built rollup
    # package (design §5.3). Every answer carries the §3.4 envelope.
    procurementStats(scope: ProcurementAnalysisScopeInput): ProcurementStatsResult!
    procurementSeries(
      scope: ProcurementAnalysisScopeInput
      bucket: ProcurementSeriesBucket!
      measure: ProcurementAnalysisMeasure!
    ): [ProcurementSeriesBlock!]!
    procurementBreakdown(
      scope: ProcurementAnalysisScopeInput
      dimension: ProcurementBreakdownDimension!
      topN: Int
    ): [ProcurementBreakdownBlock!]!
    procurementShare(
      numerator: ProcurementAnalysisScopeInput!
      denominator: ProcurementAnalysisScopeInput!
    ): ProcurementShareResult!
    procurementFacets(
      scope: ProcurementAnalysisScopeInput
      dimensions: [ProcurementBreakdownDimension!]!
      topN: Int
    ): ProcurementFacetsResult!

    # supplier recent records (canonical flows only, date desc)
    procurementSupplierRecords(
      supplierCui: ID!
      first: Int
      after: String
    ): ProcurementRecordConnection!

    # meta
    procurementCpvDivisions: [ProcurementCpvDivision!]!
    procurementResolve(
      dim: ProcurementResolveDim!
      q: String!
      limit: Int = 10
    ): [ProcurementResolveHit!]!

    "Supplier concentration over a matrix-supported scope; count basis is the default."
    procurementConcentration(
      scope: ProcurementAnalysisScopeInput
      basis: ProcurementConcentrationBasis
    ): [ProcurementConcentrationBlock!]!
  }
`;
