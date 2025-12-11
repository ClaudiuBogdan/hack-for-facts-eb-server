/**
 * GraphQL schema for the aggregatedLineItems endpoint.
 *
 * This schema reuses types from execution-analytics for consistency:
 * - AnalyticsFilterInput (same filter interface)
 * - Normalization enum (including legacy total_euro, per_capita_euro)
 * - PeriodType, ReportPeriodInput, etc.
 *
 * New types defined here:
 * - AggregatedLineItem (output type)
 * - AggregatedLineItemConnection (paginated result)
 * - AggregatedLineItemPageInfo (pagination metadata)
 */
export const AggregatedLineItemsSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Output Types
  # ---------------------------------------------------------------------------

  """
  A single aggregated line item representing budget execution data
  grouped by functional and economic classification.
  """
  type AggregatedLineItem {
    """
    Functional classification code (e.g., "01.01.01")
    """
    functional_code: String!

    """
    Functional classification name (e.g., "Legislative bodies")
    """
    functional_name: String!

    """
    Economic classification code (e.g., "20.05.01").
    Returns "00.00.00" for unknown/NULL classifications.
    """
    economic_code: String!

    """
    Economic classification name (e.g., "Administrative services").
    Returns "Unknown economic classification" for unknown/NULL classifications.
    """
    economic_name: String!

    """
    Aggregated amount after normalization.
    Unit depends on normalization settings (RON, EUR, per capita, % GDP, etc.)
    """
    amount: Float!

    """
    Number of individual line items aggregated into this classification group.
    """
    count: Int!
  }

  """
  Pagination information for aggregatedLineItems results.
  """
  type AggregatedLineItemPageInfo {
    """
    Total number of classification groups matching the filter (before pagination).
    """
    totalCount: Int!

    """
    Whether there are more items after the current page.
    """
    hasNextPage: Boolean!

    """
    Whether there are items before the current page.
    """
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection for aggregated line items.
  """
  type AggregatedLineItemConnection {
    """
    The list of aggregated line items for the current page.
    """
    nodes: [AggregatedLineItem!]!

    """
    Pagination metadata.
    """
    pageInfo: AggregatedLineItemPageInfo!
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Returns aggregated budget execution data grouped by functional and economic classification.

    ## Use Cases
    - Macroeconomic analysis of government spending
    - Cross-entity budget comparisons
    - Classification-level budget breakdowns

    ## Normalization
    Normalization is applied per-period BEFORE aggregation to ensure correct
    handling of multi-year data with varying inflation rates and exchange rates.

    Supported normalization modes:
    - **total**: Raw amounts in RON
    - **total_euro**: Amounts converted to EUR (legacy, equivalent to total + currency: EUR)
    - **per_capita**: Amount divided by population
    - **per_capita_euro**: Per capita in EUR (legacy)
    - **percent_gdp**: Amount as percentage of GDP

    ## Pagination
    Results are sorted by amount (descending) and paginated.
    - Default limit: 50
    - Maximum limit: 1000
    """
    aggregatedLineItems(
      """
      Filter criteria for selecting line items.
      Uses the same filter interface as executionAnalytics.
      """
      filter: AnalyticsFilterInput!

      """
      Maximum number of items to return.
      Default: 50, Maximum: 1000
      """
      limit: Int = 50

      """
      Number of items to skip (for pagination).
      Default: 0
      """
      offset: Int = 0
    ): AggregatedLineItemConnection!
  }
`;
