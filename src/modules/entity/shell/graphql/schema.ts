/**
 * Entity Module GraphQL Schema
 *
 * Defines types, inputs, and queries for entity data access.
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
  # Report Types
  # ---------------------------------------------------------------------------

  """
  Budget execution report.
  Represents metadata for an imported budget execution report file.
  """
  type Report {
    "Report ID"
    report_id: ID!

    "Entity CUI"
    entity_cui: String!

    "Report type"
    report_type: ReportType!

    "Main creditor CUI"
    main_creditor_cui: String

    "Report date"
    report_date: Date!

    "Reporting year"
    reporting_year: Int!

    "Reporting period"
    reporting_period: String!

    "Budget sector ID"
    budget_sector_id: Int!

    "File source path"
    file_source: String

    "Download links for report files"
    download_links: [String!]!

    "Import timestamp"
    import_timestamp: String!

    # ---------------------------------------------------------------------------
    # Relations
    # ---------------------------------------------------------------------------

    "The entity that owns this report"
    entity: Entity!

    "Main creditor entity (if applicable)"
    main_creditor: Entity

    "Budget sector for this report"
    budgetSector: BudgetSector!

    "Execution line items for this report"
    executionLineItems(
      limit: Int = 100
      offset: Int = 0
      functionalCode: String
      economicCode: String
      accountCategory: AccountCategory
      minAmount: Float
      maxAmount: Float
    ): ExecutionLineItemConnection!
  }

  "Filter options for report queries"
  input ReportFilterInput {
    "Filter by entity CUI"
    entity_cui: String

    "Filter by reporting year"
    reporting_year: Int

    "Filter by reporting period"
    reporting_period: String

    "Filter by report date start (inclusive, ISO date string)"
    report_date_start: String

    "Filter by report date end (inclusive, ISO date string)"
    report_date_end: String

    "Filter by report type"
    report_type: ReportType

    "Filter by main creditor CUI"
    main_creditor_cui: String

    "Search across entity name and download links"
    search: String
  }

  "Filter options for report queries (alias for ReportFilterInput for backward compatibility)"
  input ReportFilter {
    "Filter by entity CUI"
    entity_cui: String

    "Filter by reporting year"
    reporting_year: Int

    "Filter by reporting period"
    reporting_period: String

    "Filter by report date start (inclusive, ISO date string)"
    report_date_start: String

    "Filter by report date end (inclusive, ISO date string)"
    report_date_end: String

    "Filter by report type"
    report_type: ReportType

    "Filter by main creditor CUI"
    main_creditor_cui: String

    "Search across entity name and download links"
    search: String
  }

  "Paginated connection of reports"
  type ReportConnection {
    "List of reports in current page"
    nodes: [Report!]!

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

    "Get a single report by ID"
    report(report_id: ID!): Report

    "List reports with optional filtering and pagination"
    reports(filter: ReportFilter, limit: Int = 20, offset: Int = 0): ReportConnection!

    "Get a single UAT by ID"
    uat(id: ID!): UAT

    "List UATs with optional filtering and pagination"
    uats(filter: UATFilterInput, limit: Int = 20, offset: Int = 0): UATConnection!
  }
`;
