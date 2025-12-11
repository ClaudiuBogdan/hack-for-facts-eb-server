/**
 * UAT Module GraphQL Schema
 *
 * Defines types, inputs, and queries for UAT data access.
 */

export const UATSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # UAT Types
  # ---------------------------------------------------------------------------

  """
  Administrative Territorial Unit (UAT).
  Represents a city, commune, or county in Romania.
  """
  type UAT {
    "UAT ID"
    id: ID!

    "UAT key"
    uat_key: String!

    "UAT code"
    uat_code: String!

    "SIRUTA code"
    siruta_code: String!

    "UAT name"
    name: String!

    "County code"
    county_code: String!

    "County name"
    county_name: String!

    "Region name"
    region: String!

    "Population count"
    population: Int

    # ---------------------------------------------------------------------------
    # Relations
    # ---------------------------------------------------------------------------

    "The county-level entity for this UAT (null if this UAT is itself a county)"
    county_entity: Entity
  }

  # ---------------------------------------------------------------------------
  # UAT Filter & Connection
  # ---------------------------------------------------------------------------

  "Filter options for UAT queries"
  input UATFilterInput {
    "Exact ID match"
    id: ID

    "Match any of these IDs"
    ids: [ID!]

    "Exact UAT key match"
    uat_key: String

    "Exact UAT code match"
    uat_code: String

    "Partial name match (ILIKE when no search, similarity with search)"
    name: String

    "Exact county code match"
    county_code: String

    "Partial county name match (ILIKE when no search, similarity with search)"
    county_name: String

    "Exact region match"
    region: String

    "Full-text search across name and county_name using pg_trgm similarity"
    search: String

    "Filter to county-level UATs only (true) or exclude counties (false)"
    is_county: Boolean
  }

  "Paginated connection of UATs"
  type UATConnection {
    "List of UATs in current page"
    nodes: [UAT!]!

    "Pagination metadata"
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    "Get a single UAT by ID"
    uat(id: ID!): UAT

    "List UATs with optional filtering and pagination"
    uats(filter: UATFilterInput, limit: Int = 20, offset: Int = 0): UATConnection!
  }
`;
