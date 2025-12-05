/**
 * GraphQL schema for Execution Line Items module.
 *
 * Extends the ExecutionLineItem type from funding-sources module
 * with additional fields and nested resolvers.
 */

export const ExecutionLineItemSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Sorting
  # ---------------------------------------------------------------------------

  """
  Sortable fields for execution line items.
  Default sort is by year descending, then ytd_amount descending.
  """
  enum ExecutionLineItemSortField {
    line_item_id
    report_id
    entity_cui
    funding_source_id
    functional_code
    economic_code
    account_category
    ytd_amount
    program_code
    year
  }

  """
  Sort input for execution line item queries.
  """
  input ExecutionLineItemSortInput {
    """
    Field to sort by
    """
    field: ExecutionLineItemSortField!
    """
    Sort direction (default: DESC)
    """
    order: SortDirection = DESC
  }

  # ---------------------------------------------------------------------------
  # Nested Resolver Types
  # ---------------------------------------------------------------------------

  """
  Report associated with an execution line item.
  """
  type ExecutionReport {
    report_id: ID!
    entity_cui: String!
    report_type: String!
    main_creditor_cui: String
    report_date: Date!
    reporting_year: Int!
    reporting_period: String!
    budget_sector_id: Int!
    file_source: String
  }

  """
  Entity (institution) associated with an execution line item.
  """
  type ExecutionEntity {
    cui: String!
    name: String!
    uat_id: Int
    address: String
    entity_type: String
    is_uat: Boolean!
  }

  """
  Funding source for an execution line item.
  """
  type ExecutionFundingSource {
    source_id: ID!
    source_description: String!
  }

  """
  Budget sector for an execution line item.
  """
  type ExecutionBudgetSector {
    sector_id: ID!
    sector_description: String!
  }

  """
  Functional classification for an execution line item.
  """
  type ExecutionFunctionalClassification {
    functional_code: String!
    functional_name: String!
  }

  """
  Economic classification for an execution line item.
  """
  type ExecutionEconomicClassification {
    economic_code: String!
    economic_name: String!
  }

  # ---------------------------------------------------------------------------
  # Extend ExecutionLineItem with additional fields
  # Note: Base type defined in funding-sources module
  # ---------------------------------------------------------------------------

  extend type ExecutionLineItem {
    """
    ID of the funding source (local budget, state budget, etc.)
    """
    funding_source_id: Int!

    """
    ID of the budget sector
    """
    budget_sector_id: Int!

    """
    Expense type: dezvoltare (development) or functionare (operating)
    """
    expense_type: ExpenseType

    """
    Program code for program-based budgeting
    """
    program_code: String

    """
    Quarter (1-4) for quarterly aggregations (nullable)
    """
    quarter: Int

    # ---------------------------------------------------------------------------
    # Nested Resolvers (Mercurius loaders for N+1 prevention)
    # ---------------------------------------------------------------------------

    """
    The report containing this line item.
    """
    report: ExecutionReport

    """
    The entity (institution) that submitted this line item.
    """
    entity: ExecutionEntity

    """
    The funding source for this line item.
    """
    fundingSource: ExecutionFundingSource

    """
    The budget sector for this line item.
    """
    budgetSector: ExecutionBudgetSector

    """
    The functional classification of this line item.
    """
    functionalClassification: ExecutionFunctionalClassification

    """
    The economic classification of this line item.
    """
    economicClassification: ExecutionEconomicClassification
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Get a single execution line item by ID.
    Returns null if not found.
    """
    executionLineItem(
      """
      The line item ID to look up
      """
      id: ID!
    ): ExecutionLineItem

    """
    List execution line items with filtering, sorting, and pagination.

    Required filter fields:
    - report_period: Period selection (type: YEAR/QUARTER/MONTH, selection: interval or dates)
    - account_category: vn (income) or ch (expense)

    Note: Uses AnalyticsFilterInput from execution-analytics module.
    """
    executionLineItems(
      """
      Filter criteria. report_period and account_category are required.
      """
      filter: AnalyticsFilterInput!
      """
      Sort configuration (default: year DESC, ytd_amount DESC)
      """
      sort: ExecutionLineItemSortInput
      """
      Maximum items to return (default: 100, max: 1000)
      """
      limit: Int = 100
      """
      Number of items to skip (default: 0)
      """
      offset: Int = 0
    ): ExecutionLineItemConnection!
  }
`;
