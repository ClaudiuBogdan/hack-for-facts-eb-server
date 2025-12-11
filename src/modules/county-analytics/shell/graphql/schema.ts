/**
 * County Analytics GraphQL Schema
 *
 * Defines types and queries for county-level heatmap visualization.
 * Reuses AnalyticsFilterInput and normalization enums from UAT Analytics module.
 */

export const CountyAnalyticsSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  """
  Aggregated budget data for a single county.
  Used for county-level heatmap visualization of budget execution.
  Aggregates data from all UATs within the county.
  """
  type HeatmapCountyDataPoint {
    """
    County code (e.g., 'CJ', 'TM', 'B')
    """
    county_code: String!

    """
    County display name
    """
    county_name: String!

    """
    Total county population (sum of all UAT populations in county)
    """
    county_population: Int!

    """
    Primary display amount (normalized based on selected mode)
    """
    amount: Float!

    """
    Total aggregated amount (RON or EUR based on currency parameter)
    """
    total_amount: Float!

    """
    Per-capita amount (always calculated for display)
    """
    per_capita_amount: Float!

    """
    The Entity representing the county (typically the county council).
    Resolved via field resolver using the county entity CUI.
    """
    county_entity: Entity
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Returns aggregated budget execution data per county for heatmap visualization.

    Similar to heatmapUATData but aggregates at county level (42 Romanian counties).
    All UATs within a county are rolled up into a single data point.

    Transformation order:
    1. Inflation adjustment (if inflation_adjusted=true)
    2. Currency conversion (if currency=EUR)
    3. Aggregate by county
    4. Per-capita division (if normalization=per_capita)

    Required filter fields:
    - account_category: 'vn' (income) or 'ch' (expense)
    - report_period: Time period selection
    - report_type: PRINCIPAL_AGGREGATED, SECONDARY_AGGREGATED, or DETAILED

    Example query:
    \`\`\`graphql
    query {
      heatmapCountyData(
        filter: {
          account_category: ch
          report_type: PRINCIPAL_AGGREGATED
          report_period: {
            type: YEAR
            selection: { dates: ["2024"] }
          }
        }
        normalization: per_capita
        currency: EUR
        inflation_adjusted: true
      ) {
        county_code
        county_name
        amount
        county_population
        county_entity {
          cui
          name
        }
      }
    }
    \`\`\`
    """
    heatmapCountyData(
      """
      Filter criteria for selecting budget data
      """
      filter: AnalyticsFilterInput!

      """
      Normalization mode for output amounts (default: total)
      """
      normalization: HeatmapNormalization

      """
      Target currency for amounts (default: RON)
      """
      currency: HeatmapCurrency

      """
      Whether to adjust for inflation using CPI factors (default: false)
      """
      inflation_adjusted: Boolean
    ): [HeatmapCountyDataPoint!]!
  }
`;
