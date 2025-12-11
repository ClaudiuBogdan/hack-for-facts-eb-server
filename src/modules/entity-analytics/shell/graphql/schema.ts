/**
 * GraphQL schema for the entityAnalytics endpoint.
 *
 * This schema reuses types from execution-analytics for consistency:
 * - AnalyticsFilterInput (same filter interface)
 * - Normalization enum (including legacy total_euro, per_capita_euro)
 * - PeriodType, ReportPeriodInput, SortDirection, SortOrder, etc.
 *
 * New types defined here:
 * - EntityAnalyticsDataPoint (output type)
 * - EntityAnalyticsConnection (paginated result)
 * - EntityAnalyticsPageInfo (pagination metadata)
 *
 * Sort uses the common SortOrder type with valid `by` values:
 * - AMOUNT, TOTAL_AMOUNT, PER_CAPITA_AMOUNT
 * - ENTITY_NAME, ENTITY_TYPE, POPULATION
 * - COUNTY_NAME, COUNTY_CODE
 */
export const EntityAnalyticsSchema = /* GraphQL */ `
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
    entity_type: String

    "Associated UAT ID (if applicable)"
    uat_id: ID

    "County code (e.g., 'AB', 'B')"
    county_code: String

    "County name (e.g., 'Alba', 'Bucuresti')"
    county_name: String

    """
    Population for this entity.
    - UAT entities: UAT's own population
    - County councils: County aggregate population
    - Other entities: null
    """
    population: Int

    """
    Display amount (normalized).
    Currently same as total_amount; may differ with future display modes.
    """
    amount: Float!

    "Total aggregated amount after normalization"
    total_amount: Float!

    """
    Per-capita amount (total_amount / population).
    Returns 0 if population is null or zero.
    """
    per_capita_amount: Float!
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
    - **UAT entities** (is_uat = true): Uses UAT's own population
    - **County councils** (entity_type = 'admin_county_council'): Uses county aggregate
    - **Other entities**: No population (per_capita = 0)

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
`;
