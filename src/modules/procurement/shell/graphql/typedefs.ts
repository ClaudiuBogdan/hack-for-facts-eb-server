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
    """
    BM25 relevance, highest first. Requires a \`q\` filter to rank against and a
    search-engine-served grain (not \`modifications\`); rejected otherwise rather
    than silently answered in date order.
    """
    relevance
  }

  """
  How the search engine reads a multi-word \`q\`. Measured on 1.55M contracts with
  \`reparatii drumuri comunale\`: \`all\` = 14 hits, \`any\` = 90,872, \`phrase\` = 1.
  Engine-served grains only — the SQL path has a single substring match.
  """
  enum ProcurementQMode {
    "Every word must appear (the default)."
    all
    "Any word, with typo tolerance — the broadest reading."
    any
    "The words adjacent and in order."
    phrase
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
  """
  Free-text search term (3–100 chars) over the grain's title/name/number
  columns. Executes as full-text relevance search (Romanian analyzer:
  diacritic folding, stemming, fuzziness) when the search engine is
  configured, degrading to a server-bounded ILIKE otherwise. Very broad
  terms may be relevance-truncated — disclosed via totalEstimated.
  """
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

  "A display title with inseparable evidence provenance."
  type ProcurementContractDisplayTitle {
    text: String!
    "Evidence selected for text: native | matched_award | procedure."
    source: String!
    "Human-openable source that carries text."
    sourceUrl: String
  }

  "A supplier-level award (SEAP contracts ∪ e-licitatie CA awards)."
  type ProcurementContract {
    id: ID!
    contractNo: String
    contractDate: Date
    procedureId: ID
    noticeNo: String
    "Source-owned contract title. It is never backfilled from another record."
    title: String
    "Presentation title and provenance resolved without mutating title."
    displayTitle: ProcurementContractDisplayTitle
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
    """
    Record kind: contract_award | framework_agreement (v5 serving convention).
    Frameworks are umbrellas — their value is a ceiling, not spend. Rows not
    yet stamped read as contract_award.
    """
    recordKind: String!
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
    "How \`q\` is read (default: all). Requires \`q\`."
    qMode: ProcurementQMode
    authorityCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    "Canonical 8-digit CPV level codes (trailing zeros, non-zero level digit)."
    cpvGroup: StringEqInput
    cpvClass: StringEqInput
    cpvCategory: StringEqInput
    "Territory of the contracting institution (search-engine served)."
    buyerRegion: StringEqInput
    buyerCounty: StringEqInput
    buyerSiruta: StringEqInput
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
    "How \`q\` is read (default: all). Requires \`q\`."
    qMode: ProcurementQMode
    authorityCui: StringEqInput
    supplierCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    "Canonical 8-digit CPV level codes (trailing zeros, non-zero level digit)."
    cpvGroup: StringEqInput
    cpvClass: StringEqInput
    cpvCategory: StringEqInput
    "Territory of the contracting institution (search-engine served)."
    buyerRegion: StringEqInput
    buyerCounty: StringEqInput
    buyerSiruta: StringEqInput
    "Registered office of the awarded supplier (search-engine served)."
    supplierRegion: StringEqInput
    supplierCounty: StringEqInput
    supplierSiruta: StringEqInput
    sourceSystem: StringInInput
    status: StringInInput
    contractDate: DateRangeInput
    "Bounds the RESOLVED comparable value (value model)."
    valueRon: DecimalRangeInput
    "Value-model resolution states to include (e.g. the 4 accepted states)."
    valueState: StringInInput
    """
    Record kind: contract_award | framework_agreement. Orthogonal to
    valueState (frameworks are umbrellas, not purchases — their value is a
    ceiling). NULL rows (pre-v5 data) match contract_award.
    """
    recordKind: StringInInput
  }

  """
  The 26M-row grain. A search REQUIRES authorityCui, supplierCui, or a fully-bounded
  publicationDate range of ≤ 366 days: nothing else bounds the rows the planner must
  sort. CPV and q refine such a filter but cannot stand alone.
  publicationDate binds to finalization_date (publication_date is NULL on elicitatie_da).
  """
  input ProcurementDirectAcquisitionsFilter {
    q: StringQInput
    "How \`q\` is read (default: all). Requires \`q\`."
    qMode: ProcurementQMode
    authorityCui: StringEqInput
    supplierCui: StringEqInput
    cpvDivision: StringEqInput
    cpvCode: StringEqInput
    "Canonical 8-digit CPV level codes (trailing zeros, non-zero level digit)."
    cpvGroup: StringEqInput
    cpvClass: StringEqInput
    cpvCategory: StringEqInput
    "Territory of the contracting institution (search-engine served)."
    buyerRegion: StringEqInput
    buyerCounty: StringEqInput
    buyerSiruta: StringEqInput
    "Registered office of the awarded supplier (search-engine served)."
    supplierRegion: StringEqInput
    supplierCounty: StringEqInput
    supplierSiruta: StringEqInput
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
    """
    Territory of the contracting institution. An amendment inherits its
    contract's buyer, so this resolves through the parent contract's analysis
    fact row — no search index involved.
    """
    buyerRegion: StringEqInput
    buyerCounty: StringEqInput
    buyerSiruta: StringEqInput
    modificationDate: DateRangeInput
    "contractId IS (NOT) NULL."
    linked: Boolean
    "value_delta_ron / nullif(value_before_ron, 0) >= pct."
    minDeltaPct: Float
  }

  """
  A result-set facet: how the CURRENT result set distributes over one
  dimension. Never an authoritative analytic total — those come from the
  analysis surface.
  """
  type ProcurementSearchFacetBucket {
    key: String!
    count: Int!
  }
  type ProcurementSearchFacet {
    dimension: String!
    buckets: [ProcurementSearchFacetBucket!]!
    "Records outside the returned buckets — disclosed, never silently dropped."
    otherCount: Int!
  }

  """
  Where the text query matched inside one record, as a fragment of the ORIGINAL
  text with the matched terms wrapped in U+27E6 … U+27E7.

  Those markers are deliberately NOT markup: split on them and render your own
  element. A fragment is presentational — it comes from the
  index (as of \`provenance.asOf\`), while every rendered value comes from the
  production database.
  """
  type ProcurementSearchHighlight {
    "The record id — matches \`items[].id\` on this page."
    id: ID!
    title: String
    authorityName: String
    supplierName: String
  }

  """
  Which surface answered and how fresh it is. \`engine: "opensearch"\` pages are
  as of \`asOf\` (the index build); \`engine: "postgres"\` pages are live but
  cannot serve geography or CPV mid-level filters.
  """
  type ProcurementSearchProvenance {
    engine: String!
    asOf: String
  }

  """
  \`total\` is null when the count is a lower bound (the engine capped it, or the
  SQL count exceeded 10 000 / timed out); \`totalEstimated\` then marks it.
  Clients render "10000+".
  """
  type ProcurementProceduresPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementProcedure!]!
    "Present only for requested facets on an engine-served page."
    facets: [ProcurementSearchFacet!]
    "Match fragments, for a \`q\` page the engine served."
    highlights: [ProcurementSearchHighlight!]
    provenance: ProcurementSearchProvenance
  }
  type ProcurementContractsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementContract!]!
    facets: [ProcurementSearchFacet!]
    "Match fragments, for a \`q\` page the engine served."
    highlights: [ProcurementSearchHighlight!]
    provenance: ProcurementSearchProvenance
  }
  type ProcurementDirectAcquisitionsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementDirectAcquisition!]!
    facets: [ProcurementSearchFacet!]
    "Match fragments, for a \`q\` page the engine served."
    highlights: [ProcurementSearchHighlight!]
    provenance: ProcurementSearchProvenance
  }
  type ProcurementModificationsPage {
    total: Int
    totalEstimated: Boolean!
    items: [ProcurementContractModification!]!
    "Always \`postgres\`: this grain is answered from the database, never an index."
    provenance: ProcurementSearchProvenance
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

  """
  Why a detail body is or is not present. Absence of a detail is NOT absence of
  a purchase: the detail surface covers ~41% of direct acquisitions by design.
  """
  enum ProcurementDetailAvailability {
    "A detail body was captured and is served."
    AVAILABLE
    "This family has a detail feed, but this record was never captured (the pre-2020 tail; a backfill is still closing it)."
    NOT_CAPTURED
    "This family has NO detail feed in existence - it came from bulk spreadsheet exports, so there is nothing to capture."
    NOT_AVAILABLE_FOR_SOURCE
  }

  "One catalog line item: what was actually bought, per line."
  type ProcurementDaItem {
    id: ID!
    itemIndex: Int!
    catalogItemCode: String
    catalogItemName: String
    catalogItemDescription: String
    itemMeasureUnit: String
    cpvCode: String
    cpvText: String
    "Decimal strings - money and quantities never cross the wire as floats."
    itemQuantity: String
    "PER UNIT. Measured: sum(unitPrice x itemQuantity) reproduces the DA value on 99.4% of records."
    unitPrice: String
    unitEstimatedPrice: String
    catalogUnitPrice: String
    "unitPrice x itemQuantity, computed and stored by the database."
    lineValue: String
    sourceUrl: String!
  }

  "The e-licitatie detail body of a direct acquisition, with its line items."
  type ProcurementDaDetail {
    description: String
    deliveryCondition: String
    paymentCondition: String
    contractTypeText: String
    isEuFunded: Boolean!
    euFundText: String
    caDecisionDate: String
    caDecisionDeadline: String
    supplierDecisionDate: String
    supplierDecisionDeadline: String
    caRejectionReason: String
    supplierRejectionReason: String
    correctionReason: String
    "Documents published on the source page. Their text is not served (sensitive)."
    documentCount: Int!
    itemCount: Int!
    "Sum of the line values, for the reconciliation disclosure."
    itemsTotal: String
    itemsValueDelta: String
    """
    Whether the item basket sums to the headline value. FALSE means the source
    own numbers disagree (0.3-0.6% of records) and the client must say so rather
    than render a basket that contradicts the value shown above it. NULL means
    the source recorded no closing value - unanswerable, not answered no.
    """
    itemsReconciled: Boolean
    """
    TRUE when this record free text carries contact data and is withheld from
    this caller. The text fields are then null - withheld, not absent.
    """
    textRedacted: Boolean!
    sourceUrl: String!
    items: [ProcurementDaItem!]!
  }

  type ProcurementDirectAcquisitionDetail {
    directAcquisition: ProcurementDirectAcquisition!
    duplicates: [ProcurementDuplicateRef!]!
    "Null unless detailAvailability is AVAILABLE."
    detail: ProcurementDaDetail
    detailAvailability: ProcurementDetailAvailability!
  }

  # ── analysis surface (design §5 — one scope, six shapes, rollup-backed) ──────

  """
  Analysis grains. Answers NEVER merge across grains. framework/calloff/
  modification (value-basis wave) are EXPLICIT-ONLY populations: they answer
  only when named — implicit requests fan out over the three core grains.
  framework = one row per framework identity (ceilings, no supplier dim);
  calloff = execution under frameworks (never summed with contract awards);
  modification = amendment events (counts-only).
  """
  enum ProcurementAnalysisGrain {
    procedure
    contract
    direct_acquisition
    framework
    calloff
    modification
  }

  enum ProcurementConcentrationBasis {
    count
    value
  }
  "Breakdown/facets bucket ranking basis. Default: value where the spend gate allows, else count."
  enum ProcurementRankBy {
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
    SPEND_SERVED_DISCLOSED
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
    valueCeilingSum
    valueModAdjustedSum
    valueAwardedMatchedSum
    avgValueAwarded
    distinctSuppliers
    distinctAuthorities
  }
  enum ProcurementBreakdownDimension {
    authority
    supplier
    cpvDivision
    cpvGroup
    cpvClass
    cpvCategory
    cpvCode
    status
    procedureType
    recordKind
    buyerRegion
    buyerCounty
    buyerSiruta
    supplierRegion
    supplierCounty
    supplierSiruta
  }

  """
  ONE scope for every analysis shape. Empty = platform-wide; absent \`grain\` = all
  grains the combinations matrix supports for the used dimensions. \`from\`/\`to\`
  are \`YYYY-MM\` (XOR \`year\`); at most ONE CPV level (\`cpvDivision\`/\`cpvGroup\`/
  \`cpvClass\`/\`cpvCategory\`/\`cpvCode\`). \`recordKind\` is contract-grain only.
  \`q\`/\`valueMin\`/\`valueMax\` are row filters that reshape every figure (see the
  envelope caveats). Unsupported combinations are rejected with the specific
  missing capability named.
  """
  input ProcurementAnalysisScopeInput {
    authorityCui: String
    supplierCui: String
    cpvDivision: String
    "Canonical 8-digit CPV group code (XXY00000, Y≠0)."
    cpvGroup: String
    "Canonical 8-digit CPV class code (XXXY0000, Y≠0)."
    cpvClass: String
    "Canonical 8-digit CPV category code (XXXXY000, Y≠0)."
    cpvCategory: String
    cpvCode: String
    buyerCounty: String
    buyerRegion: String
    "Buyer entity territorial SIRUTA (UAT natural key)."
    buyerSiruta: SIRUTA
    supplierCounty: String
    supplierRegion: String
    "Supplier registered-office territorial SIRUTA (UAT natural key)."
    supplierSiruta: SIRUTA
    status: String
    procedureType: String
    "Contract grain only: contract_award | framework_agreement."
    recordKind: String
    grain: ProcurementAnalysisGrain
    from: String
    to: String
    year: Int
    "Free-text title filter on aggregates (title coverage is partial per grain)."
    q: String
    "Anchor-money lower bound, RON (awarded on core grains; ceiling on frameworks; call-off value on calloffs) — restricts to accepted-value rows in range."
    valueMin: Float
    "Anchor-money upper bound, RON — restricts to accepted-value rows in range (see valueMin)."
    valueMax: Float
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

  "Per-measure money verdict: one stats block can carry different answerabilities per money basis (e.g. awarded disclosed + estimated abstained)."
  type ProcurementMoneyVerdict {
    measure: ProcurementAnalysisMeasure!
    answerability: ProcurementAnswerability!
    reason: ProcurementAnswerabilityReason
    caveats: [String!]!
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
    "Σ estimated value — its own basis (applicability + outlier gated); never in totals or rankings."
    valueEstimatedSum: String
    "Framework grain only: Σ attributed ceiling (maximum committed, NOT spend)."
    valueCeilingSum: String
    "Contract grain only: Σ modification-adjusted value (verified anchored chains)."
    valueModAdjustedSum: String
    """
    Contract grain only: Σ awarded value over the SAME population as
    \`valueModAdjustedSum\` (resolvable amendment chains). Pair the two to read the
    net amendment effect; subtracting \`valueModAdjustedSum\` from the grain-wide
    \`valueAwardedSum\` compares different populations and is never valid.
    """
    valueAwardedMatchedSum: String
    avgValueAwarded: String
    """
    Supplier-scoped requests only (association dedup): Σ awarded money in this
    scope that belongs to multi-member consortium awards and is withheld from
    per-supplier totals (the internal split is not published). Null on
    attributed-basis reads; '0.00' means nothing is withheld here.
    """
    valueWithheldAssociationSum: String
    minMonth: String
    maxMonth: String
    "One verdict per declared money measure of this grain."
    moneyVerdicts: [ProcurementMoneyVerdict!]!
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
    "Awarded money only — null on grains whose anchor money is another basis."
    valueAwardedSum: String
    "The grain's ANCHOR money (awarded / ceiling / call-off value)."
    valueSum: String
    "Share of the scope total on the ranking basis (decimal string)."
    shareOfScope: String
  }
  type ProcurementBreakdownBlock {
    grain: ProcurementAnalysisGrain!
    dimension: ProcurementBreakdownDimension!
    rankedBy: String!
    buckets: [ProcurementBreakdownBucket!]!
    """
    Supplier-money breakdowns only (supplier-keyed dimension or supplier-scoped
    request): consortium money withheld from every bucket in this scope —
    buckets + this field reconcile to the attributed total (render it under
    the map/ranking so the buyer and supplier views visibly reconcile).
    """
    valueWithheldAssociationSum: String
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
    """
    Contract grain only: Σ awarded money in this scope that belongs to
    multi-member consortium awards and so enters NO supplier's measure (the
    internal split is not published). \`totalRon\` + this + the unknown-supplier
    weight reconcile to the scope's attributed total — render it instead of
    describing the remainder as "supplier unidentified". Null when nothing is
    withheld, when the amount is not quotable, or when money is gate-suppressed.
    """
    valueWithheldAssociationSum: String
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

  "A full CPV code label (official CPV-2008 relabel where available, else best-effort)."
  type ProcurementCpvCode {
    cpvCode: String!
    labelRo: String
    labelEn: String
    divisionCode: String
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
      """
      Result-set facet dimensions to aggregate (engine-served grains only).
      Unknown dimensions are rejected. Allowed: buyerRegion, buyerCounty,
      supplierRegion, supplierCounty (award grains), cpvDivision, status,
      valueState, sourceSystem, recordKind (contracts), procedureType
      (procedures).
      """
      facets: [String!]
    ): ProcurementProceduresPage!
    procurementContracts(
      filter: ProcurementContractsFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
      """
      Result-set facet dimensions to aggregate (engine-served grains only).
      Unknown dimensions are rejected. Allowed: buyerRegion, buyerCounty,
      supplierRegion, supplierCounty (award grains), cpvDivision, status,
      valueState, sourceSystem, recordKind (contracts), procedureType
      (procedures).
      """
      facets: [String!]
    ): ProcurementContractsPage!
    procurementDirectAcquisitions(
      filter: ProcurementDirectAcquisitionsFilter
      sort: ProcurementSort
      page: Int
      pageSize: Int
      """
      Result-set facet dimensions to aggregate (engine-served grains only).
      Unknown dimensions are rejected. Allowed: buyerRegion, buyerCounty,
      supplierRegion, supplierCounty (award grains), cpvDivision, status,
      valueState, sourceSystem, recordKind (contracts), procedureType
      (procedures).
      """
      facets: [String!]
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
      rankBy: ProcurementRankBy
    ): [ProcurementBreakdownBlock!]!
    procurementShare(
      numerator: ProcurementAnalysisScopeInput!
      denominator: ProcurementAnalysisScopeInput!
    ): ProcurementShareResult!
    procurementFacets(
      scope: ProcurementAnalysisScopeInput
      dimensions: [ProcurementBreakdownDimension!]!
      topN: Int
      rankBy: ProcurementRankBy
    ): ProcurementFacetsResult!

    # supplier recent records (canonical flows only, date desc). Cancelled
    # direct acquisitions (refused/lapsed, no purchase) are hidden unless
    # includeCancelled — mirrors the DA list default and the flow aggregates.
    procurementSupplierRecords(
      supplierCui: ID!
      first: Int
      after: String
      includeCancelled: Boolean
    ): ProcurementRecordConnection!

    # meta
    procurementCpvDivisions: [ProcurementCpvDivision!]!
    "Batch CPV code label lookup (up to 200 distinct codes); unknown codes are omitted."
    procurementCpvCodes(codes: [String!]!): [ProcurementCpvCode!]!
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
