/**
 * Get Report Use Case
 *
 * Retrieves a single report by ID.
 */

import type { EntityError } from '../errors.js';
import type { ReportRepository } from '../ports.js';
import type { Report } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for get report use case.
 */
export interface GetReportDeps {
  reportRepo: ReportRepository;
}

/**
 * Input for get report use case.
 */
export interface GetReportInput {
  reportId: string;
}

/**
 * Retrieves a single report by ID.
 *
 * @param deps - Repository dependencies
 * @param input - Report ID to look up
 * @returns The report if found, null if not found
 */
export async function getReport(
  deps: GetReportDeps,
  input: GetReportInput
): Promise<Result<Report | null, EntityError>> {
  return deps.reportRepo.getById(input.reportId);
}
