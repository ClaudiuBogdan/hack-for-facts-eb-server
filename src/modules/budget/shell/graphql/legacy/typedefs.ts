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
 *  - everything else + `extend type Query`   ← src/modules/execution-analytics/shell/graphql/schema.ts
 *
 * Not carried: `Date`/`DateTime`/`JSON` (kernel base scalars), `SortOrder`,
 * `PageInfo` (other slices), and the legacy inter-definition `#` comments.
 * The `@deprecated` markers on `entity_types` are kept (the only additions the
 * manifest allows).
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

  extend type Query {
    executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!
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
    'extend type Query',
  ],
} as const;
