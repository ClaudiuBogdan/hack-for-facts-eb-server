/**
 * Companies analytics — GraphQL SDL (all types `CompanyAnalysis*`, §14.8).
 *
 * The enum NAMES are the API vocabulary on both surfaces (MCP returns the same
 * objects), so no enum here has an internal-value map. Counts are `BigInt`
 * strings; money/headcount sums and means are exact decimal `String`s whose
 * unit is named next to them. Every root is nullable so an error isolates to
 * its field (codes: INVALID_INPUT, SERVICE_UNAVAILABLE, GATEWAY_TIMEOUT, …).
 */

export const companyAnalysisTypeDefs = /* GraphQL */ `
  "A selected-statement figure. RON metrics are Decimal(18,2); EMPLOYEES is the reported average headcount."
  enum CompanyAnalysisMetric {
    TURNOVER
    NET_PROFIT
    NET_LOSS
    EMPLOYEES
    TOTAL_REVENUE
    TOTAL_EXPENSES
    GROSS_PROFIT
    GROSS_LOSS
    RECEIVABLES
    CURRENT_ASSETS
    FIXED_ASSETS
    CASH_AND_BANK
    PREPAID_EXPENSES
    DEFERRED_INCOME
    SUBSCRIBED_CAPITAL
    INVENTORIES
    DEBTS
    PROVISIONS
    TOTAL_EQUITY
    PATRIMONY_REGIE
    "Derived: profit minus loss; unavailable when both are absent, held when a present component is held."
    NET_RESULT
  }
  enum CompanyAnalysisUnit {
    RON
    HEADCOUNT
  }
  "FLOW = over the fiscal year; STOCK = statement-date balance; HEADCOUNT = average employees. Never add STOCK/HEADCOUNT across years."
  enum CompanyAnalysisMetricKind {
    FLOW
    STOCK
    HEADCOUNT
  }
  "Per-metric status of a statement. Only REPORTED carries a value; every other status is a coverage count, never a zero."
  enum CompanyAnalysisStatus {
    REPORTED
    "Admitted, source value NULL."
    MISSING
    "The metric is not admitted for that fiscal year."
    NOT_ADMITTED
    "The statement layout (source, profile) is not admitted, or the metric is withheld for it."
    HELD_PROFILE
    "A reviewed hold on this exact company, year and metric."
    HELD_OBSERVATION
    "A named quality flag or issue holds it."
    HELD_QUALITY
    "NET_RESULT only: a present component is held."
    HELD_COMPONENT
  }
  "EU headcount band of the year's REPORTED employees (eu-headcount-2003-361-v1)."
  enum CompanyAnalysisSizeBand {
    UNAVAILABLE
    NEGATIVE
    ZERO
    FROM_1_TO_9
    FROM_10_TO_49
    FROM_50_TO_249
    FROM_250
  }
  "ANAF main activity revision state. An unknown revision is never mapped to a catalog revision."
  enum CompanyAnalysisCaenBasis {
    REVISION_KNOWN
    REVISION_UNKNOWN
    MISSING
  }
  "An ANAF fiscal observation; UNKNOWN is a missing observation, never NO."
  enum CompanyAnalysisFlagValue {
    YES
    NO
    UNKNOWN
  }
  "Whether the company has a selected statement for the scope's fiscal year."
  enum CompanyAnalysisFiling {
    FILED
    NOT_FILED
  }
  enum CompanyAnalysisDimension {
    COUNTY
    UAT
    MAIN_CAEN
    LEGAL_FORM
    OBSERVED_STATUS
    VAT_PAYER
    FISCALLY_INACTIVE
    "Selected-year statement attribute; the unknown group holds non-filers and statements without a reported headcount."
    EMPLOYEE_SIZE
  }
  enum CompanyAnalysisRankBy {
    METRIC_SUM
    COMPANIES
    FILERS
    CONTRIBUTORS
  }
  enum CompanyAnalysisCohortMode {
    "Every year's matching reporters: the selected-year filters are re-applied per year."
    EACH_YEAR
    "The fixed cohort that filed in the scope's fiscal year and met every filter there."
    REFERENCE_YEAR
  }
  enum CompanyAnalysisRecordSort {
    METRIC
    CUI
  }
  enum CompanyAnalysisDirection {
    DESC
    ASC
  }
  "Why a series point has no figure, judged on the scope's own statements for that year."
  enum CompanyAnalysisGapReason {
    "No statement in the scope for that year (no filers)."
    NO_STATEMENTS
    "Every statement in the scope has the metric NOT_ADMITTED for that year."
    NOT_ADMITTED
    "Statements exist, but none reports the metric (missing or held)."
    NO_REPORTED_VALUES
  }
  enum CompanyAnalysisBucketKind {
    GROUP
    OTHER
    UNKNOWN
    TOTAL
  }

  "OR within the list; includeUnknown adds the NULL (unknown) group."
  input CompanyAnalysisKeyFilterInput {
    in: [String!]
    includeUnknown: Boolean
  }
  "A main CAEN code. Omit revision to match codes whose revision ANAF did not publish (never guessed)."
  input CompanyAnalysisCaenInput {
    code: String!
    revision: String
  }
  "Inclusive bounds on a REPORTED value of the scope's fiscal year: decimal strings (RON, ≤2 decimals) or integer strings (EMPLOYEES)."
  input CompanyAnalysisRangeInput {
    metric: CompanyAnalysisMetric!
    min: String
    max: String
  }
  """
  The question. OR within a field, AND across fields. Company keys (cuis, county,
  uat, legalForms, observedStatus, vatPayer, fiscallyInactive, mainCaen,
  mainCaenBasis) describe the release snapshot; filing, financialRanges and
  employeeSizeBands act on the fiscal year's statement (and imply FILED).
  """
  input CompanyAnalysisScopeInput {
    "Defaults to the release default (2024 when offered)."
    fiscalYear: Int
    "Selected CUIs (normalized; >10-digit identifiers are refused). At most 500."
    cuis: [String!]
    "core.territories county_code of the registered office."
    county: CompanyAnalysisKeyFilterInput
    "Registered-office UAT SIRUTA (text, leading zeros kept)."
    uat: CompanyAnalysisKeyFilterInput
    "ONRC legal-form codes (SRL, SA, …)."
    legalForms: [String!]
    "ONRC observed headline status codes (most advanced state seen, not 'currently active')."
    observedStatus: CompanyAnalysisKeyFilterInput
    vatPayer: [CompanyAnalysisFlagValue!]
    fiscallyInactive: [CompanyAnalysisFlagValue!]
    mainCaen: [CompanyAnalysisCaenInput!]
    mainCaenBasis: [CompanyAnalysisCaenBasis!]
    filing: CompanyAnalysisFiling
    "At most one range per metric; AND across ranges."
    financialRanges: [CompanyAnalysisRangeInput!]
    employeeSizeBands: [CompanyAnalysisSizeBand!]
  }

  "The release an answer was computed on. Pin releaseId in every follow-up request."
  type CompanyAnalysisReleaseRef {
    releaseId: BigInt!
    publishedAt: DateTime
    active: Boolean!
  }
  "Statement counts per status of one metric; they add up to the statements."
  type CompanyAnalysisCoverage {
    reported: BigInt!
    missing: BigInt!
    notAdmitted: BigInt!
    heldProfile: BigInt!
    heldObservation: BigInt!
    heldQuality: BigInt!
    heldComponent: BigInt!
  }
  type CompanyAnalysisYearMetric {
    metric: CompanyAnalysisMetric!
    "Admitted for the year with at least one reported value."
    offered: Boolean!
    coverage: CompanyAnalysisCoverage!
  }
  type CompanyAnalysisSizeBandCount {
    band: CompanyAnalysisSizeBand!
    statements: BigInt!
  }
  type CompanyAnalysisYearCapability {
    fiscalYear: Int!
    "Observed selected statements; a partial year is never labelled complete."
    statements: BigInt!
    metrics: [CompanyAnalysisYearMetric!]!
    sizeBands: [CompanyAnalysisSizeBandCount!]!
  }
  type CompanyAnalysisMetricCapability {
    metric: CompanyAnalysisMetric!
    unit: CompanyAnalysisUnit!
    kind: CompanyAnalysisMetricKind!
    offeredYears: [Int!]!
  }
  type CompanyAnalysisDimensionCapability {
    dimension: CompanyAnalysisDimension!
    yearScoped: Boolean!
    labelSource: String!
  }
  "One input frontier line of the release (ONRC captures, ANAF fiscal window, per-year financial derive time)."
  type CompanyAnalysisFrontierEntry {
    kind: String!
    id: String
    published: String
    retrieved: String
    rows: String
  }
  type CompanyAnalysisDefaults {
    fiscalYear: Int!
    metric: CompanyAnalysisMetric!
    "For scopes without selected-year filters; REFERENCE_YEAR is the default when the scope has them."
    cohortMode: CompanyAnalysisCohortMode!
    rankBy: CompanyAnalysisRankBy!
    topN: Int!
    recordSort: CompanyAnalysisRecordSort!
    direction: CompanyAnalysisDirection!
    pageSize: Int!
  }
  type CompanyAnalysisLimits {
    maxSelectedCuis: Int!
    maxCounties: Int!
    maxUats: Int!
    maxLegalForms: Int!
    maxObservedStatuses: Int!
    maxCaenCodes: Int!
    maxFinancialRanges: Int!
    maxMetrics: Int!
    maxRecordMetrics: Int!
    defaultTopN: Int!
    maxTopN: Int!
    defaultPageSize: Int!
    maxPageSize: Int!
  }
  "Capabilities, coverage and defaults of one published release."
  type CompanyAnalysisRelease {
    release: CompanyAnalysisReleaseRef!
    publicationId: BigInt
    schemaVersion: String!
    populationPolicyVersion: String!
    admissionPolicyVersion: String
    admissionPolicySha256: String
    inputSnapshotAt: String
    "Eligible companies in the release population."
    companies: BigInt!
    "Selected statements across all years."
    companyYears: BigInt!
    fiscalYears: [Int!]!
    years: [CompanyAnalysisYearCapability!]!
    metrics: [CompanyAnalysisMetricCapability!]!
    dimensions: [CompanyAnalysisDimensionCapability!]!
    defaults: CompanyAnalysisDefaults!
    "The page's as-of line."
    asOf: [CompanyAnalysisFrontierEntry!]!
    "False: broad name filtering is not offered; select companies by CUI (companyResolve NAME → cuis)."
    nameFilter: Boolean!
    limits: CompanyAnalysisLimits!
    caveats: [String!]!
  }

  "One metric over a set of statements."
  type CompanyAnalysisMetricAggregate {
    metric: CompanyAnalysisMetric!
    unit: CompanyAnalysisUnit!
    kind: CompanyAnalysisMetricKind!
    "Exact sum of REPORTED values (RON with 2 decimals, or an integer headcount). Null when no value was reported; an explicit zero stays 0."
    sum: String
    "Statements with a REPORTED value; the only denominator of mean."
    contributors: BigInt!
    "sum / contributors, 2 decimals, half away from zero. Null without contributors."
    mean: String
    coverage: CompanyAnalysisCoverage!
  }

  type CompanyAnalysisStats {
    release: CompanyAnalysisReleaseRef!
    "The normalized scope (input shape). Reuse it verbatim for follow-up requests."
    scope: JSON!
    scopeHash: String!
    fiscalYear: Int!
    "Companies in the scope (filers and non-filers)."
    companies: BigInt!
    "Companies with a selected statement for the fiscal year."
    filers: BigInt!
    nonFilers: BigInt!
    metrics: [CompanyAnalysisMetricAggregate!]!
    caveats: [String!]!
  }

  type CompanyAnalysisCaen {
    code: String!
    "Null when ANAF published no revision."
    revision: String
    basis: CompanyAnalysisCaenBasis!
    "Catalog label; only for a known revision."
    label: String
  }
  type CompanyAnalysisBucket {
    kind: CompanyAnalysisBucketKind!
    "GROUP only: the stable filter key (MAIN_CAEN: 'revision:code', '?:code' when the revision is unknown)."
    key: String
    label: String
    caen: CompanyAnalysisCaen
    "OTHER: groups folded; TOTAL: all groups plus unknown."
    groups: Int!
    companies: BigInt!
    filers: BigInt!
    "Null only when the fiscal year offers no metric."
    metric: CompanyAnalysisMetricAggregate
  }
  "groups + other + unknown = totals = companyAnalysisStats for the same scope."
  type CompanyAnalysisBreakdown {
    release: CompanyAnalysisReleaseRef!
    scope: JSON!
    scopeHash: String!
    fiscalYear: Int!
    dimension: CompanyAnalysisDimension!
    metric: CompanyAnalysisMetric
    "Known groups before the top-N cut."
    groupCount: Int!
    rankBy: CompanyAnalysisRankBy!
    "The ranking applied: a metric ranking with no contributing group ranks by COMPANIES."
    rankedBy: CompanyAnalysisRankBy!
    topN: Int!
    groups: [CompanyAnalysisBucket!]!
    other: CompanyAnalysisBucket!
    unknown: CompanyAnalysisBucket!
    totals: CompanyAnalysisBucket!
    caveats: [String!]!
  }

  type CompanyAnalysisSeriesPoint {
    fiscalYear: Int!
    "True iff the scope has at least one REPORTED value that year (sum is non-null; a reported 0 is available). Otherwise gapReason says why."
    available: Boolean!
    gapReason: CompanyAnalysisGapReason
    "EACH_YEAR: the year's population; REFERENCE_YEAR: the fixed cohort size."
    companies: BigInt!
    filers: BigInt!
    metric: CompanyAnalysisMetricAggregate!
  }
  type CompanyAnalysisSeries {
    release: CompanyAnalysisReleaseRef!
    scope: JSON!
    scopeHash: String!
    fiscalYear: Int!
    metric: CompanyAnalysisMetric!
    unit: CompanyAnalysisUnit!
    kind: CompanyAnalysisMetricKind!
    cohortMode: CompanyAnalysisCohortMode!
    referenceYear: Int
    cohortCompanies: BigInt
    fromYear: Int!
    toYear: Int!
    "One point per year of the range, gaps included."
    points: [CompanyAnalysisSeriesPoint!]!
    caveats: [String!]!
  }

  type CompanyAnalysisLabelled {
    code: String!
    label: String
  }
  type CompanyAnalysisRecordValue {
    metric: CompanyAnalysisMetric!
    "REPORTED value only."
    value: String
    "Null when the company has no statement for the fiscal year."
    status: CompanyAnalysisStatus
  }
  type CompanyAnalysisRecord {
    cui: CUI!
    "Current public registry name (not pinned to the release); null when not publicly named."
    currentName: String
    legalForm: String!
    county: CompanyAnalysisLabelled
    uat: CompanyAnalysisLabelled
    observedStatus: CompanyAnalysisLabelled
    vatPayer: CompanyAnalysisFlagValue!
    fiscallyInactive: CompanyAnalysisFlagValue!
    mainCaen: CompanyAnalysisCaen
    registrationYear: Int
    "Has a selected statement for the fiscal year."
    filed: Boolean!
    employeeSizeBand: CompanyAnalysisSizeBand
    values: [CompanyAnalysisRecordValue!]!
  }
  type CompanyAnalysisRecordEdge {
    cursor: String!
    node: CompanyAnalysisRecord!
  }
  "Stable keyset pages: (value NULLS LAST, cui). The cursor binds release, scope (with fiscal year), sort and direction."
  type CompanyAnalysisRecordConnection {
    release: CompanyAnalysisReleaseRef!
    scope: JSON!
    scopeHash: String!
    fiscalYear: Int!
    sort: CompanyAnalysisRecordSort!
    sortMetric: CompanyAnalysisMetric
    direction: CompanyAnalysisDirection!
    "Exact population count of the scope (equals companyAnalysisStats.companies)."
    totalCount: BigInt!
    edges: [CompanyAnalysisRecordEdge!]!
    pageInfo: PageInfo!
    caveats: [String!]!
  }

  extend type Query {
    "Capabilities, coverage, defaults and as-of of the active release (or a published pinned one)."
    companyAnalysisRelease(release: BigInt): CompanyAnalysisRelease
    "Exact population, filers and selected metric totals/contributors/coverage."
    companyAnalysisStats(
      release: BigInt
      scope: CompanyAnalysisScopeInput
      metrics: [CompanyAnalysisMetric!]
    ): CompanyAnalysisStats
    "One dimension: top groups, other and unknown, adding up to the stats."
    companyAnalysisBreakdown(
      release: BigInt
      scope: CompanyAnalysisScopeInput
      dimension: CompanyAnalysisDimension!
      metric: CompanyAnalysisMetric
      rankBy: CompanyAnalysisRankBy
      topN: Int
    ): CompanyAnalysisBreakdown
    "Annual points with an explicit cohort mode, coverage and gap reasons."
    companyAnalysisSeries(
      release: BigInt
      scope: CompanyAnalysisScopeInput
      metric: CompanyAnalysisMetric
      cohortMode: CompanyAnalysisCohortMode
      fromYear: Int
      toYear: Int
    ): CompanyAnalysisSeries
    "The matching companies, money/headcount ranked (NULLS LAST, cui tie-breaker), cursor-paginated."
    companyAnalysisRecords(
      release: BigInt
      scope: CompanyAnalysisScopeInput
      sort: CompanyAnalysisRecordSort
      sortMetric: CompanyAnalysisMetric
      direction: CompanyAnalysisDirection
      metrics: [CompanyAnalysisMetric!]
      first: Int
      after: String
    ): CompanyAnalysisRecordConnection
  }
`;
