/**
 * Report Module Public API
 *
 * Exports types, use cases, repositories, and GraphQL components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Report,
  ReportFilter,
  ReportSort,
  ReportConnection,
  ReportPageInfo,
  DbReportType,
  GqlReportType,
} from './core/types.js';

export {
  DEFAULT_REPORT_LIMIT,
  MAX_REPORT_LIMIT,
  DEFAULT_REPORT_ELI_LIMIT,
  GQL_TO_DB_REPORT_TYPE,
  DB_TO_GQL_REPORT_TYPE,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { ReportError } from './core/errors.js';

export {
  createDatabaseError,
  createTimeoutError,
  createReportNotFoundError,
  createInvalidFilterError,
  isTimeoutError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export type { ReportRepository } from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export { getReport, type GetReportDeps, type GetReportInput } from './core/usecases/get-report.js';

export {
  listReports,
  type ListReportsDeps,
  type ListReportsInput,
} from './core/usecases/list-reports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────

export { makeReportRepo } from './shell/repo/report-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export { ReportSchema } from './shell/graphql/schema.js';
export { makeReportResolvers, type MakeReportResolversDeps } from './shell/graphql/resolvers.js';
export { createReportLoaders } from './shell/graphql/loaders.js';
