/**
 * Entity Module GraphQL Schema
 *
 * Defines types, inputs, and queries for entity data access.
 * UAT and Report types are now in separate modules.
 */

export const EntitySchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Entity Types
  # ---------------------------------------------------------------------------

  """
  A public institution or administrative unit that reports budget execution data.
  """
  type Entity {
    "Unique fiscal identification code (CUI)"
    cui: ID!

    "Entity name"
    name: String!

    "Entity type classification (e.g., uat, public_institution, ministry)"
    entity_type: String

    "Default report type for this entity"
    default_report_type: ReportType!

    "Reference to UAT (Administrative Territorial Unit)"
    uat_id: ID

    "Whether this entity is a UAT"
    is_uat: Boolean

    "Whether this entity is a main creditor (has child entities)"
    is_main_creditor: Boolean

    "Physical address"
    address: String

    "Last update timestamp"
    last_updated: String

    # ---------------------------------------------------------------------------
    # Relations
    # ---------------------------------------------------------------------------

    "Associated UAT (Administrative Territorial Unit)"
    uat: UAT

    "Child entities where this entity is their main creditor"
    children: [Entity!]!

    "Parent entities (main creditors of this entity)"
    parents: [Entity!]!

    "Budget execution reports for this entity"
    reports(
      limit: Int = 10
      offset: Int = 0
      year: Int
      period: String
      type: ReportType
      sort: SortOrder
      main_creditor_cui: String
    ): ReportConnection!

    "Execution line items for this entity"
    executionLineItems(
      filter: AnalyticsFilterInput
      limit: Int = 10000
      offset: Int = 0
      "Sort configuration. Accepts both new format (field/order) and old format (by/order) for backward compatibility."
      sort: SortOrder
      "Normalization mode for amount fields (total, per_capita, etc.)"
      normalization: Normalization
    ): ExecutionLineItemConnection!

    # ---------------------------------------------------------------------------
    # Analytics - Totals
    # ---------------------------------------------------------------------------

    "Total income for the specified period"
    totalIncome(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): Float

    "Total expenses for the specified period"
    totalExpenses(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): Float

    "Budget balance (income - expenses) for the specified period"
    budgetBalance(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): Float

    # ---------------------------------------------------------------------------
    # Analytics - Trends
    # ---------------------------------------------------------------------------

    "Income trend over the specified period"
    incomeTrend(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): AnalyticsSeries!

    "Expenses trend over the specified period"
    expensesTrend(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): AnalyticsSeries!

    "Budget balance trend over the specified period"
    balanceTrend(
      period: ReportPeriodInput!
      reportType: ReportType
      normalization: Normalization
      main_creditor_cui: String
    ): AnalyticsSeries!
  }

  # ---------------------------------------------------------------------------
  # Entity Filter & Connection
  # ---------------------------------------------------------------------------

  "Filter options for entity queries"
  input EntityFilter {
    "Exact CUI match"
    cui: ID

    "Match any of these CUIs"
    cuis: [ID!]

    "Partial name match"
    name: String

    "Entity type filter"
    entity_type: String

    "UAT ID filter"
    uat_id: Int

    "Partial address match"
    address: String

    "Full-text search across name, CUI, and address"
    search: String

    "Filter by is_uat flag"
    is_uat: Boolean

    "Filter by parent entities (matches entities whose main creditors include any of these CUIs)"
    parents: [ID!]
  }

  "Paginated connection of entities"
  type EntityConnection {
    "List of entities in current page"
    nodes: [Entity!]!

    "Pagination metadata"
    pageInfo: PageInfo!
  }

  # ---------------------------------------------------------------------------
  # Root Query Extension
  # ---------------------------------------------------------------------------

  extend type Query {
    "Get a single entity by CUI"
    entity(cui: ID!): Entity

    "List entities with optional filtering and pagination"
    entities(filter: EntityFilter, limit: Int = 20, offset: Int = 0): EntityConnection!
  }
`;
