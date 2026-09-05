/**
 * Legacy `executionAnalytics` SDL on the kernel endpoint (docs/server-redesign/13
 * §1, §3 rule 1). Every definition below is copied BYTE-IDENTICAL from the legacy
 * sources — the unit test `tests/unit/budget/legacy-analytics/sdl-identity.test.ts`
 * re-extracts each definition from both sides through the parser and fails on
 * any drift, so nothing the client sends can silently change:
 *
 *  - `directive @oneOf`                      ← src/infra/graphql/common/directives.ts
 *  - `scalar PeriodDate`                     ← src/infra/graphql/common/scalars.ts
 *  - `enum Currency|ReportType|PeriodType`   ← src/infra/graphql/common/enums.ts
 *  - the executionAnalytics types + root      ← src/modules/execution-analytics/shell/graphql/schema.ts
 *  - the dimension types + roots              ← src/modules/{budget-sector,funding-sources,classification}/shell/graphql/schema.ts
 *    (`budgetSectors`, `fundingSources`, `functionalClassifications`,
 *    `economicClassifications`; design 13 §4 "dimension usecases")
 *
 * The `extend type Query` block is COMPOSED from the carried roots: each field
 * (with its description) is byte-identical to its legacy source, compared per
 * field (`Query.<name>` keys). Roots the client never sends (`budgetSector(id)`,
 * `fundingSource(id)`, `functionalClassification(code)`, `economicClassification(code)`)
 * are not carried (design 13 §2).
 *
 * Not carried: `Date`/`DateTime`/`JSON` (kernel base scalars), `SortOrder`,
 * `PageInfo` (kernel base type, extended in `budgetLegacyCollisionTypeDefs`),
 * and the legacy inter-definition `#` comments. The `@deprecated` markers on
 * `entity_types` are kept (the only additions the manifest allows).
 */

export const budgetLegacyTypeDefs = /* GraphQL */ `
  "Indicates that an input object should have exactly one field set"
  directive @oneOf on INPUT_OBJECT

  "A string representing a Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])"
  scalar PeriodDate

  "Supported currencies for financial data"
  enum Currency {
    "Romanian Leu"
    RON
    "Euro"
    EUR
    "US Dollar"
    USD
  }

  "Type of report"
  enum ReportType {
    "Executie bugetara agregata la nivel de ordonator principal"
    PRINCIPAL_AGGREGATED
    "Executie bugetara agregata la nivel de ordonator secundar"
    SECONDARY_AGGREGATED
    "Executie bugetara detaliata"
    DETAILED
    "Executie - Angajamente bugetare agregat principal"
    COMMITMENT_PRINCIPAL_AGGREGATED
    "Executie - Angajamente bugetare agregat secundar"
    COMMITMENT_SECONDARY_AGGREGATED
    "Executie - Angajamente bugetare detaliat"
    COMMITMENT_DETAILED
  }

  "Period type for temporal filtering"
  enum PeriodType {
    "Monthly period"
    MONTH
    "Quarterly period"
    QUARTER
    "Yearly period"
    YEAR
  }

  enum AxisDataType {
    STRING
    INTEGER
    FLOAT
    DATE
  }

  enum AccountCategory {
    vn
    ch
  }

  enum Normalization {
    total
    total_euro
    per_capita
    per_capita_euro
    percent_gdp
  }

  enum ExpenseType {
    dezvoltare
    functionare
  }

  enum AnomalyType {
    YTD_ANOMALY
    MISSING_LINE_ITEM
  }

  type Axis {
    name: String!
    type: AxisDataType!
    unit: String!
  }

  type AnalyticsDataPoint {
    x: String!
    y: Float!
  }

  type AnalyticsSeries {
    seriesId: String!
    xAxis: Axis!
    yAxis: Axis!
    data: [AnalyticsDataPoint!]!
  }

  input PeriodIntervalInput {
    start: PeriodDate!
    end: PeriodDate!
  }

  input PeriodSelection @oneOf {
    interval: PeriodIntervalInput
    dates: [PeriodDate!]
  }

  input ReportPeriodInput {
    "Uses PeriodType enum from common/graphql (MONTH, QUARTER, YEAR)"
    type: PeriodType!
    selection: PeriodSelection!
  }

  input AnalyticsExcludeInput {
    report_ids: [ID!]
    entity_cuis: [String!]
    main_creditor_cui: String
    functional_codes: [String!]
    functional_prefixes: [String!]
    economic_codes: [String!]
    economic_prefixes: [String!]
    funding_source_ids: [ID!]
    budget_sector_ids: [ID!]
    expense_types: [ExpenseType!]
    program_codes: [String!]

    county_codes: [String!]
    regions: [String!]
    uat_ids: [ID!]
    entity_types: [String!]
      @deprecated(reason: "Legacy coarse taxonomy. Use tags (kind::/level::/...) instead.")
    "Exclude entities carrying ANY of these faceted tags (namespace::value)."
    tags: [String!]
  }

  input AnalyticsFilterInput {
    # Required scope
    account_category: AccountCategory!
    report_period: ReportPeriodInput!

    # Dimensions
    report_type: ReportType
    main_creditor_cui: String
    report_ids: [ID!]
    entity_cuis: [String!]
    functional_codes: [String!]
    functional_prefixes: [String!]
    economic_codes: [String!]
    economic_prefixes: [String!]
    funding_source_ids: [ID!]
    budget_sector_ids: [ID!]
    expense_types: [ExpenseType!]
    program_codes: [String!]

    # Geography
    county_codes: [String!]
    regions: [String!]
    uat_ids: [ID!]
    entity_types: [String!]
      @deprecated(reason: "Legacy coarse taxonomy. Use tags (kind::/level::/...) instead.")
    is_uat: Boolean
    "Filter executive authorities. When present, entity-scoped per-capita uses selected administrative anchor population, not institution service areas; explicit county/territory scope priority is retained."
    is_territorial_executive: Boolean
    search: String
    """
    Faceted classification tags (namespace::value, e.g. 'kind::hospital').
    OR within a facet, AND across facets. Ancestor roll-up is materialized,
    so 'kind::school' also matches every school subtype.
    """
    tags: [String!]

    # Population & Aggregation
    min_population: Int
    max_population: Int
    aggregate_min_amount: Float
    aggregate_max_amount: Float

    # Transforms
    normalization: Normalization
    inflation_adjusted: Boolean
    currency: Currency
    show_period_growth: Boolean

    # Thresholds
    item_min_amount: Float
    item_max_amount: Float

    # Exclusions
    exclude: AnalyticsExcludeInput
  }

  input AnalyticsInput {
    filter: AnalyticsFilterInput!
    seriesId: String
  }

  """
  A budget sector categorizing budget sources (e.g., local budget, state budget).
  """
  type BudgetSector {
    """
    Unique identifier for the budget sector
    """
    sector_id: ID!
    """
    Human-readable description of the sector
    """
    sector_description: String!
    # TODO: Add executionLineItems nested field for drilling down into line items
    # executionLineItems(limit: Int = 100, offset: Int = 0, reportId: Int, accountCategory: AccountCategory): ExecutionLineItemConnection!
  }

  """
  Pagination metadata for budget sector listing.
  """
  type BudgetSectorPageInfo {
    """
    Total count of matching budget sectors
    """
    totalCount: Int!
    """
    Whether there are more items after current page
    """
    hasNextPage: Boolean!
    """
    Whether there are items before current page
    """
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection of budget sectors.
  """
  type BudgetSectorConnection {
    """
    List of budget sectors in current page
    """
    nodes: [BudgetSector!]!
    """
    Pagination metadata
    """
    pageInfo: BudgetSectorPageInfo!
  }

  """
  Filter options for budget sector listing.
  """
  input BudgetSectorFilterInput {
    """
    Search term for fuzzy matching against sector_description.
    Uses ILIKE and pg_trgm similarity > 0.1.
    """
    search: String
    """
    Filter to specific sector IDs
    """
    sector_ids: [ID!]
  }

  """
  A funding source representing a source of budget funding
  (e.g., State Budget, EU Funds, Own Revenues).
  """
  type FundingSource {
    """
    Unique identifier for the funding source
    """
    source_id: ID!
    """
    Human-readable description of the funding source
    """
    source_description: String!
    """
    Execution line items associated with this funding source.
    Supports pagination and optional filtering by report ID and account category.
    """
    executionLineItems(
      """
      Maximum items to return (default: 100, max: 1000)
      """
      limit: Int = 100
      """
      Number of items to skip (default: 0)
      """
      offset: Int = 0
      """
      Optional filter by report ID
      """
      reportId: String
      """
      Optional filter by account category (vn = income, ch = expense)
      """
      accountCategory: AccountCategory
    ): ExecutionLineItemConnection!
  }

  """
  Pagination metadata for funding source listing.
  """
  type FundingSourcePageInfo {
    """
    Total count of matching funding sources
    """
    totalCount: Int!
    """
    Whether there are more items after current page
    """
    hasNextPage: Boolean!
    """
    Whether there are items before current page
    """
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection of funding sources.
  """
  type FundingSourceConnection {
    """
    List of funding sources in current page
    """
    nodes: [FundingSource!]!
    """
    Pagination metadata
    """
    pageInfo: FundingSourcePageInfo!
  }

  """
  A single execution line item representing budget execution data.
  """
  type ExecutionLineItem {
    """
    Unique identifier for the line item
    """
    line_item_id: ID!
    """
    Report ID this line item belongs to
    """
    report_id: String!
    """
    Year of the budget execution
    """
    year: Int!
    """
    Month of the budget execution (1-12)
    """
    month: Int!
    """
    Entity CUI (fiscal identification code)
    """
    entity_cui: String!
    """
    Account category: vn (income) or ch (expense)
    """
    account_category: AccountCategory!
    """
    Functional classification code (COFOG)
    """
    functional_code: String!
    """
    Economic classification code (may be null for income)
    """
    economic_code: String
    """
    Year-to-date amount
    """
    ytd_amount: Float!
    """
    Monthly amount
    """
    monthly_amount: Float!
    """
    Quarterly amount. Only populated for is_quarterly=true rows.
    """
    quarterly_amount: Float
    """
    Anomaly type if this line item has data quality issues (YTD_ANOMALY, MISSING_LINE_ITEM)
    """
    anomaly: AnomalyType
  }

  """
  Paginated connection of execution line items.
  """
  type ExecutionLineItemConnection {
    """
    List of execution line items in current page
    """
    nodes: [ExecutionLineItem!]!
    """
    Pagination metadata
    """
    pageInfo: FundingSourcePageInfo!
  }

  """
  Filter options for funding source listing.
  """
  input FundingSourceFilterInput {
    """
    Search term for fuzzy matching against source_description.
    Uses ILIKE and pg_trgm similarity > 0.1.
    """
    search: String
    """
    Filter to specific source IDs
    """
    source_ids: [ID!]
  }

  """
  Functional classification (budget function category).
  Represents how budget items are categorized by their functional purpose.
  """
  type FunctionalClassification {
    """
    The unique code for this functional classification (e.g., "01.01").
    """
    functional_code: ID!

    """
    Human-readable name of the functional classification.
    """
    functional_name: String!
  }

  """
  Paginated list of functional classifications.
  """
  type FunctionalClassificationConnection {
    """
    List of functional classifications in this page.
    """
    nodes: [FunctionalClassification!]!

    """
    Pagination info.
    """
    pageInfo: PageInfo!
  }

  """
  Filter input for functional classifications.
  """
  input FunctionalClassificationFilterInput {
    """
    Search by code or name (case-insensitive, partial match).
    """
    search: String

    """
    Filter to specific functional codes.
    """
    functional_codes: [String!]
  }

  """
  Economic classification (budget economic category).
  Represents how budget items are categorized by their economic nature.
  """
  type EconomicClassification {
    """
    The unique code for this economic classification (e.g., "10.01.01").
    """
    economic_code: ID!

    """
    Human-readable name of the economic classification.
    """
    economic_name: String!
  }

  """
  Paginated list of economic classifications.
  """
  type EconomicClassificationConnection {
    """
    List of economic classifications in this page.
    """
    nodes: [EconomicClassification!]!

    """
    Pagination info.
    """
    pageInfo: PageInfo!
  }

  """
  Filter input for economic classifications.
  """
  input EconomicClassificationFilterInput {
    """
    Search by code or name (case-insensitive, partial match).
    """
    search: String

    """
    Filter to specific economic codes.
    """
    economic_codes: [String!]
  }

  extend type Query {
    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!

    """
    List budget sectors with optional filtering and pagination.
    """
    budgetSectors(
      """
      Filter options
      """
      filter: BudgetSectorFilterInput
      """
      Maximum sectors to return (default: 20, max: 200)
      """
      limit: Int = 20
      """
      Number of sectors to skip (default: 0)
      """
      offset: Int = 0
    ): BudgetSectorConnection!

    """
    List funding sources with optional filtering and pagination.
    """
    fundingSources(
      """
      Filter options
      """
      filter: FundingSourceFilterInput
      """
      Maximum sources to return (default: 10, max: 200)
      """
      limit: Int = 10
      """
      Number of sources to skip (default: 0)
      """
      offset: Int = 0
    ): FundingSourceConnection!

    """
    List functional classifications with optional filtering and pagination.
    """
    functionalClassifications(
      """
      Optional filter criteria.
      """
      filter: FunctionalClassificationFilterInput

      """
      Maximum items to return (default: 100, max: 1000).
      """
      limit: Int = 100

      """
      Number of items to skip (default: 0).
      """
      offset: Int = 0
    ): FunctionalClassificationConnection!

    """
    List economic classifications with optional filtering and pagination.
    """
    economicClassifications(
      """
      Optional filter criteria.
      """
      filter: EconomicClassificationFilterInput

      """
      Maximum items to return (default: 100, max: 1000).
      """
      limit: Int = 100

      """
      Number of items to skip (default: 0).
      """
      offset: Int = 0
    ): EconomicClassificationConnection!
  }
`;

/** The legacy definitions this slice carries and the legacy file each comes from. */
export const BUDGET_LEGACY_SDL_PROVENANCE = {
  'src/infra/graphql/common/directives.ts': ['directive @oneOf'],
  'src/infra/graphql/common/scalars.ts': ['scalar PeriodDate'],
  'src/infra/graphql/common/enums.ts': ['enum Currency', 'enum ReportType', 'enum PeriodType'],
  'src/modules/execution-analytics/shell/graphql/schema.ts': [
    'enum AxisDataType',
    'enum AccountCategory',
    'enum Normalization',
    'enum ExpenseType',
    'enum AnomalyType',
    'type Axis',
    'type AnalyticsDataPoint',
    'type AnalyticsSeries',
    'input PeriodIntervalInput',
    'input PeriodSelection',
    'input ReportPeriodInput',
    'input AnalyticsExcludeInput',
    'input AnalyticsFilterInput',
    'input AnalyticsInput',
    'Query.executionAnalytics',
  ],
  'src/modules/budget-sector/shell/graphql/schema.ts': [
    'type BudgetSector',
    'type BudgetSectorPageInfo',
    'type BudgetSectorConnection',
    'input BudgetSectorFilterInput',
    'Query.budgetSectors',
  ],
  'src/modules/funding-sources/shell/graphql/schema.ts': [
    'type FundingSource',
    'type FundingSourcePageInfo',
    'type FundingSourceConnection',
    'type ExecutionLineItem',
    'type ExecutionLineItemConnection',
    'input FundingSourceFilterInput',
    'Query.fundingSources',
  ],
  'src/modules/classification/shell/graphql/schema.ts': [
    'type FunctionalClassification',
    'type FunctionalClassificationConnection',
    'input FunctionalClassificationFilterInput',
    'type EconomicClassification',
    'type EconomicClassificationConnection',
    'input EconomicClassificationFilterInput',
    'Query.functionalClassifications',
    'Query.economicClassifications',
  ],
} as const;

/**
 * Collision resolutions (design 13 §3) — NOT legacy text, so they live beside
 * the carried SDL, outside the byte-identity fixture:
 *  - `PageInfo`: the legacy classification connections use the common legacy
 *    `PageInfo` (`totalCount`, `hasPreviousPage`, `startCursor`); the kernel base
 *    type has only `hasNextPage` / `endCursor`, so the slice EXTENDS it with the
 *    missing fields, nullable on the type (legacy resolvers populate them; kernel
 *    connections leave them null). The INS interim slice (`src/app/ins-interim-surface.ts`)
 *    depends on this extension too; the merge gate rejects a second owner.
 *  - `Query.budgetSectors` / `type BudgetSector`: the legacy signature and type
 *    win (client-used); the kernel's own catalog root is `budgetSectorCatalog`
 *    returning `BudgetSectorCatalogEntry` (new API, no client uses it).
 */
export const budgetLegacyCollisionTypeDefs = /* GraphQL */ `
  extend type PageInfo {
    "Total count of items matching the query (legacy connections; null on kernel connections)"
    totalCount: Int
    "Indicates if there are more pages before the current page (legacy connections; null on kernel connections)"
    hasPreviousPage: Boolean
    "Cursor of the first edge in the page (legacy connections; null on kernel connections)"
    startCursor: String
  }
`;
