/**
 * GraphQL schema for Commitments (budget commitments) module.
 *
 * Notes:
 * - Reuses common/shared types already present in the composed schema:
 *   - ReportPeriodInput, Normalization, Currency, PeriodType (from existing schemas)
 *   - Axis (from execution-analytics schema)
 * - Does NOT redefine AnomalyType (already defined in execution-analytics).
 */

export const CommitmentsSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Enums
  # ---------------------------------------------------------------------------

  enum CommitmentsReportType {
    DETAILED
    PRINCIPAL_AGGREGATED
    SECONDARY_AGGREGATED
  }

  enum CommitmentsMetric {
    # Available for all periods (MONTH, QUARTER, YEAR)
    CREDITE_ANGAJAMENT
    PLATI_TREZOR
    PLATI_NON_TREZOR
    RECEPTII_TOTALE
    RECEPTII_NEPLATITE_CHANGE

    # Only available for QUARTER and YEAR periods
    LIMITA_CREDIT_ANGAJAMENT
    CREDITE_BUGETARE
    CREDITE_ANGAJAMENT_INITIALE
    CREDITE_BUGETARE_INITIALE
    CREDITE_ANGAJAMENT_DEFINITIVE
    CREDITE_BUGETARE_DEFINITIVE
    CREDITE_ANGAJAMENT_DISPONIBILE
    CREDITE_BUGETARE_DISPONIBILE
    RECEPTII_NEPLATITE
  }

  # ---------------------------------------------------------------------------
  # Inputs
  # ---------------------------------------------------------------------------

  input CommitmentsExcludeInput {
    report_ids: [ID!]
    entity_cuis: [String!]
    main_creditor_cui: String

    functional_codes: [String!]
    functional_prefixes: [String!]
    economic_codes: [String!]
    economic_prefixes: [String!]

    funding_source_ids: [ID!]
    budget_sector_ids: [ID!]

    county_codes: [String!]
    regions: [String!]
    uat_ids: [ID!]
    entity_types: [String!]
  }

  input CommitmentsFilterInput {
    # Required
    report_period: ReportPeriodInput!

    # Report type (optional for most queries; some queries enforce at runtime)
    report_type: CommitmentsReportType

    # Entity scope
    entity_cuis: [String!]
    main_creditor_cui: String
    entity_types: [String!]
    is_uat: Boolean
    search: String

    # Classifications
    functional_codes: [String!]
    functional_prefixes: [String!]
    economic_codes: [String!]
    economic_prefixes: [String!]

    # Budget dimensions
    funding_source_ids: [ID!]
    budget_sector_ids: [ID!]

    # Geography
    county_codes: [String!]
    regions: [String!]
    uat_ids: [ID!]

    # Population
    min_population: Int
    max_population: Int

    # Amount thresholds
    aggregate_min_amount: Float
    aggregate_max_amount: Float
    item_min_amount: Float
    item_max_amount: Float

    # Transforms
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    show_period_growth: Boolean

    # Exclusions
    exclude: CommitmentsExcludeInput
    exclude_transfers: Boolean = true
  }

  input CommitmentsAnalyticsInput {
    filter: CommitmentsFilterInput!
    metric: CommitmentsMetric!
    seriesId: String
  }

  input CommitmentsAggregatedInput {
    filter: CommitmentsFilterInput!
    metric: CommitmentsMetric!
    limit: Int = 50
    offset: Int = 0
  }

  input CommitmentExecutionComparisonInput {
    filter: CommitmentsFilterInput!
    commitments_metric: CommitmentsMetric = PLATI_TREZOR
  }

  # ---------------------------------------------------------------------------
  # Summary Output Types (union varies by period)
  # ---------------------------------------------------------------------------

  type CommitmentsMonthlySummary {
    year: Int!
    month: Int!
    entity_cui: String!
    entity_name: String!
    main_creditor_cui: String
    report_type: CommitmentsReportType!

    credite_angajament: Float!
    plati_trezor: Float!
    plati_non_trezor: Float!
    receptii_totale: Float!
    receptii_neplatite_change: Float!
    total_plati: Float!
  }

  type CommitmentsQuarterlySummary {
    year: Int!
    quarter: Int!
    entity_cui: String!
    entity_name: String!
    main_creditor_cui: String
    report_type: CommitmentsReportType!

    credite_angajament: Float!
    limita_credit_angajament: Float!
    credite_bugetare: Float!
    credite_angajament_initiale: Float!
    credite_bugetare_initiale: Float!
    credite_angajament_definitive: Float!
    credite_bugetare_definitive: Float!
    credite_angajament_disponibile: Float!
    credite_bugetare_disponibile: Float!
    receptii_totale: Float!
    plati_trezor: Float!
    plati_non_trezor: Float!
    receptii_neplatite: Float!

    total_plati: Float!
    execution_rate: Float
    commitment_rate: Float
  }

  type CommitmentsAnnualSummary {
    year: Int!
    entity_cui: String!
    entity_name: String!
    main_creditor_cui: String
    report_type: CommitmentsReportType!

    credite_angajament: Float!
    limita_credit_angajament: Float!
    credite_bugetare: Float!
    credite_angajament_initiale: Float!
    credite_bugetare_initiale: Float!
    credite_angajament_definitive: Float!
    credite_bugetare_definitive: Float!
    credite_angajament_disponibile: Float!
    credite_bugetare_disponibile: Float!
    receptii_totale: Float!
    plati_trezor: Float!
    plati_non_trezor: Float!
    receptii_neplatite: Float!

    total_plati: Float!
    execution_rate: Float
    commitment_rate: Float
  }

  union CommitmentsSummaryResult =
    | CommitmentsMonthlySummary
    | CommitmentsQuarterlySummary
    | CommitmentsAnnualSummary

  type CommitmentsSummaryConnection {
    nodes: [CommitmentsSummaryResult!]!
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Line Items
  # ---------------------------------------------------------------------------

  type CommitmentsLineItem {
    id: ID!
    year: Int!
    month: Int!
    report_type: CommitmentsReportType!

    entity_cui: String!
    entity_name: String!
    main_creditor_cui: String

    budget_sector_id: Int!
    budget_sector_name: String!

    funding_source_id: Int!
    funding_source_name: String!

    functional_code: String!
    functional_name: String!

    economic_code: String
    economic_name: String

    credite_angajament: Float!
    limita_credit_angajament: Float!
    credite_bugetare: Float!
    credite_angajament_initiale: Float!
    credite_bugetare_initiale: Float!
    credite_angajament_definitive: Float!
    credite_bugetare_definitive: Float!
    credite_angajament_disponibile: Float!
    credite_bugetare_disponibile: Float!
    receptii_totale: Float!
    plati_trezor: Float!
    plati_non_trezor: Float!
    receptii_neplatite: Float!

    monthly_plati_trezor: Float!
    monthly_plati_non_trezor: Float!
    monthly_receptii_totale: Float!
    monthly_receptii_neplatite_change: Float!
    monthly_credite_angajament: Float!

    is_quarterly: Boolean!
    quarter: Int
    is_yearly: Boolean!

    anomaly: AnomalyType
  }

  type CommitmentsLineItemConnection {
    nodes: [CommitmentsLineItem!]!
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Analytics
  # ---------------------------------------------------------------------------

  type CommitmentsAnalyticsDataPoint {
    x: String!
    y: Float!
    growth_percent: Float
  }

  type CommitmentsAnalyticsSeries {
    seriesId: String!
    metric: CommitmentsMetric!
    xAxis: Axis!
    yAxis: Axis!
    data: [CommitmentsAnalyticsDataPoint!]!
  }

  # ---------------------------------------------------------------------------
  # Aggregated
  # ---------------------------------------------------------------------------

  type CommitmentsAggregatedItem {
    functional_code: String!
    functional_name: String!
    economic_code: String
    economic_name: String
    amount: Float!
    count: Int!
  }

  type CommitmentsAggregatedConnection {
    nodes: [CommitmentsAggregatedItem!]!
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Commitment vs Execution
  # ---------------------------------------------------------------------------

  type CommitmentExecutionDataPoint {
    period: String!
    commitment_value: Float!
    execution_value: Float!
    difference: Float!
    difference_percent: Float

    commitment_growth_percent: Float
    execution_growth_percent: Float
    difference_growth_percent: Float
  }

  type CommitmentExecutionComparison {
    frequency: PeriodType!
    data: [CommitmentExecutionDataPoint!]!

    total_commitment: Float!
    total_execution: Float!
    total_difference: Float!
    overall_difference_percent: Float

    matched_count: Int!
    unmatched_commitment_count: Int!
    unmatched_execution_count: Int!
  }

  # ---------------------------------------------------------------------------
  # Queries
  # ---------------------------------------------------------------------------

  extend type Query {
    commitmentsSummary(
      filter: CommitmentsFilterInput!
      limit: Int = 50
      offset: Int = 0
    ): CommitmentsSummaryConnection!

    commitmentsLineItems(
      filter: CommitmentsFilterInput!
      limit: Int = 50
      offset: Int = 0
    ): CommitmentsLineItemConnection!

    commitmentsAnalytics(inputs: [CommitmentsAnalyticsInput!]!): [CommitmentsAnalyticsSeries!]!

    commitmentsAggregated(input: CommitmentsAggregatedInput!): CommitmentsAggregatedConnection!

    commitmentVsExecution(
      input: CommitmentExecutionComparisonInput!
    ): CommitmentExecutionComparison!
  }
`;
