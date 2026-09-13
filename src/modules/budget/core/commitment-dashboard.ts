/** Bounded entity dashboard; balances and period movements are separate fields. */
import { err, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  COMMITMENT_REPORT_TYPES,
  BUDGET_FREQUENCIES,
  BUDGET_NORMALIZATIONS,
  type CommitmentReportType,
  type BudgetFrequency,
  type BudgetNormalization,
} from './constants.js';

import type { BudgetMoneyOptions } from './money-options.js';
export interface CommitmentDashboardQuery extends BudgetMoneyOptions {
  readonly cui: string;
  readonly mainCreditorCui?: string;
  readonly detailYear: number;
  readonly reportType: CommitmentReportType;
  readonly yearFrom: number;
  readonly yearTo: number;
  readonly frequency: BudgetFrequency;
  readonly normalization: BudgetNormalization;
}
export const DASHBOARD_AMOUNTS = [
  'budget',
  'authority',
  'committed',
  'paidTreasury',
  'paidNonTreasury',
] as const;
export interface CommitmentDashboardRow {
  readonly year: number;
  readonly period: number;
  readonly firstReportMonth: number | null;
  readonly lastReportMonth: number | null;
  readonly functionalCode: string;
  readonly economicCode: string | null;
  readonly budget: string | null;
  readonly authority: string | null;
  readonly committed: string | null;
  readonly paidTreasury: string | null;
  readonly paidNonTreasury: string | null;
}
export interface CommitmentDashboard {
  readonly rows: readonly CommitmentDashboardRow[];
  readonly unavailableYears: readonly number[];
}
export interface CommitmentDashboardRepo {
  read(query: CommitmentDashboardQuery): Promise<Result<CommitmentDashboard, ApiError>>;
}
export const commitmentDashboard = (
  repo: CommitmentDashboardRepo,
  query: CommitmentDashboardQuery
): Promise<Result<CommitmentDashboard, ApiError>> => {
  if (
    !/^[0-9]{1,10}$/u.test(query.cui) ||
    (query.mainCreditorCui !== undefined && !/^[0-9]{1,10}$/u.test(query.mainCreditorCui)) ||
    !Number.isInteger(query.detailYear) ||
    query.detailYear < query.yearFrom ||
    query.detailYear > query.yearTo ||
    !COMMITMENT_REPORT_TYPES.includes(query.reportType) ||
    !BUDGET_FREQUENCIES.includes(query.frequency) ||
    !BUDGET_NORMALIZATIONS.includes(query.normalization) ||
    !Number.isInteger(query.yearFrom) ||
    !Number.isInteger(query.yearTo) ||
    query.yearFrom < 2000 ||
    query.yearTo > 2100 ||
    query.yearTo < query.yearFrom ||
    query.yearTo - query.yearFrom > 15 ||
    (query.currency !== undefined && !['RON', 'EUR', 'USD'].includes(query.currency)) ||
    (query.inflationAdjusted !== undefined && typeof query.inflationAdjusted !== 'boolean')
  )
    return Promise.resolve(err(invalidInput('Invalid commitment dashboard selection')));
  return repo.read(query);
};
