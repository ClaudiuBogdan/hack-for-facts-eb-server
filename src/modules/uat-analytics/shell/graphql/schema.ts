/**
 * UAT Analytics GraphQL Schema
 *
 * Defines types and queries for UAT heatmap visualization.
 * Reuses AnalyticsFilterInput from execution-analytics module.
 */

export const UATAnalyticsSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  """
  Aggregated budget data for a single UAT (Unitate Administrativ-Teritorială).
  Used for heatmap visualization of budget execution across geographic regions.
  """
  type HeatmapUATDataPoint {
    """
    UAT database ID
    """
    uat_id: ID!

    """
    UAT code (matches entity CUI for budget entities)
    """
    uat_code: String!

    """
    UAT display name
    """
    uat_name: String!

    """
    SIRUTA code - unique UAT identifier in Romanian administrative system
    """
    siruta_code: String!

    """
    County code (e.g., 'CJ', 'TM')
    """
    county_code: String

    """
    County name
    """
    county_name: String

    """
    Region name (e.g., 'Nord-Vest')
    """
    region: String

    """
    UAT population (used for per-capita calculations)
    """
    population: Int

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
  }

  # ---------------------------------------------------------------------------
  # Enums
  # ---------------------------------------------------------------------------

  """
  Normalization mode for heatmap data.
  Controls whether amounts are displayed as totals or per-capita.

  Note: total_euro and per_capita_euro are legacy modes for backwards compatibility.
  Prefer using the separate 'currency' parameter instead.
  """
  enum HeatmapNormalization {
    """
    Raw total amount
    """
    total

    """
    Per-capita amount (total divided by UAT population)
    """
    per_capita

    """
    Raw total amount converted to EUR (legacy, use currency: EUR instead)
    """
    total_euro

    """
    Per-capita amount converted to EUR (legacy, use currency: EUR and normalization: per_capita instead)
    """
    per_capita_euro
  }

  """
  Currency for heatmap output amounts.
  """
  enum HeatmapCurrency {
    """
    Romanian Leu (original currency)
    """
    RON

    """
    Euro (converted using year-specific exchange rates)
    """
    EUR
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Returns aggregated budget execution data per UAT for heatmap visualization.

    The query aggregates ExecutionLineItems by UAT, supporting:
    - Multiple normalization modes (total, per-capita)
    - Currency conversion (RON or EUR with year-specific rates)
    - Inflation adjustment (using CPI factors)
    - Comprehensive filtering (period, dimensions, geography, exclusions)
    - Multi-year queries with proper year-by-year normalization

    Transformation order:
    1. Inflation adjustment (if inflation_adjusted=true)
    2. Currency conversion (if currency=EUR)
    3. Aggregate by UAT
    4. Per-capita division (if normalization=per_capita)

    Required filter fields:
    - account_category: 'vn' (income) or 'ch' (expense)
    - report_period: Time period selection
    - report_type: PRINCIPAL_AGGREGATED, SECONDARY_AGGREGATED, or DETAILED

    Example query:
    \`\`\`graphql
    query {
      heatmapUATData(
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
        uat_id
        uat_name
        amount
        population
      }
    }
    \`\`\`
    """
    heatmapUATData(
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
    ): [HeatmapUATDataPoint!]!
  }
`;
