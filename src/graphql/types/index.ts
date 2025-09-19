export const types = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Scalars & Directives
  # ---------------------------------------------------------------------------
  "A string representing a Year (YYYY), Year-Month (YYYY-MM), or Year-Quarter (YYYY-Q[1-4])"
  scalar PeriodDate

  directive @oneOf on INPUT_OBJECT

  # ---------------------------------------------------------------------------
  # Enums
  # ---------------------------------------------------------------------------
  # Utility Types
  # Axis metadata and analytics series types
  
  enum AxisDataType {
    STRING
    INTEGER
    FLOAT
    DATE
  }

  enum ReportType {
    PRINCIPAL_AGGREGATED
    SECONDARY_AGGREGATED
    DETAILED
  }

  # Sorting helpers
  enum SortDirection {
    ASC
    DESC
  }

  # Budget account categories (income vs expenses)
  enum AccountCategory {
    vn
    ch
  }

  # Normalization mode for aggregated values
  enum Normalization {
    total
    total_euro
    per_capita
    per_capita_euro
  }

  # ExpenseType mirrors DB enum
  enum ExpenseType {
    dezvoltare
    functionare
  }

  # ------------------------------
  # Report Period Inputs
  # ------------------------------
  enum ReportPeriodType {
    MONTH
    QUARTER
    YEAR
  }

  # ---------------------------------------------------------------------------
  # Shared Utility Types
  # ---------------------------------------------------------------------------
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

  # Pagination type to handle paginated queries
  type PageInfo {
    totalCount: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
  }

  input SortOrder {
    by: String!
    order: String!
  }

  # ---------------------------------------------------------------------------
  # Period Selection Inputs
  # ---------------------------------------------------------------------------
  "Closed interval with period precision (inclusive)."
  input PeriodIntervalInput {
    start: PeriodDate!
    end: PeriodDate!
  }

  "Exactly one of {interval, dates} must be supplied."
  input PeriodSelection @oneOf {
    interval: PeriodIntervalInput
    dates: [PeriodDate!]
  }

  "Mandatory type + a mutually exclusive selection."
  input ReportPeriodInput {
    type: ReportPeriodType!
    selection: PeriodSelection!
  }

  # ---------------------------------------------------------------------------
  # Filters & Inputs
  # ---------------------------------------------------------------------------
  # Input types for filtering
  input EntityFilter {
    cui: String
    cuis: [String]
    name: String
    entity_type: String
    uat_id: ID
    address: String
    search: String
    is_uat: Boolean
    parents: [String]
  }

  input UATFilter {
    id: Int
    ids: [String]
    uat_key: String
    uat_code: String
    name: String
    county_code: String
    county_name: String
    region: String
    search: String
    is_county: Boolean
  }

  input ReportFilter {
    entity_cui: String
    reporting_year: Int
    reporting_period: String
    report_type: ReportType
    report_date_start: String
    report_date_end: String
    main_creditor_cui: String
    search: String
  }

  # Unified analytics filter used by heatmaps, entity analytics, and line items
  input AnalyticsFilterInput {
    # Required scope
    account_category: AccountCategory!
    report_period: ReportPeriodInput!        # Preferred period selector (month/quarter/year via month anchors)
    
    # Line-item dimensional filters
    report_type: ReportType                  # Used by: all. Heatmaps filter contributing report types.
    main_creditor_cui: String      # Used by: all.
    report_ids: [ID!]              # Used by: all. Heatmaps filter contributing reports.
    entity_cuis: [String!]         # Used by: all. Heatmaps constrain contributing entities.
    functional_codes: [String!]
    functional_prefixes: [String!]
    economic_codes: [String!]
    economic_prefixes: [String!]
    funding_source_ids: [ID!]      # Used by: all. Heatmaps constrain contributing items.
    budget_sector_ids: [ID!]       # Used by: all. Heatmaps constrain contributing items.
    expense_types: [ExpenseType!]  # Used by: all. Heatmaps constrain contributing items.
    program_codes: [String!]       # Used by: all. Heatmaps constrain contributing items.

    # Geography / entity scope
    county_codes: [String!]        # Used by: all. Heatmaps limit geography.
    regions: [String!]             # Used by: heatmaps to limit geography.
    uat_ids: [ID!]                 # Used by: all. Heatmaps limit UATs subset.
    entity_types: [String!]        # Used by: all. Heatmaps constrain contributing entities.
    is_uat: Boolean                # Used by: all. Heatmaps constrain contributing entities.
    search: String                 # Used by: entityAnalytics. Ignored by: heatmaps, executionLineItems, executionAnalytics

    # Population constraints (missing treated as 0)
    min_population: Int            # Used by: heatmaps, entityAnalytics. Ignored by: executionLineItems, executionAnalytics
    max_population: Int            # Used by: heatmaps, entityAnalytics. Ignored by: executionLineItems, executionAnalytics

    # Aggregated constraints & transforms
    normalization: Normalization   # Used by: heatmaps, entityAnalytics. Ignored by: executionLineItems, executionAnalytics
    aggregate_min_amount: Float    # Used by: heatmaps, entityAnalytics. Ignored by: executionLineItems, executionAnalytics
    aggregate_max_amount: Float    # Used by: heatmaps, entityAnalytics. Ignored by: executionLineItems, executionAnalytics

    # Per-item thresholds
    item_min_amount: Float         # Used by: all. 
    item_max_amount: Float         # Used by: all.
  }

  input FunctionalClassificationFilterInput {
    search: String
    functional_codes: [String]
  }

  input EconomicClassificationFilterInput {
    search: String
    economic_codes: [String]
  }

  # Input for Funding Source filtering
  input FundingSourceFilterInput {
    search: String
    source_ids: [String]
  }

  input BudgetSectorFilterInput {
    search: String
    sector_ids: [String]
  }

  input AnalyticsInput {
    filter: AnalyticsFilterInput!
    seriesId: String
  }

  # Legacy AnalyticsResult removed in favor of AnalyticsSeries

  # ---------------------------------------------------------------------------
  # Core Domain Types
  # ---------------------------------------------------------------------------
  # UAT (Unitate Administrativ-Teritoriala) type
  type UAT {
    id: ID!
    uat_key: String!
    uat_code: String!
    siruta_code: String!
    name: String!
    county_code: String
    county_name: String
    region: String
    population: Int
    last_updated: String
    county_entity: Entity
  }

  type UATConnection {
    nodes: [UAT!]!
    pageInfo: PageInfo!
  }

  # Basic types mapping to database tables
  type Entity {
    cui: ID!
    name: String!
    entity_type: String
    default_report_type: ReportType!
    uat_id: ID
    is_uat: Boolean
    is_main_creditor: Boolean # This is not a reliable flag, as an entity can change their creditor status over time. Check report type for main creditor executions.
    address: String
    last_updated: String
    # Relations
    uat: UAT
    children: [Entity!]!
    parents: [Entity!]!
    reports(
      limit: Int
      offset: Int
      year: Int
      period: String
      type: ReportType
      sort: SortOrder
      main_creditor_cui: String
    ): ReportConnection!
    executionLineItems(
      filter: AnalyticsFilterInput
      limit: Int
      offset: Int
      sort: SortOrder
    ): ExecutionLineItemConnection!
    totalIncome(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization, main_creditor_cui: String): Float
    totalExpenses(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization, main_creditor_cui: String): Float
    budgetBalance(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization, main_creditor_cui: String): Float
    incomeTrend(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization = total, main_creditor_cui: String): AnalyticsSeries!
    expensesTrend(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization = total, main_creditor_cui: String): AnalyticsSeries!
    balanceTrend(period: ReportPeriodInput!, reportType: ReportType, normalization: Normalization = total, main_creditor_cui: String): AnalyticsSeries!
  }

  type EntityConnection {
    nodes: [Entity!]!
    pageInfo: PageInfo!
  }

  type Report {
    report_id: ID!
    entity_cui: String!
    report_date: String!
    reporting_year: Int!
    reporting_period: String!
    download_links: [String!]!
    report_type: ReportType!
    main_creditor: Entity!
    import_timestamp: String!
    # Relations
    entity: Entity!
    executionLineItems(
      limit: Int
      offset: Int
      functionalCode: String
      economicCode: String
      accountCategory: AccountCategory
      minAmount: Float
      maxAmount: Float
    ): ExecutionLineItemConnection!
  }

  type ReportConnection {
    nodes: [Report!]!
    pageInfo: PageInfo!
  }

  type ExecutionLineItem {
    line_item_id: ID!
    report_id: String!
    entity_cui: String!
    funding_source_id: Int!
    functional_code: String!
    economic_code: String
    account_category: AccountCategory!
    program_code: String
    year: Int!
    month: Int!
    quarter: Int
    ytd_amount: Float!
    monthly_amount: Float!
    quarterly_amount: Float
    # Relations
    report: Report!
    entity: Entity!
    fundingSource: FundingSource!
    budgetSector: BudgetSector!
    functionalClassification: FunctionalClassification!
    economicClassification: EconomicClassification
  }

  type ExecutionLineItemConnection {
    nodes: [ExecutionLineItem!]!
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Classification Types
  # ---------------------------------------------------------------------------
  type FunctionalClassification {
    functional_code: ID!
    functional_name: String!
    # Relations
    executionLineItems(
      limit: Int
      offset: Int
      reportId: String
      accountCategory: AccountCategory
    ): ExecutionLineItemConnection!
  }

  type FunctionalClassificationConnection {
    nodes: [FunctionalClassification!]!
    pageInfo: PageInfo!
  }

  type EconomicClassification {
    economic_code: ID!
    economic_name: String!
    # Relations
    executionLineItems(
      limit: Int
      offset: Int
      reportId: String
      accountCategory: AccountCategory
    ): ExecutionLineItemConnection!
  }

  type EconomicClassificationConnection {
    nodes: [EconomicClassification!]!
    pageInfo: PageInfo!
  }

  type FundingSource {
    source_id: ID!
    source_description: String!
    # Relations
    executionLineItems(
      limit: Int
      offset: Int
      reportId: String
      accountCategory: AccountCategory
    ): ExecutionLineItemConnection!
  }

  type FundingSourceConnection {
    nodes: [FundingSource!]!
    pageInfo: PageInfo!
  }

  # Budget Sectors
  type BudgetSector {
    sector_id: ID!
    sector_description: String!
    # Relations
    executionLineItems(
      limit: Int
      offset: Int
      reportId: String
      accountCategory: String
    ): ExecutionLineItemConnection!
  }

  type BudgetSectorConnection {
    nodes: [BudgetSector!]!
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Analytics Types
  # ---------------------------------------------------------------------------
  # Data point for UAT-level heatmap visualization
  type HeatmapUATDataPoint {
    uat_id: ID!
    uat_code: String!       # For client-side mapping to GeoJSON properties
    uat_name: String!       # For display
    siruta_code: String!    # Unique identifier for UATs
    county_code: String     # For context or potential county-level roll-up view
    county_name: String     # For display
    population: Int         # For per-capita calculations by the client
    amount: Float!          # The calculated sum based on filters
    total_amount: Float!    # The calculated sum based on filters
    per_capita_amount: Float! # The calculated per-capita amount based on filters
  }

  type HeatmapCountyDataPoint {
    county_code: String!
    county_name: String!
    county_population: Int!
    amount: Float!
    total_amount: Float!
    per_capita_amount: Float!
    county_entity: Entity
  }

  # Input filters for querying heatmap data are unified under AnalyticsFilterInput

  # --- END: Types for Heatmap Analytics ---

  # ---------------------------------------------------------------------------
  # Entity Analytics Types
  # ---------------------------------------------------------------------------
  type EntityAnalyticsDataPoint {
    entity_cui: ID!
    entity_name: String!
    entity_type: String
    uat_id: ID
    county_code: String
    county_name: String
    population: Int
    amount: Float!
    total_amount: Float!
    per_capita_amount: Float!
  }

  type EntityAnalyticsConnection {
    nodes: [EntityAnalyticsDataPoint!]!
    pageInfo: PageInfo!
  }

  type AggregatedLineItem {
    functional_code: String!
    functional_name: String!
    economic_code: String!
    economic_name: String!
    amount: Float!
    count: Int!
  }

  type AggregatedLineItemConnection {
    nodes: [AggregatedLineItem!]!
    pageInfo: PageInfo!
  }

  # Entity analytics uses AnalyticsFilterInput

  # ---------------------------------------------------------------------------
  # Dataset Types
  # ---------------------------------------------------------------------------
  type Dataset {
    id: ID!
    name: String!
    unit: String!
    description: String
    sourceName: String
    sourceUrl: String
  }

  type DatasetConnection {
    nodes: [Dataset!]!
    pageInfo: PageInfo!
  }

  input DatasetFilter {
    search: String
    ids: [ID!]
  }

  # Legacy StaticAnalyticsDataPoint removed in favor of AnalyticsSeries

  # ---------------------------------------------------------------------------
  # Root Query
  # ---------------------------------------------------------------------------
  type Query {
    # Basic entity queries
    entity(cui: ID!): Entity
    entities(
      filter: EntityFilter
      limit: Int
      offset: Int
    ): EntityConnection!
    
    # UAT queries
    uat(id: ID!): UAT
    uats(
      filter: UATFilter
      limit: Int
      offset: Int
    ): UATConnection!
    
    # Report queries
    report(report_id: ID!): Report
    reports(
      filter: ReportFilter
      limit: Int
      offset: Int
    ): ReportConnection!
    
    # Classification queries
    functionalClassification(code: ID!): FunctionalClassification
    functionalClassifications(
      filter: FunctionalClassificationFilterInput
      limit: Int
      offset: Int
    ): FunctionalClassificationConnection!
    
    economicClassification(code: ID!): EconomicClassification
    economicClassifications(
      filter: EconomicClassificationFilterInput
      limit: Int
      offset: Int
    ): EconomicClassificationConnection!
    
    fundingSource(id: ID!): FundingSource
    fundingSources(
      filter: FundingSourceFilterInput
      limit: Int
      offset: Int
    ): FundingSourceConnection!
    
    budgetSector(id: ID!): BudgetSector
    budgetSectors(
      filter: BudgetSectorFilterInput
      limit: Int
      offset: Int
    ): BudgetSectorConnection!
    
    # Line item queries
    executionLineItem(id: ID!): ExecutionLineItem
    executionLineItems(
      filter: AnalyticsFilterInput
      sort: SortOrder
      limit: Int
      offset: Int
    ): ExecutionLineItemConnection!
    
    # Query for UAT-level heatmap data
    heatmapUATData(filter: AnalyticsFilterInput!): [HeatmapUATDataPoint!]!
    heatmapCountyData(filter: AnalyticsFilterInput!): [HeatmapCountyDataPoint!]!

    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!

    # Entities analytics with flexible filters and sorting
    entityAnalytics(
      filter: AnalyticsFilterInput!
      sort: SortOrder
      limit: Int = 50
      offset: Int = 0
    ): EntityAnalyticsConnection!

    # Query to search for datasets with pagination
    datasets(filter: DatasetFilter, limit: Int = 100, offset: Int = 0): DatasetConnection!
 
    # Query to fetch analytics data for a list of dataset IDs
    staticChartAnalytics(seriesIds: [ID!]!): [AnalyticsSeries!]!

    aggregatedLineItems(
      filter: AnalyticsFilterInput!
      limit: Int = 50
      offset: Int = 0
    ): AggregatedLineItemConnection!
  }
`;
