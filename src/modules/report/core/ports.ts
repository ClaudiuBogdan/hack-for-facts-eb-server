/**
 * Port interfaces for Report module.
 *
 * Defines repository contracts that shell layer must implement.
 */

import type { ReportError } from './errors.js';
import type { Report, ReportConnection, ReportFilter, ReportSort } from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Report Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for report data access.
 */
export interface ReportRepository {
  /**
   * Get a single report by ID.
   *
   * @param reportId - The report ID to look up
   * @returns The report if found, null if not found, or an error
   */
  getById(reportId: string): Promise<Result<Report | null, ReportError>>;

  /**
   * Batch load reports by IDs.
   * Used by Mercurius loaders for N+1 prevention.
   *
   * @param reportIds - Array of report IDs
   * @returns Map of report ID to Report (missing IDs won't have entries)
   */
  getByIds(reportIds: string[]): Promise<Result<Map<string, Report>, ReportError>>;

  /**
   * Get a report by entity CUI and report date.
   *
   * @param entityCui - Entity CUI
   * @param reportDate - Report date
   * @returns The report if found, null if not found, or an error
   */
  getByEntityAndDate(
    entityCui: string,
    reportDate: Date
  ): Promise<Result<Report | null, ReportError>>;

  /**
   * List reports with filtering, sorting, and pagination.
   *
   * Filtering:
   * - entity_cui: exact match
   * - reporting_year: exact match
   * - reporting_period: exact match
   * - report_date_start/end: date range (inclusive)
   * - report_type: exact match (converted from GQL to DB enum)
   * - main_creditor_cui: exact match
   * - search: ILIKE on entity name and download_links
   *
   * Sorting:
   * - Default: report_date DESC, report_id DESC
   * - Only 'report_date' is allowed as sort field
   *
   * @param filter - Filter criteria
   * @param sort - Sort configuration (optional)
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated report connection
   */
  list(
    filter: ReportFilter,
    sort: ReportSort | undefined,
    limit: number,
    offset: number
  ): Promise<Result<ReportConnection, ReportError>>;

  /**
   * Count reports matching filter.
   *
   * @param filter - Filter criteria
   * @returns Total count of matching reports
   */
  count(filter: ReportFilter): Promise<Result<number, ReportError>>;
}
