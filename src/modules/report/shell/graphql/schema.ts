/**
 * Report Module GraphQL Schema
 *
 * Defines types, inputs, and queries for report data access.
 */

export const ReportSchema = /* GraphQL */ `
  # ---------------------------------------------------------------------------
  # Report Types
  # ---------------------------------------------------------------------------

  """
  Budget report metadata (execution or commitments).
  Represents metadata for an imported report file.
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

    "Execution line items for this report (execution report types only)"
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

  # ---------------------------------------------------------------------------
  # Report Filter & Connection
  # ---------------------------------------------------------------------------

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
    "Get a single report by ID"
    report(report_id: ID!): Report

    "List reports with optional filtering and pagination"
    reports(filter: ReportFilter, limit: Int = 20, offset: Int = 0): ReportConnection!
  }
`;
