// ============================================================================
// Report Type Mapping (Execution + Commitments)
// ============================================================================

export const EXECUTION_DB_REPORT_TYPES = [
  'Executie bugetara agregata la nivel de ordonator principal',
  'Executie bugetara agregata la nivel de ordonator secundar',
  'Executie bugetara detaliata',
] as const;

export type DbExecutionReportType = (typeof EXECUTION_DB_REPORT_TYPES)[number];

export const COMMITMENT_DB_REPORT_TYPES = [
  'Executie - Angajamente bugetare detaliat',
  'Executie - Angajamente bugetare agregat principal',
  'Executie - Angajamente bugetare agregat secundar',
] as const;

export type DbCommitmentsReportType = (typeof COMMITMENT_DB_REPORT_TYPES)[number];

export const DB_REPORT_TYPES = [
  ...EXECUTION_DB_REPORT_TYPES,
  ...COMMITMENT_DB_REPORT_TYPES,
] as const;

export type DbReportType = (typeof DB_REPORT_TYPES)[number];

export const EXECUTION_GQL_REPORT_TYPES = [
  'PRINCIPAL_AGGREGATED',
  'SECONDARY_AGGREGATED',
  'DETAILED',
] as const;

export type ExecutionGqlReportType = (typeof EXECUTION_GQL_REPORT_TYPES)[number];

export const COMMITMENT_GQL_REPORT_TYPES = [
  'COMMITMENT_PRINCIPAL_AGGREGATED',
  'COMMITMENT_SECONDARY_AGGREGATED',
  'COMMITMENT_DETAILED',
] as const;

export type CommitmentGqlReportType = (typeof COMMITMENT_GQL_REPORT_TYPES)[number];

export const GQL_REPORT_TYPES = [
  ...EXECUTION_GQL_REPORT_TYPES,
  ...COMMITMENT_GQL_REPORT_TYPES,
] as const;

export type GqlReportType = (typeof GQL_REPORT_TYPES)[number];

export const GQL_TO_DB_REPORT_TYPE = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
  COMMITMENT_PRINCIPAL_AGGREGATED: 'Executie - Angajamente bugetare agregat principal',
  COMMITMENT_SECONDARY_AGGREGATED: 'Executie - Angajamente bugetare agregat secundar',
  COMMITMENT_DETAILED: 'Executie - Angajamente bugetare detaliat',
} as const satisfies Record<GqlReportType, DbReportType>;

export const DB_TO_GQL_REPORT_TYPE = {
  'Executie bugetara agregata la nivel de ordonator principal': 'PRINCIPAL_AGGREGATED',
  'Executie bugetara agregata la nivel de ordonator secundar': 'SECONDARY_AGGREGATED',
  'Executie bugetara detaliata': 'DETAILED',
  'Executie - Angajamente bugetare agregat principal': 'COMMITMENT_PRINCIPAL_AGGREGATED',
  'Executie - Angajamente bugetare agregat secundar': 'COMMITMENT_SECONDARY_AGGREGATED',
  'Executie - Angajamente bugetare detaliat': 'COMMITMENT_DETAILED',
} as const satisfies Record<DbReportType, GqlReportType>;

const EXECUTION_DB_REPORT_TYPE_SET = new Set<string>(EXECUTION_DB_REPORT_TYPES);
const COMMITMENT_DB_REPORT_TYPE_SET = new Set<string>(COMMITMENT_DB_REPORT_TYPES);
const DB_REPORT_TYPE_SET = new Set<string>(DB_REPORT_TYPES);

const EXECUTION_GQL_REPORT_TYPE_SET = new Set<string>(EXECUTION_GQL_REPORT_TYPES);
const COMMITMENT_GQL_REPORT_TYPE_SET = new Set<string>(COMMITMENT_GQL_REPORT_TYPES);

export const isExecutionDbReportType = (value: string): value is DbExecutionReportType =>
  EXECUTION_DB_REPORT_TYPE_SET.has(value);

export const isCommitmentDbReportType = (value: string): value is DbCommitmentsReportType =>
  COMMITMENT_DB_REPORT_TYPE_SET.has(value);

export const isDbReportType = (value: string): value is DbReportType =>
  DB_REPORT_TYPE_SET.has(value);

export const isExecutionGqlReportType = (value: string): value is ExecutionGqlReportType =>
  EXECUTION_GQL_REPORT_TYPE_SET.has(value);

export const isCommitmentGqlReportType = (value: string): value is CommitmentGqlReportType =>
  COMMITMENT_GQL_REPORT_TYPE_SET.has(value);
