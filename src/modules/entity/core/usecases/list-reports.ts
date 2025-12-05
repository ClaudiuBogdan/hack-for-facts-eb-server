/**
 * List Reports Use Case
 *
 * Lists reports with filtering, sorting, and pagination.
 */

import {
  MAX_REPORT_LIMIT,
  type ReportConnection,
  type ReportFilter,
  type ReportSort,
} from '../types.js';

import type { EntityError } from '../errors.js';
import type { ReportRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for list reports use case.
 */
export interface ListReportsDeps {
  reportRepo: ReportRepository;
}

/**
 * Input for list reports use case.
 */
export interface ListReportsInput {
  filter: ReportFilter;
  sort?: ReportSort;
  limit: number;
  offset: number;
}

/**
 * Lists reports with filtering, sorting, and pagination.
 *
 * The limit is clamped to MAX_REPORT_LIMIT to prevent excessive queries.
 *
 * @param deps - Repository dependencies
 * @param input - Filter, sort, and pagination options
 * @returns Paginated report connection
 */
export async function listReports(
  deps: ListReportsDeps,
  input: ListReportsInput
): Promise<Result<ReportConnection, EntityError>> {
  // Clamp limit to maximum allowed
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_REPORT_LIMIT);

  // Ensure offset is non-negative
  const clampedOffset = Math.max(input.offset, 0);

  return deps.reportRepo.list(input.filter, input.sort, clampedLimit, clampedOffset);
}
