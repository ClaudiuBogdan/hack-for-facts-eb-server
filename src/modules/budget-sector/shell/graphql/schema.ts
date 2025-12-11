/**
 * GraphQL schema for Budget Sector module.
 */

export const BudgetSectorSchema = /* GraphQL */ `
  """
  A budget sector categorizing budget sources (e.g., local budget, state budget).
  """
  type BudgetSector {
    """
    Unique identifier for the budget sector
    """
    sector_id: ID!
    """
    Human-readable description of the sector
    """
    sector_description: String!
    # TODO: Add executionLineItems nested field for drilling down into line items
    # executionLineItems(limit: Int = 100, offset: Int = 0, reportId: Int, accountCategory: AccountCategory): ExecutionLineItemConnection!
  }

  """
  Pagination metadata for budget sector listing.
  """
  type BudgetSectorPageInfo {
    """
    Total count of matching budget sectors
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
  Paginated connection of budget sectors.
  """
  type BudgetSectorConnection {
    """
    List of budget sectors in current page
    """
    nodes: [BudgetSector!]!
    """
    Pagination metadata
    """
    pageInfo: BudgetSectorPageInfo!
  }

  """
  Filter options for budget sector listing.
  """
  input BudgetSectorFilterInput {
    """
    Search term for fuzzy matching against sector_description.
    Uses ILIKE and pg_trgm similarity > 0.1.
    """
    search: String
    """
    Filter to specific sector IDs
    """
    sector_ids: [ID!]
  }

  extend type Query {
    """
    Get a single budget sector by ID.
    Returns null if not found.
    """
    budgetSector(id: ID!): BudgetSector

    """
    List budget sectors with optional filtering and pagination.
    """
    budgetSectors(
      """
      Filter options
      """
      filter: BudgetSectorFilterInput
      """
      Maximum sectors to return (default: 20, max: 200)
      """
      limit: Int = 20
      """
      Number of sectors to skip (default: 0)
      """
      offset: Int = 0
    ): BudgetSectorConnection!
  }
`;
