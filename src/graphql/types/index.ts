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

  # Aggregation types
  type BudgetTotals {
    revenue: Float!
    expense: Float!
    balance: Float!
  }

  type FunctionalCodeTotal {
    functional_code: String!
    functional_name: String!
    total: Float!
    percentage: Float!
  }

  # Type representing aggregated metrics for a UAT
  type UATAggregatedMetrics {
    reporting_year: Int!
    reporting_period: String!
    uat_id: Int!
    uat_code: String!
    uat_name: String!
    county_code: String
    county_name: String
    uat_region: String
    uat_population: Int
    total_income: Float!
    total_expense: Float!
    budget_balance: Float!
    per_capita_income: Float
    per_capita_expense: Float
    # Relation back to the UAT dimension
    uat: UAT # Resolver needed
  }

  type UATAggregatedMetricsConnection {
    nodes: [UATAggregatedMetrics!]!
    pageInfo: PageInfo!
  }

  # Type representing aggregated metrics for a County
  type CountyAggregatedMetrics {
    reporting_year: Int!
    reporting_period: String!
    county_code: String!
    county_name: String!
    uat_region: String
    total_county_population: Int
    total_income: Float!
    total_expense: Float!
    budget_balance: Float!
    per_capita_income: Float
    per_capita_expense: Float
  }

  type CountyAggregatedMetricsConnection {
    nodes: [CountyAggregatedMetrics!]!
    pageInfo: PageInfo!
  }

  # Type representing aggregated metrics by category
  type CategoryAggregatedMetrics {
    reporting_year: Int!
    reporting_period: String!
    account_category: String!
    functional_code: String!
    functional_name: String!
    economic_code: String
    economic_name: String
    funding_source_id: Int!
    funding_source: String!
    county_name: String
    uat_region: String
    total_amount: Float!
    contributing_entities_count: Int
  }

  type CategoryAggregatedMetricsConnection {
    nodes: [CategoryAggregatedMetrics!]!
    pageInfo: PageInfo!
  }

  # Type for time series data points
  type TimeSeriesDataPoint {
    year: Int!
    period: String! # Or potentially just year if aggregating annually
    value: Float!
  }

  # Type for comparison results
  type ComparisonData {
    uat_id: Int!
    uat_name: String!
    metric_name: String!
    value: Float!
  }

  # Input types for filtering
  input EntityFilter {
    cui: String
    name: String
    sector_type: String
    uat_id: Int
    address: String
  }

  input UATFilter {
    id: Int
    uat_key: String
    uat_code: String
    name: String
    county_code: String
    region: String
  }

  input ReportFilter {
    entity_cui: String
    reporting_year: Int
    reporting_period: String
    report_date_start: String
    report_date_end: String
  }

  input ExecutionLineItemFilter {
    report_id: Int
    report_ids: [Int]
    entity_cui: String
    funding_source_id: Int
    functional_code: String
    economic_code: String
    account_category: String
    min_amount: Float
    max_amount: Float
    program_code: String
    reporting_year: Int
    county_code: String
    uat_id: Int
    year: Int
    years: [Int]
    start_year: Int
    end_year: Int
  }

  # More specific filter for UAT Aggregated Metrics
  input UATAggregatedMetricsFilter {
    reporting_year: Int
    reporting_years: [Int] # Allow filtering by multiple years
    reporting_period: String
    reporting_periods: [String] # Allow filtering by multiple periods
    uat_id: Int
    uat_ids: [Int]
    uat_code: String
    uat_codes: [String]
    county_code: String
    county_codes: [String]
    region: String
    regions: [String]
    min_population: Int
    max_population: Int
  }

  # Filter for County Aggregated Metrics
  input CountyAggregatedMetricsFilter {
    reporting_year: Int
    reporting_years: [Int]
    reporting_period: String
    reporting_periods: [String]
    county_code: String
    county_codes: [String]
    region: String
    regions: [String]
  }

  # Filter for Category Aggregated Metrics
  input CategoryAggregatedMetricsFilter {
    reporting_year: Int
    reporting_years: [Int]
    reporting_period: String
    reporting_periods: [String]
    account_category: String # 'vn' or 'ch'
    functional_code: String
    functional_codes: [String]
    economic_code: String
    economic_codes: [String]
    funding_source_id: Int
    funding_source_ids: [Int]
    county_name: String
    county_names: [String]
    region: String
    regions: [String]
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
    fundingSources: [FundingSource!]!
    
    # Line item queries
    executionLineItem(id: ID!): ExecutionLineItem
    executionLineItems(
      filter: ExecutionLineItemFilter
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
      sortBy: [MetricSortCriteria!] # Allow sorting by multiple metrics
      limit: Int = 20
      offset: Int = 0
    ): UATAggregatedMetricsConnection!

    # Query aggregated metrics for Counties
    countyAggregatedMetrics(
      filter: CountyAggregatedMetricsFilter
      sortBy: [MetricSortCriteria!]
      limit: Int = 20
      offset: Int = 0
    ): CountyAggregatedMetricsConnection!

    # Query aggregated metrics by Category
    categoryAggregatedMetrics(
      filter: CategoryAggregatedMetricsFilter
      sortBy: [MetricSortCriteria!] # e.g., sort by total_amount
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