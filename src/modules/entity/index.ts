/**
 * Entity Module Public API
 *
 * Exports types, use cases, repositories, and GraphQL components.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Entity,
  EntityFilter,
  EntityConnection,
  EntityPageInfo,
  UAT,
  UATFilter,
  UATConnection,
  UATPageInfo,
  Report,
  ReportConnection,
  ReportPageInfo,
  ReportFilter,
  ReportSort,
  EntityTotals,
  DbReportType,
  GqlReportType,
  ReportPeriodInput,
  NormalizationMode,
  AnalyticsSeries,
  DataSeries,
} from './core/types.js';

export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SIMILARITY_THRESHOLD,
  DEFAULT_REPORT_LIMIT,
  MAX_REPORT_LIMIT,
  DEFAULT_REPORT_ELI_LIMIT,
  DEFAULT_UAT_LIMIT,
  MAX_UAT_LIMIT,
  UAT_SIMILARITY_THRESHOLD,
  GQL_TO_DB_REPORT_TYPE,
  DB_TO_GQL_REPORT_TYPE,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { EntityError } from './core/errors.js';

export {
  createDatabaseError,
  createTimeoutError,
  createEntityNotFoundError,
  createInvalidFilterError,
  createInvalidPeriodError,
  isTimeoutError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export type {
  EntityRepository,
  UATRepository,
  ReportRepository,
  EntityAnalyticsSummaryRepository,
} from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export { getEntity, type GetEntityDeps, type GetEntityInput } from './core/usecases/get-entity.js';

export {
  listEntities,
  type ListEntitiesDeps,
  type ListEntitiesInput,
} from './core/usecases/list-entities.js';

export { getReport, type GetReportDeps, type GetReportInput } from './core/usecases/get-report.js';

export {
  listReports,
  type ListReportsDeps,
  type ListReportsInput,
} from './core/usecases/list-reports.js';

export { getUAT, type GetUATDeps, type GetUATInput } from './core/usecases/get-uat.js';

export { listUATs, type ListUATsDeps, type ListUATsInput } from './core/usecases/list-uats.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repositories
// ─────────────────────────────────────────────────────────────────────────────

export { makeEntityRepo } from './shell/repo/entity-repo.js';
export { makeEntityAnalyticsSummaryRepo } from './shell/repo/entity-analytics-repo.js';
export { makeUATRepo } from './shell/repo/uat-repo.js';
export { makeReportRepo } from './shell/repo/report-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL
// ─────────────────────────────────────────────────────────────────────────────

export { EntitySchema } from './shell/graphql/schema.js';
export { makeEntityResolvers, type MakeEntityResolversDeps } from './shell/graphql/resolvers.js';
