/** Native commitments retain exact years and use the financial map normalization. */
import { err, type Result } from 'neverthrow';

import {
  COMMITMENTS_REPORT_TYPE_BY_GQL,
  type GqlCommitmentsReportType,
  isMetricAvailableForPeriod,
  type CommitmentsMetric,
} from '@/common/types/commitments.js';
import { Frequency } from '@/common/types/temporal.js';
import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { COMMITMENT_REPORT_TYPE_FROM_LABEL } from '../constants.js';
import { cleanFilter } from './clean.js';
import { normalizeBudgetMapYears, type BudgetMapDeps } from './map-usecase.js';
import { resolveNormalizationPlan } from './normalize.js';

import type { BudgetMapGranularity, BudgetMapResult, BudgetMapYear } from './map-types.js';
import type { LegacyAggregateQuery, LegacyAnalyticsFilter } from './types.js';

export interface CommitmentsMapInput {
  readonly granularity: BudgetMapGranularity;
  readonly metric: CommitmentsMetric;
  readonly filter: Omit<LegacyAnalyticsFilter, 'account_category'> & {
    readonly exclude_transfers?: boolean;
  };
}
export interface CommitmentsMapRepo {
  yearlyAmounts(
    query: LegacyAggregateQuery,
    granularity: BudgetMapGranularity,
    metric: CommitmentsMetric,
    excludeTransfers: boolean
  ): Promise<Result<readonly BudgetMapYear[], ApiError>>;
}

export async function commitmentsMapValues(
  deps: Pick<BudgetMapDeps, 'factors' | 'population'> & { readonly repo: CommitmentsMapRepo },
  input: CommitmentsMapInput
): Promise<Result<BudgetMapResult, ApiError>> {
  const { report_type: rawReport, ...filter } = input.filter;
  const requestedReport = rawReport?.trim();
  const reportType =
    requestedReport != null &&
    Object.prototype.hasOwnProperty.call(COMMITMENTS_REPORT_TYPE_BY_GQL, requestedReport)
      ? COMMITMENTS_REPORT_TYPE_BY_GQL[requestedReport as GqlCommitmentsReportType]
      : requestedReport;
  if (reportType != null && !COMMITMENT_REPORT_TYPE_FROM_LABEL.has(reportType))
    return err(invalidInput('Choose a supported commitments report type', 'report_type'));
  if (!isMetricAvailableForPeriod(input.metric, Frequency[input.filter.report_period.type]))
    return err(
      invalidInput('This commitments metric is unavailable at the selected frequency', 'metric')
    );
  if (
    (filter.expense_types?.length ?? 0) > 0 ||
    (filter.program_codes?.length ?? 0) > 0 ||
    (filter.exclude?.expense_types?.length ?? 0) > 0 ||
    (filter.exclude?.program_codes?.length ?? 0) > 0
  )
    return err(
      invalidInput('Commitments do not have execution expense or program dimensions', 'filter')
    );
  // Classification exclusions use expense semantics; there is no account column on commitments.
  const common = { ...filter, account_category: 'ch' as const };
  const query = cleanFilter(common);
  if (query.isErr()) return err(query.error);
  const plan = resolveNormalizationPlan(common);
  if (plan.showPeriodGrowth)
    return err(
      invalidInput('Period growth cannot be aggregated into a map interval', 'show_period_growth')
    );
  const rows = await deps.repo.yearlyAmounts(
    { ...query.value, reportType: reportType ?? null },
    input.granularity,
    input.metric,
    input.filter.exclude_transfers !== false
  );
  if (rows.isErr()) return err(rows.error);
  return normalizeBudgetMapYears(deps, {
    rows: rows.value,
    plan,
    ...(query.value.aggregateMinAmount === undefined
      ? {}
      : { minimum: query.value.aggregateMinAmount }),
    ...(query.value.aggregateMaxAmount === undefined
      ? {}
      : { maximum: query.value.aggregateMaxAmount }),
  });
}
