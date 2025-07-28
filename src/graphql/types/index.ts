export const types = `
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

  type FunctionalClassification {
    functional_code: ID!
    functional_name: String!
    # Relations
    executionLineItems(
      limit: Int
      offset: Int
      reportId: String
      accountCategory: String
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
      accountCategory: String
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
      accountCategory: String
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
      accountCategory: String
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
    account_category: String!
    amount: Float!
    program_code: String
    year: Int!
    # Relations
    report: Report!
    entity: Entity!
    fundingSource: FundingSource!
    functionalClassification: FunctionalClassification!
    economicClassification: EconomicClassification
  }

  type ExecutionLineItemConnection {
    nodes: [ExecutionLineItem!]!
    pageInfo: PageInfo!
  }


  # Input types for filtering
  input EntityFilter {
    cui: String
    name: String
    entity_type: String
    uat_id: ID
    address: String
    search: String
    is_uat: Boolean
  }

  input UATFilter {
    id: Int
    uat_key: String
    uat_code: String
    name: String
    county_code: String
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
    funding_source_id: Int
    functional_codes: [String]
    economic_codes: [String]
    account_categories: [String]
    account_category: String
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
    budget_sector_id: Int
    budget_sector_ids: [Int]
    expense_types: [String]
  }

  input SortOrder {
    by: String!
    order: String!
  }

  # Input for defining sorting criteria
  enum SortDirection {
    ASC
    DESC
  }

  # --- START: Types for Heatmap Analytics ---

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

  # Input filters for querying heatmap data
  input HeatmapFilterInput {
    functional_codes: [String!]    # Optional: filter by functional classification codes
    economic_codes: [String!]      # Optional: filter by economic classification codes
    account_categories: [String!]! # Mandatory: e.g., ["ch"] for expenses, ["vn"] for income
    years: [Int!]!                 # Mandatory: list of years to include
    min_amount: Float              # Optional: filter individual line items by minimum amount
    max_amount: Float              # Optional: filter individual line items by maximum amount
    normalization: String          # Optional: 'total' or 'per_capita'
    min_population: Int            # Optional: filter UATs by minimum population
    max_population: Int            # Optional: filter UATs by maximum population
    # county_codes: [String!]      # Optional: to focus heatmap on specific counties
    # regions: [String!]           # Optional: to focus heatmap on specific regions
  }

  # --- END: Types for Heatmap Analytics ---

  input FunctionalClassificationFilterInput {
    search: String
  }

  input EconomicClassificationFilterInput {
    search: String
  }

  # Input for Funding Source filtering
  input FundingSourceFilterInput {
    search: String
  }

  # Connection type for FundingSource
  type FundingSourceConnection {
    nodes: [FundingSource!]!
    pageInfo: PageInfo!
  }

  input AnalyticsInput {
    filter: ExecutionLineItemFilter!
    seriesId: String
  }

  type AnalyticsResult {
    seriesId: String
    totalAmount: Float!
    yearlyTrend: [YearlyAmount!]!
  }

  # Query root type
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

    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsResult!]!
  }
`;