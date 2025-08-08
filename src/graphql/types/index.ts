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
      filter: ExecutionLineItemFilter
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
  }

  input ReportFilter {
    entity_cui: String
    reporting_year: Int
    reporting_period: String
    report_date_start: String
    report_date_end: String
    search: String
  }

  input ExecutionLineItemFilter {
    report_id: String
    report_ids: [String]
    report_type: String
    entity_cuis: [String]
    funding_source_id: ID
    funding_source_ids: [ID]
    functional_codes: [String]
    economic_codes: [String]
    account_categories: [AccountCategory]
    account_category: AccountCategory
    min_amount: Float
    max_amount: Float
    program_code: String
    reporting_year: Int
    county_code: String
    uat_ids: [ID]
    year: Int
    years: [Int]
    start_year: Int
    end_year: Int
    entity_types: [String]
    is_uat: Boolean
    functional_prefixes: [String]
    economic_prefixes: [String]
    budget_sector_id: ID
    budget_sector_ids: [ID]
    expense_types: [String]
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

  # Input filters for querying heatmap data
  input HeatmapFilterInput {
    functional_codes: [String!]    # Optional: filter by functional classification codes
    economic_codes: [String!]      # Optional: filter by economic classification codes
    account_categories: [AccountCategory!]! # Mandatory: e.g., [ch] for expenses, [vn] for income
    years: [Int!]!                 # Mandatory: list of years to include
    min_amount: Float              # Optional: filter individual line items by minimum amount
    max_amount: Float              # Optional: filter individual line items by maximum amount
    normalization: String          # Optional: 'total' or 'per_capita'
    min_population: Int            # Optional: filter UATs by minimum population
    max_population: Int            # Optional: filter UATs by maximum population
    county_codes: [String!]        # Optional: to focus heatmap on specific counties
    regions: [String!]             # Optional: to focus heatmap on specific regions
  }

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

  input EntityAnalyticsFilterInput {
    # Required aggregation scope
    account_category: AccountCategory!
    years: [Int!]!

    # Execution line item filters
    report_id: ID
    report_ids: [ID]
    report_type: String
    entity_cuis: [String]
    functional_codes: [String]
    functional_prefixes: [String]
    economic_codes: [String]
    economic_prefixes: [String]
    funding_source_id: ID
    funding_source_ids: [ID]
    budget_sector_id: ID
    budget_sector_ids: [ID]
    expense_types: [String]
    program_code: String
    reporting_year: Int
    county_code: String
    county_codes: [String]
    uat_ids: [ID]
    entity_types: [String]
    is_uat: Boolean

    # Entity-level filters
    search: String

    # Aggregated constraints & transforms
    min_amount: Float
    max_amount: Float
    normalization: String # 'total' or 'per-capita' (also accept 'per_capita')
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
    filter: ExecutionLineItemFilter!
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
      filter: ExecutionLineItemFilter
      sort: SortOrder
      limit: Int
      offset: Int
    ): ExecutionLineItemConnection!
    
    # Query for UAT-level heatmap data
    heatmapUATData(filter: HeatmapFilterInput!): [HeatmapUATDataPoint!]!
    heatmapJudetData(filter: HeatmapFilterInput!): [HeatmapJudetDataPoint!]!

    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsResult!]!

    # Entities analytics with flexible filters and sorting
    entityAnalytics(
      filter: EntityAnalyticsFilterInput!
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