/** Carried grouped roots, with explicit approved semantic deltas.
 * Provenance: entity-analytics/shell/graphql/schema.ts,
 * aggregated-line-items/shell/graphql/schema.ts, infra/graphql/common/types.ts.
 * See NATIVE_GROUPED_ANALYTICS_2026-09-05.md; no imports from retired modules.
 */
export const budgetGroupedTypeDefs = /* GraphQL */ `
  "Input for specifying sort order on a field"
  input SortOrder {
    "Field name to sort by"
    by: String!
    "Sort direction (ASC or DESC)"
    order: String!
  }

  # ---------------------------------------------------------------------------
  # Output Types
  # ---------------------------------------------------------------------------

  """
  A single entity analytics data point representing budget execution
  aggregated at the entity level.
  """
  type EntityAnalyticsDataPoint {
    "Unique entity identifier (CUI - Cod Unic de Identificare)"
    entity_cui: ID!

    "Entity display name"
    entity_name: String!

    "Entity type (e.g., uat, admin_county_council, public_institution)"
    entity_type: String @deprecated(reason: "Legacy coarse taxonomy. Read tags instead.")

    "Associated UAT ID (if applicable)"
    uat_id: ID

    "County code (e.g., 'AB', 'B')"
    county_code: String

    "County name (e.g., 'Alba', 'Bucuresti')"
    county_name: String

    """
    Population for this entity.
    Canonical administrative-anchor population for territorial executives.
    Other entities have no eligible population. Annual multiyear results may
    have a per-capita value without one scalar population.
    """
    population: Int

    """
    Display amount (normalized).
    Uses per-capita value in per-capita mode, otherwise total_amount.
    """
    amount: Float!

    "Total aggregated amount after normalization"
    total_amount: Float!

    """
    Sum of each year's normalized amount divided by that year's population.
    Unavailable population produces null; no value is fabricated.
    """
    per_capita_amount: Float
  }

  """
  Pagination information for entity analytics results.
  """
  type EntityAnalyticsPageInfo {
    "Total number of entities matching the filter (before pagination)"
    totalCount: Int!

    "Whether there are more items after the current page"
    hasNextPage: Boolean!

    "Whether there are items before the current page"
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection for entity analytics.
  """
  type EntityAnalyticsConnection {
    "List of entity analytics data points for the current page"
    nodes: [EntityAnalyticsDataPoint!]!

    "Pagination metadata"
    pageInfo: EntityAnalyticsPageInfo!
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Returns entity-level budget analytics.

    ## Purpose
    Aggregates ExecutionLineItems by entity_cui (institution) to answer queries like:
    - "Which entities spent the most on education?"
    - "Compare per-capita spending across municipalities"
    - "Rank entities by total budget"

    ## Population Handling
    Population varies by entity type:
    - Territorial executives use their canonical administrative anchors.
    - Other entities have no eligible population.
    - Missing eligibility or required population makes the request unavailable.

    ## Sorting
    Results can be sorted by any of the 8 available fields.
    Default: TOTAL_AMOUNT DESC

    ## Normalization
    Supports the same normalization modes as aggregatedLineItems:
    - **total**: Raw amounts in RON
    - **total_euro**: Amounts converted to EUR (legacy)
    - **per_capita**: Amount divided by population (filter-based for aggregatedLineItems, per-entity here)
    - **per_capita_euro**: Per capita in EUR (legacy)
    - **percent_gdp**: Amount as percentage of GDP

    ## Key Difference from aggregatedLineItems
    - **entityAnalytics**: Groups by entity_cui (institution-level)
    - **aggregatedLineItems**: Groups by functional_code + economic_code (classification-level)
    """
    entityAnalytics(
      "Filter criteria (same interface as aggregatedLineItems)"
      filter: AnalyticsFilterInput!

      """
      Sort configuration (default: TOTAL_AMOUNT DESC).
      Uses common SortOrder type with 'by' (field name) and 'order' (ASC/DESC).
      Valid 'by' values: AMOUNT, TOTAL_AMOUNT, PER_CAPITA_AMOUNT, ENTITY_NAME,
      ENTITY_TYPE, POPULATION, COUNTY_NAME, COUNTY_CODE
      """
      sort: SortOrder

      "Maximum items to return (default: 50, max: 100000)"
      limit: Int = 50

      "Items to skip for pagination (default: 0)"
      offset: Int = 0
    ): EntityAnalyticsConnection!
  }

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
    - Maximum limit: 100000
    """
    aggregatedLineItems(
      """
      Filter criteria for selecting line items.
      Uses the same filter interface as executionAnalytics.
      """
      filter: AnalyticsFilterInput!

      """
      Maximum number of items to return.
      Default: 50, Maximum: 100000
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
