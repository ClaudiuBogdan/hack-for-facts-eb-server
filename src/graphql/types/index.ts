export const types = `
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
    sector_type: String
    uat_id: Int
    address: String
    last_updated: String
    # Relations
    uat: UAT
    reports(
      limit: Int
      offset: Int
      year: Int
      period: String
    ): ReportConnection!
    executionLineItems(
      filter: ExecutionLineItemFilter
      limit: Int
      offset: Int
    ): ExecutionLineItemConnection!
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
      reportId: Int
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
      reportId: Int
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
      reportId: Int
      accountCategory: String
    ): ExecutionLineItemConnection!
  }

  type Report {
    report_id: ID!
    entity_cui: String!
    report_date: String!
    reporting_year: Int!
    reporting_period: String!
    file_source: String
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
    # Aggregations
    budgetTotals: BudgetTotals!
    topFunctionalCodesExpense(limit: Int): [FunctionalCodeTotal!]!
    topFunctionalCodesRevenue(limit: Int): [FunctionalCodeTotal!]!
  }

  type ReportConnection {
    nodes: [Report!]!
    pageInfo: PageInfo!
  }

  type ExecutionLineItem {
    line_item_id: ID!
    report_id: Int!
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
    sector_type: String
    uat_id: Int
    address: String
    search: String
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
    report_id: Int
    report_ids: [Int]
    entity_cuis: [String]
    funding_source_id: Int
    functional_codes: [String]
    economic_codes: [String]
    account_categories: [String]
    min_amount: Float
    max_amount: Float
    program_code: String
    reporting_year: Int
    county_code: String
    uat_ids: [Int]
    year: Int
    years: [Int]
    start_year: Int
    end_year: Int
    search: String
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

  input MetricSortCriteria {
    metric: String! # e.g., "total_expense", "per_capita_income", "budget_balance"
    direction: SortDirection!
  }

  # Anomaly detection types
  type SpendingAnomaly {
    entity_cui: String!
    entity_name: String!
    report_id: Int!
    report_date: String!
    reporting_period: String!
    functional_code: String!
    functional_name: String!
    economic_code: String
    economic_name: String
    amount: Float!
    average_amount: Float!
    deviation_percentage: Float!
    score: Float!
  }

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
    
    # Analytics queries
    entityBudgetTimeline(
      cui: ID!
      startYear: Int
      endYear: Int
    ): [Report!]!
    
    # Anomaly detection
    spendingAnomalies(
      year: Int!
      period: String
      minDeviationPercentage: Float = 50
      limit: Int = 10
    ): [SpendingAnomaly!]!

    # Query aggregated metrics for UATs
    uatAggregatedMetrics(
      filter: UATAggregatedMetricsFilter
      sort: [MetricSortCriteria!] # Allow sorting by multiple metrics
      limit: Int = 20
      offset: Int = 0
    ): UATAggregatedMetricsConnection!

    # Query aggregated metrics for Counties
    countyAggregatedMetrics(
      filter: CountyAggregatedMetricsFilter
      sort: [MetricSortCriteria!]
      limit: Int = 20
      offset: Int = 0
    ): CountyAggregatedMetricsConnection!

    # Query aggregated metrics by Category
    categoryAggregatedMetrics(
      filter: CategoryAggregatedMetricsFilter
      sort: [MetricSortCriteria!] # e.g., sort by total_amount
      limit: Int = 50
      offset: Int = 0
    ): CategoryAggregatedMetricsConnection!

    # Query for generating time series data for a specific metric
    metricTimeSeries(
      metric: String! # e.g., "total_expense", "per_capita_income"
      groupBy: String! # e.g., "year", "period"
      filter: UATAggregatedMetricsFilter # Filter by UAT, county, region etc.
    ): [TimeSeriesDataPoint!]!

    # Query designed for comparing specific entities or UATs side-by-side
    compareItems(
      itemType: String! # "UAT" or "Entity"
      itemIds: [ID!]! # List of UAT IDs or Entity CUIs to compare
      metrics: [String!]! # List of metrics, e.g., ["total_expense", "per_capita_expense", "budget_balance"]
      reporting_year: Int!
      reporting_period: String!
    ): [ComparisonData!]!
  }
`;