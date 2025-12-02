export const ExecutionAnalyticsSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Enums (Domain-Specific)
  # ---------------------------------------------------------------------------
  # Note: Common enums like SortDirection, Currency are defined in common/graphql

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

  # ---------------------------------------------------------------------------
  # Period Selection Inputs
  # ---------------------------------------------------------------------------
  # Note: SortOrder is defined in common/graphql
  input PeriodIntervalInput {
    start: PeriodDate!
    end: PeriodDate!
  }

  input PeriodSelection @oneOf {
    interval: PeriodIntervalInput
    dates: [PeriodDate!]
  }

  input ReportPeriodInput {
    type: ReportPeriodType!
    selection: PeriodSelection!
  }

  # ---------------------------------------------------------------------------
  # Filters & Inputs
  # ---------------------------------------------------------------------------
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
    is_uat: Boolean
    search: String

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

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------
  extend type Query {
    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!
  }
`;
