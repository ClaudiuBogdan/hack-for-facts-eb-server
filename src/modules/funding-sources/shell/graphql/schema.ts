/**
 * GraphQL schema for Funding Source module.
 */

export const FundingSourceSchema = /* GraphQL */ `
  """
  A funding source representing a source of budget funding
  (e.g., State Budget, EU Funds, Own Revenues).
  """
  type FundingSource {
    """
    Unique identifier for the funding source
    """
    source_id: ID!
    """
    Human-readable description of the funding source
    """
    source_description: String!
    """
    Execution line items associated with this funding source.
    Supports pagination and optional filtering by report ID and account category.
    """
    executionLineItems(
      """
      Maximum items to return (default: 100, max: 1000)
      """
      limit: Int = 100
      """
      Number of items to skip (default: 0)
      """
      offset: Int = 0
      """
      Optional filter by report ID
      """
      reportId: String
      """
      Optional filter by account category (vn = income, ch = expense)
      """
      accountCategory: AccountCategory
    ): ExecutionLineItemConnection!
  }

  """
  Pagination metadata for funding source listing.
  """
  type FundingSourcePageInfo {
    """
    Total count of matching funding sources
    """
    totalCount: Int!
    """
    Whether there are more items after current page
    """
    hasNextPage: Boolean!
    """
    Whether there are items before current page
    """
    hasPreviousPage: Boolean!
  }

  """
  Paginated connection of funding sources.
  """
  type FundingSourceConnection {
    """
    List of funding sources in current page
    """
    nodes: [FundingSource!]!
    """
    Pagination metadata
    """
    pageInfo: FundingSourcePageInfo!
  }

  """
  A single execution line item representing budget execution data.
  """
  type ExecutionLineItem {
    """
    Unique identifier for the line item
    """
    line_item_id: ID!
    """
    Report ID this line item belongs to
    """
    report_id: String!
    """
    Year of the budget execution
    """
    year: Int!
    """
    Month of the budget execution (1-12)
    """
    month: Int!
    """
    Entity CUI (fiscal identification code)
    """
    entity_cui: String!
    """
    Account category: vn (income) or ch (expense)
    """
    account_category: AccountCategory!
    """
    Functional classification code (COFOG)
    """
    functional_code: String!
    """
    Economic classification code (may be null for income)
    """
    economic_code: String
    """
    Year-to-date amount
    """
    ytd_amount: Float!
    """
    Monthly amount
    """
    monthly_amount: Float!
    """
    Quarterly amount. Only populated for is_quarterly=true rows.
    """
    quarterly_amount: Float
    """
    Anomaly type if this line item has data quality issues (YTD_ANOMALY, MISSING_LINE_ITEM)
    """
    anomaly: AnomalyType
  }

  """
  Paginated connection of execution line items.
  """
  type ExecutionLineItemConnection {
    """
    List of execution line items in current page
    """
    nodes: [ExecutionLineItem!]!
    """
    Pagination metadata
    """
    pageInfo: FundingSourcePageInfo!
  }

  """
  Filter options for funding source listing.
  """
  input FundingSourceFilterInput {
    """
    Search term for fuzzy matching against source_description.
    Uses ILIKE and pg_trgm similarity > 0.1.
    """
    search: String
    """
    Filter to specific source IDs
    """
    source_ids: [ID!]
  }

  extend type Query {
    """
    Get a single funding source by ID.
    Returns null if not found.
    """
    fundingSource(id: ID!): FundingSource

    """
    List funding sources with optional filtering and pagination.
    """
    fundingSources(
      """
      Filter options
      """
      filter: FundingSourceFilterInput
      """
      Maximum sources to return (default: 10, max: 200)
      """
      limit: Int = 10
      """
      Number of sources to skip (default: 0)
      """
      offset: Int = 0
    ): FundingSourceConnection!
  }
`;
