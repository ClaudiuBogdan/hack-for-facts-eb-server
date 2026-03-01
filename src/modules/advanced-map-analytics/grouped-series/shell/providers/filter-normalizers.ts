import { err, ok, type Result } from 'neverthrow';

import {
  COMMITMENTS_REPORT_TYPE_BY_GQL,
  type GqlCommitmentsReportType,
} from '@/common/types/commitments.js';
import {
  GQL_TO_DB_REPORT_TYPE,
  isCommitmentDbReportType,
  isExecutionDbReportType,
  isExecutionGqlReportType,
  type DbCommitmentsReportType,
} from '@/common/types/report-types.js';
import { Frequency } from '@/common/types/temporal.js';

import { createInvalidInputError, type InvalidInputError } from '../../core/errors.js';

import type {
  CommitmentsMapSeriesFilter,
  CommitmentsMapSeries,
  ExecutionMapSeries,
  GroupedSeriesWarning,
  MapSeriesNormalizationMode,
} from '../../core/types.js';
import type {
  AccountCategory,
  AnalyticsFilter,
  Currency,
  NormalizationMode,
  ReportPeriodInput,
} from '@/common/types/analytics.js';
import type { CommitmentsFilter } from '@/modules/commitments/index.js';
import type { HeatmapTransformationOptions } from '@/modules/uat-analytics/index.js';

const DEFAULT_CURRENCY: Currency = 'RON';
const DEFAULT_NORMALIZATION: NormalizationMode = 'total';

interface NormalizedTransforms {
  normalization: NormalizationMode;
  currency: Currency;
  inflationAdjusted: boolean;
  showPeriodGrowth: boolean;
}

export interface NormalizedExecutionSeriesInput {
  filter: AnalyticsFilter;
  options: HeatmapTransformationOptions;
  warnings: GroupedSeriesWarning[];
}

export interface NormalizedCommitmentsSeriesInput {
  filter: CommitmentsFilter;
  transforms: NormalizedTransforms;
  warnings: GroupedSeriesWarning[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFrequency(value: unknown): value is Frequency {
  return value === Frequency.MONTH || value === Frequency.QUARTER || value === Frequency.YEAR;
}

function isReportPeriodInput(value: unknown): value is ReportPeriodInput {
  if (!isPlainObject(value)) {
    return false;
  }

  const type = value['type'];
  const selection = value['selection'];
  if (!isFrequency(type) || !isPlainObject(selection)) {
    return false;
  }

  const interval = selection['interval'];
  const dates = selection['dates'];
  const hasInterval =
    isPlainObject(interval) &&
    typeof interval['start'] === 'string' &&
    interval['start'].trim() !== '' &&
    typeof interval['end'] === 'string' &&
    interval['end'].trim() !== '';
  const hasDates =
    Array.isArray(dates) && dates.length > 0 && dates.every((date) => typeof date === 'string');

  return hasInterval || hasDates;
}

function normalizeNormalizationMode(
  rawNormalization: MapSeriesNormalizationMode | undefined,
  rawCurrency: Currency | undefined
): Pick<NormalizedTransforms, 'normalization' | 'currency'> {
  if (rawNormalization === 'total_euro') {
    return { normalization: 'total', currency: 'EUR' };
  }

  if (rawNormalization === 'per_capita_euro') {
    return { normalization: 'per_capita', currency: 'EUR' };
  }

  return {
    normalization: rawNormalization ?? DEFAULT_NORMALIZATION,
    currency: rawCurrency ?? DEFAULT_CURRENCY,
  };
}

function normalizeTransforms(
  seriesId: string,
  rawNormalization: MapSeriesNormalizationMode | undefined,
  rawCurrency: Currency | undefined,
  rawInflationAdjusted: boolean | undefined,
  rawShowPeriodGrowth: boolean | undefined
): { transforms: NormalizedTransforms; warnings: GroupedSeriesWarning[] } {
  const warnings: GroupedSeriesWarning[] = [];
  const mapped = normalizeNormalizationMode(rawNormalization, rawCurrency);
  const showPeriodGrowth = rawShowPeriodGrowth === true;

  if (showPeriodGrowth) {
    warnings.push({
      type: 'show_period_growth_ignored',
      message: 'show_period_growth is ignored for map scalar extraction',
      seriesId,
    });
  }

  const inflationAdjusted =
    mapped.normalization === 'percent_gdp' ? false : (rawInflationAdjusted ?? false);

  return {
    transforms: {
      normalization: mapped.normalization,
      currency: mapped.currency,
      inflationAdjusted,
      showPeriodGrowth,
    },
    warnings,
  };
}

function asExecutionReportType(value: unknown): Result<string | undefined, InvalidInputError> {
  if (value === undefined || value === null) {
    return ok(undefined);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return err(
      createInvalidInputError('execution series filter.report_type must be a non-empty string')
    );
  }

  const normalized = value.trim();
  if (isExecutionDbReportType(normalized)) {
    return ok(normalized);
  }

  if (isExecutionGqlReportType(normalized)) {
    return ok(GQL_TO_DB_REPORT_TYPE[normalized]);
  }

  return ok(normalized);
}

function asCommitmentsReportType(
  value: unknown
): Result<DbCommitmentsReportType | undefined, InvalidInputError> {
  if (value === undefined || value === null) {
    return ok(undefined);
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return err(
      createInvalidInputError('commitments series filter.report_type must be a non-empty string')
    );
  }

  const normalized = value.trim();
  if (isCommitmentDbReportType(normalized)) {
    return ok(normalized);
  }

  if (Object.prototype.hasOwnProperty.call(COMMITMENTS_REPORT_TYPE_BY_GQL, normalized)) {
    const gql = normalized as GqlCommitmentsReportType;
    return ok(COMMITMENTS_REPORT_TYPE_BY_GQL[gql]);
  }

  return err(
    createInvalidInputError(
      `Unsupported commitments report_type: ${normalized}. Use DB values or PRINCIPAL_AGGREGATED|SECONDARY_AGGREGATED|DETAILED`
    )
  );
}

function validateAccountCategory(value: unknown): value is AccountCategory {
  return value === 'ch' || value === 'vn';
}

export function normalizeExecutionSeriesInput(
  series: ExecutionMapSeries
): Result<NormalizedExecutionSeriesInput, InvalidInputError> {
  const filter = series.filter;
  if (!validateAccountCategory(filter.account_category)) {
    return err(
      createInvalidInputError('execution series filter.account_category must be one of: ch, vn')
    );
  }

  if (!isReportPeriodInput(filter.report_period)) {
    return err(createInvalidInputError('execution series filter.report_period is required'));
  }

  const reportTypeResult = asExecutionReportType(filter.report_type);
  if (reportTypeResult.isErr()) {
    return err(reportTypeResult.error);
  }

  const reportType = reportTypeResult.value;
  if (typeof reportType !== 'string' || reportType.trim() === '') {
    return err(createInvalidInputError('execution series filter.report_type is required'));
  }

  const transformsResult = normalizeTransforms(
    series.id,
    filter.normalization,
    filter.currency,
    filter.inflation_adjusted,
    filter.show_period_growth
  );

  const normalizedFilter: AnalyticsFilter = {
    ...filter,
    account_category: filter.account_category,
    report_period: filter.report_period,
    report_type: reportType,
  };

  return ok({
    filter: normalizedFilter,
    options: {
      inflationAdjusted: transformsResult.transforms.inflationAdjusted,
      currency: transformsResult.transforms.currency,
      normalization: transformsResult.transforms.normalization,
    },
    warnings: transformsResult.warnings,
  });
}

function normalizeCommitmentsFilterInput(
  input: CommitmentsMapSeriesFilter
): Omit<
  CommitmentsFilter,
  | 'report_type'
  | 'normalization'
  | 'currency'
  | 'inflation_adjusted'
  | 'show_period_growth'
  | 'exclude_transfers'
> {
  return {
    ...input,
    report_period: input.report_period,
    ...(input.entity_cuis !== undefined ? { entity_cuis: input.entity_cuis } : {}),
    ...(input.main_creditor_cui !== undefined
      ? { main_creditor_cui: input.main_creditor_cui }
      : {}),
    ...(input.entity_types !== undefined ? { entity_types: input.entity_types } : {}),
    ...(input.is_uat !== undefined ? { is_uat: input.is_uat } : {}),
    ...(input.search !== undefined ? { search: input.search } : {}),
    ...(input.functional_codes !== undefined ? { functional_codes: input.functional_codes } : {}),
    ...(input.functional_prefixes !== undefined
      ? { functional_prefixes: input.functional_prefixes }
      : {}),
    ...(input.economic_codes !== undefined ? { economic_codes: input.economic_codes } : {}),
    ...(input.economic_prefixes !== undefined
      ? { economic_prefixes: input.economic_prefixes }
      : {}),
    ...(input.funding_source_ids !== undefined
      ? { funding_source_ids: input.funding_source_ids }
      : {}),
    ...(input.budget_sector_ids !== undefined
      ? { budget_sector_ids: input.budget_sector_ids }
      : {}),
    ...(input.county_codes !== undefined ? { county_codes: input.county_codes } : {}),
    ...(input.regions !== undefined ? { regions: input.regions } : {}),
    ...(input.uat_ids !== undefined ? { uat_ids: input.uat_ids } : {}),
    ...(input.min_population !== undefined ? { min_population: input.min_population } : {}),
    ...(input.max_population !== undefined ? { max_population: input.max_population } : {}),
    ...(input.aggregate_min_amount !== undefined
      ? { aggregate_min_amount: input.aggregate_min_amount }
      : {}),
    ...(input.aggregate_max_amount !== undefined
      ? { aggregate_max_amount: input.aggregate_max_amount }
      : {}),
    ...(input.item_min_amount !== undefined ? { item_min_amount: input.item_min_amount } : {}),
    ...(input.item_max_amount !== undefined ? { item_max_amount: input.item_max_amount } : {}),
    ...(input.exclude !== undefined ? { exclude: input.exclude } : {}),
  };
}

export function normalizeCommitmentsSeriesInput(
  series: CommitmentsMapSeries
): Result<NormalizedCommitmentsSeriesInput, InvalidInputError> {
  const filter = series.filter;
  if (!isReportPeriodInput(filter.report_period)) {
    return err(createInvalidInputError('commitments series filter.report_period is required'));
  }

  const reportTypeResult = asCommitmentsReportType(filter.report_type);
  if (reportTypeResult.isErr()) {
    return err(reportTypeResult.error);
  }

  const transformsResult = normalizeTransforms(
    series.id,
    filter.normalization,
    filter.currency,
    filter.inflation_adjusted,
    filter.show_period_growth
  );

  const normalizedFilter: CommitmentsFilter = {
    ...normalizeCommitmentsFilterInput(filter),
    report_period: filter.report_period,
    ...(reportTypeResult.value !== undefined ? { report_type: reportTypeResult.value } : {}),
    normalization: transformsResult.transforms.normalization,
    currency: transformsResult.transforms.currency,
    inflation_adjusted: transformsResult.transforms.inflationAdjusted,
    show_period_growth: false,
    exclude_transfers: filter.exclude_transfers ?? true,
  };

  return ok({
    filter: normalizedFilter,
    transforms: transformsResult.transforms,
    warnings: transformsResult.warnings,
  });
}
