import { err, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { COMMITMENT_REPORT_TYPES, type CommitmentReportType } from './constants.js';

/** Fixed source metrics, never caller-provided SQL identifiers. */
export const COMMITMENT_PERIOD_METRICS = [
  'credite_angajament',
  'limita_credit_angajament',
  'credite_bugetare',
  'credite_angajament_initiale',
  'credite_bugetare_initiale',
  'credite_angajament_definitive',
  'credite_bugetare_definitive',
  'credite_angajament_disponibile',
  'credite_bugetare_disponibile',
  'receptii_totale',
  'plati_trezor',
  'plati_non_trezor',
  'receptii_neplatite',
] as const;

export interface CommitmentPeriodQuery {
  readonly cui: string;
  readonly year: number;
  readonly reportType: CommitmentReportType;
  /** Select report endpoints. Never clip or redistribute an interval amount. */
  readonly startMonth: number;
  readonly endMonth: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CommitmentPeriod {
  readonly reportId: string;
  readonly sectorId: number;
  readonly creditorCui: string | null;
  readonly sourceUrl: string;
  readonly endMonth: number;
  readonly startMonth: number | null;
  readonly monthsCovered: number | null;
  readonly observation: string;
  readonly continuity: string;
  readonly isQuarterly: boolean;
  readonly isLatestYtd: boolean;
  readonly isYearEnd: boolean;
  readonly amounts: readonly {
    readonly metric: string;
    readonly interval: string | null;
    readonly ytd: string | null;
  }[];
}

export interface CommitmentPeriodPage {
  /** Published source-period availability, not an independent whole-year audit. */
  readonly metadataAvailable: boolean;
  readonly total: number;
  readonly earliestTerminalMonth: number | null;
  readonly latestTerminalMonth: number | null;
  readonly items: readonly CommitmentPeriod[];
}

export interface BudgetPeriodRepo {
  listCommitmentPeriods(
    query: CommitmentPeriodQuery
  ): Promise<Result<CommitmentPeriodPage, ApiError>>;
}

export const listCommitmentPeriods = (
  repo: BudgetPeriodRepo,
  query: CommitmentPeriodQuery
): Promise<Result<CommitmentPeriodPage, ApiError>> => {
  if (
    !/^[0-9]{1,10}$/u.test(query.cui) ||
    !Number.isInteger(query.year) ||
    query.year < 1 ||
    query.year > 9999 ||
    !COMMITMENT_REPORT_TYPES.includes(query.reportType) ||
    !Number.isInteger(query.startMonth) ||
    query.startMonth < 1 ||
    !Number.isInteger(query.endMonth) ||
    query.endMonth > 12 ||
    query.startMonth > query.endMonth ||
    !Number.isInteger(query.page) ||
    query.page < 1 ||
    query.page > 10000 ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 100
  ) {
    return Promise.resolve(err(invalidInput('Invalid commitment period scope or pagination')));
  }
  return repo.listCommitmentPeriods(query);
};
