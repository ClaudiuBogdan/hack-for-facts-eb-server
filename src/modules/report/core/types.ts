/**
 * Domain types for Report module.
 *
 * Reports represent budget execution report metadata for imported files.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for report listing */
export const DEFAULT_REPORT_LIMIT = 20;

/** Maximum allowed page size for reports */
export const MAX_REPORT_LIMIT = 500;

/** Default page size for execution line items on Report */
export const DEFAULT_REPORT_ELI_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Report Type Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database report type enum values.
 */
export type DbReportType =
  | 'Executie bugetara agregata la nivel de ordonator principal'
  | 'Executie bugetara agregata la nivel de ordonator secundar'
  | 'Executie bugetara detaliata';

/**
 * GraphQL report type enum values.
 */
export type GqlReportType = 'PRINCIPAL_AGGREGATED' | 'SECONDARY_AGGREGATED' | 'DETAILED';

/**
 * Maps GraphQL ReportType to database value.
 */
export const GQL_TO_DB_REPORT_TYPE: Record<GqlReportType, DbReportType> = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
};

/**
 * Maps database ReportType to GraphQL value.
 */
export const DB_TO_GQL_REPORT_TYPE: Record<DbReportType, GqlReportType> = {
  'Executie bugetara agregata la nivel de ordonator principal': 'PRINCIPAL_AGGREGATED',
  'Executie bugetara agregata la nivel de ordonator secundar': 'SECONDARY_AGGREGATED',
  'Executie bugetara detaliata': 'DETAILED',
};

// ─────────────────────────────────────────────────────────────────────────────
// Report Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget execution report.
 * Represents metadata for an imported budget execution report file.
 */
export interface Report {
  /** Report ID */
  report_id: string;
  /** Entity CUI */
  entity_cui: string;
  /** Report type (DB enum value) */
  report_type: DbReportType;
  /** Main creditor CUI */
  main_creditor_cui: string | null;
  /** Report date */
  report_date: Date;
  /** Reporting year */
  reporting_year: number;
  /** Reporting period */
  reporting_period: string;
  /** Budget sector ID */
  budget_sector_id: number;
  /** File source path */
  file_source: string | null;
  /** Download links for report files */
  download_links: string[];
  /** Import timestamp */
  import_timestamp: Date;
}

/**
 * Filter options for report queries.
 * All fields are optional for flexibility in top-level queries.
 */
export interface ReportFilter {
  /** Filter by entity CUI */
  entity_cui?: string;
  /** Filter by reporting year */
  reporting_year?: number;
  /** Filter by reporting period */
  reporting_period?: string;
  /** Filter by report date start (inclusive, ISO date string) */
  report_date_start?: string;
  /** Filter by report date end (inclusive, ISO date string) */
  report_date_end?: string;
  /** Filter by report type (GraphQL enum value) */
  report_type?: GqlReportType;
  /** Filter by main creditor CUI */
  main_creditor_cui?: string;
  /** Search across entity name and download links (ILIKE) */
  search?: string;
}

/**
 * Report sort options.
 */
export interface ReportSort {
  by: string;
  order: 'ASC' | 'DESC';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for reports.
 */
export interface ReportPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of reports.
 */
export interface ReportConnection {
  nodes: Report[];
  pageInfo: ReportPageInfo;
}
