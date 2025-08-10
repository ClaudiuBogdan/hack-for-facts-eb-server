export const types = /* GraphQL */ `
  # Utility Types
  type YearlyAmount {
    year: Int!
    totalAmount: Float!
  }

  # Pagination type to handle paginated queries
  type PageInfo {
    totalCount: Int!
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
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
    per_capita
  }

  # ExpenseType mirrors DB enum
  enum ExpenseType {
    dezvoltare
    functionare
  }

  input SortOrder {
    by: String!
    order: String!
  }

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
    uat_id: ID
    is_uat: Boolean
    is_main_creditor: Boolean
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
      sort: SortOrder
    ): ReportConnection!
    executionLineItems(
      filter: AnalyticsFilterInput
      limit: Int
      offset: Int
      sort: SortOrder
    ): ExecutionLineItemConnection!
    totalIncome(year: Int!): Float
    totalExpenses(year: Int!): Float
    budgetBalance(year: Int!): Float
    incomeTrend(startYear: Int!, endYear: Int!): [YearlyAmount!]!
    expenseTrend(startYear: Int!, endYear: Int!): [YearlyAmount!]!
    balanceTrend(startYear: Int!, endYear: Int!): [YearlyAmount!]!
  }

  type EntityConnection {
    nodes: [Entity!]!
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

  type Report {
    report_id: ID!
    entity_cui: String!
    report_date: String!
    reporting_year: Int!
    reporting_period: String!
    download_links: [String!]!
    report_type: String!
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
    amount: Float!
    program_code: String
    year: Int!
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
    report_date_start: String
    report_date_end: String
    search: String
  }

  # Unified analytics filter used by heatmaps, entity analytics, and line items
  input AnalyticsFilterInput {
    # Required scope
    years: [Int!]!
    account_category: AccountCategory!

    # Line-item dimensional filters
    report_ids: [ID!]              # Used by: all. Heatmaps filter contributing reports.
    report_type: String        # Used by: all. Heatmaps filter contributing report types.
    reporting_years: [Int!]        # Used by: all. Heatmaps join Reports to filter by year.
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

  type HeatmapJudetDataPoint {
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

  # Entity analytics uses AnalyticsFilterInput

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

  input BudgetSectorFilterInput {
    search: String
    sector_ids: [String]
  }

  input AnalyticsInput {
    filter: AnalyticsFilterInput!
    seriesId: String
  }

  type AnalyticsResult {
    seriesId: String
    totalAmount: Float!
    unit: String
    yearlyTrend: [YearlyAmount!]!
  }

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

  type StaticAnalyticsDataPoint {
    datasetId: ID!
    unit: String!
    yearlyTrend: [YearlyAmount!]!
  }

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
    heatmapJudetData(filter: AnalyticsFilterInput!): [HeatmapJudetDataPoint!]!

    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsResult!]!

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
    staticChartAnalytics(datasetIds: [ID!]!): [StaticAnalyticsDataPoint!]!
  }
`;