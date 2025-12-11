/**
 * Classification Module GraphQL Schema
 *
 * Defines types and queries for functional and economic classifications.
 */

export const ClassificationSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Functional Classification
  # ---------------------------------------------------------------------------

  """
  Functional classification (budget function category).
  Represents how budget items are categorized by their functional purpose.
  """
  type FunctionalClassification {
    """
    The unique code for this functional classification (e.g., "01.01").
    """
    functional_code: ID!

    """
    Human-readable name of the functional classification.
    """
    functional_name: String!
  }

  """
  Paginated list of functional classifications.
  """
  type FunctionalClassificationConnection {
    """
    List of functional classifications in this page.
    """
    nodes: [FunctionalClassification!]!

    """
    Pagination info.
    """
    pageInfo: PageInfo!
  }

  """
  Filter input for functional classifications.
  """
  input FunctionalClassificationFilterInput {
    """
    Search by code or name (case-insensitive, partial match).
    """
    search: String

    """
    Filter to specific functional codes.
    """
    functional_codes: [String!]
  }

  # ---------------------------------------------------------------------------
  # Economic Classification
  # ---------------------------------------------------------------------------

  """
  Economic classification (budget economic category).
  Represents how budget items are categorized by their economic nature.
  """
  type EconomicClassification {
    """
    The unique code for this economic classification (e.g., "10.01.01").
    """
    economic_code: ID!

    """
    Human-readable name of the economic classification.
    """
    economic_name: String!
  }

  """
  Paginated list of economic classifications.
  """
  type EconomicClassificationConnection {
    """
    List of economic classifications in this page.
    """
    nodes: [EconomicClassification!]!

    """
    Pagination info.
    """
    pageInfo: PageInfo!
  }

  """
  Filter input for economic classifications.
  """
  input EconomicClassificationFilterInput {
    """
    Search by code or name (case-insensitive, partial match).
    """
    search: String

    """
    Filter to specific economic codes.
    """
    economic_codes: [String!]
  }

  # ---------------------------------------------------------------------------
  # Query Extensions
  # ---------------------------------------------------------------------------

  extend type Query {
    """
    Get a single functional classification by code.
    Returns null if not found.
    """
    functionalClassification(
      """
      The functional code to look up.
      """
      code: ID!
    ): FunctionalClassification

    """
    List functional classifications with optional filtering and pagination.
    """
    functionalClassifications(
      """
      Optional filter criteria.
      """
      filter: FunctionalClassificationFilterInput

      """
      Maximum items to return (default: 100, max: 1000).
      """
      limit: Int = 100

      """
      Number of items to skip (default: 0).
      """
      offset: Int = 0
    ): FunctionalClassificationConnection!

    """
    Get a single economic classification by code.
    Returns null if not found.
    """
    economicClassification(
      """
      The economic code to look up.
      """
      code: ID!
    ): EconomicClassification

    """
    List economic classifications with optional filtering and pagination.
    """
    economicClassifications(
      """
      Optional filter criteria.
      """
      filter: EconomicClassificationFilterInput

      """
      Maximum items to return (default: 100, max: 1000).
      """
      limit: Int = 100

      """
      Number of items to skip (default: 0).
      """
      offset: Int = 0
    ): EconomicClassificationConnection!
  }
`;
