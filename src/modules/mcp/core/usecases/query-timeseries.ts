/**
 * MCP Use Case: query_timeseries_data
 *
 * Multi-series time-series analysis for budget data comparisons.
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import { databaseError, toMcpError, invalidInputError, type McpError } from '../errors.js';
import {
  MAX_TIMESERIES_SERIES,
  type Granularity,
  type AxisUnit,
  type ValueUnit,
} from '../types.js';
import {
  validatePeriodSelection,
  normalizeFilterClassificationCodes,
  synthesizeLabelFromFilter,
} from '../utils.js';

import type { QueryTimeseriesInput, QueryTimeseriesOutput } from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

interface AnalyticsSeriesResult {
  seriesId: string;
  xAxis: { name: string; type: string; unit: string };
  yAxis: { name: string; type: string; unit: string };
  data: { x: string; y: number }[];
}

interface AnalyticsInput {
  seriesId?: string;
  filter: Record<string, unknown>;
}

export interface QueryTimeseriesDeps {
  analyticsService: {
    getAnalyticsSeries(inputs: AnalyticsInput[]): Promise<Result<AnalyticsSeriesResult[], unknown>>;
  };
  shareLink: {
    create(url: string): Promise<Result<string, unknown>>;
  };
  config: {
    clientBaseUrl: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps MCP granularity to internal Frequency enum.
 */
function mapGranularityToFrequency(granularity: Granularity): Frequency {
  switch (granularity) {
    case 'YEAR':
      return Frequency.YEAR;
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
  }
}

/**
 * Maps granularity to axis unit for output.
 */
function mapGranularityToAxisUnit(granularity: Granularity): AxisUnit {
  switch (granularity) {
    case 'YEAR':
      return 'year';
    case 'MONTH':
      return 'month';
    case 'QUARTER':
      return 'quarter';
  }
}

/**
 * Maps normalization mode to value unit for output.
 */
function mapNormalizationToValueUnit(normalization: string | undefined): ValueUnit {
  switch (normalization) {
    case 'per_capita':
      return 'RON/capita';
    case 'total_euro':
      return 'EUR';
    case 'per_capita_euro':
      return 'EUR/capita';
    case 'total':
    default:
      return 'RON';
  }
}

/**
 * Computes statistics for a data series.
 */
function computeStatistics(data: { x: string; y: number }[]): {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
} {
  if (data.length === 0) {
    return { min: 0, max: 0, avg: 0, sum: 0, count: 0 };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = new Decimal(0);

  for (const point of data) {
    if (point.y < min) min = point.y;
    if (point.y > max) max = point.y;
    sum = sum.plus(point.y);
  }

  const count = data.length;
  const avg = sum.dividedBy(count).toNumber();

  return {
    min: min === Number.POSITIVE_INFINITY ? 0 : min,
    max: max === Number.NEGATIVE_INFINITY ? 0 : max,
    avg,
    sum: sum.toNumber(),
    count,
  };
}

/**
 * Converts MCP analytics filter to internal format.
 */
function toInternalFilter(
  filter: Record<string, unknown>,
  period: QueryTimeseriesInput['period']
): Record<string, unknown> {
  // Normalize classification codes in the filter
  const normalizedFilter = normalizeFilterClassificationCodes(filter);

  const internal: Record<string, unknown> = {
    account_category: normalizedFilter['accountCategory'],
    report_type:
      normalizeReportType(normalizedFilter['reportType'] as string | undefined) ??
      'Executie bugetara agregata la nivel de ordonator principal',
    report_period: {
      type: mapGranularityToFrequency(period.type),
      selection: period.selection,
    },
    normalization: mapNormalization(normalizedFilter['normalization'] as string | undefined),
    inflation_adjusted: false,
    show_period_growth: false,
  };

  // Handle legacy normalization modes
  const normMode = normalizedFilter['normalization'] as string | undefined;
  if (normMode === 'total_euro' || normMode === 'per_capita_euro') {
    internal['currency'] = 'EUR';
  }

  // Map filter fields to snake_case internal format
  const fieldMappings: [string, string][] = [
    ['entityCuis', 'entity_cuis'],
    ['uatIds', 'uat_ids'],
    ['countyCodes', 'county_codes'],
    ['regions', 'regions'],
    ['isUat', 'is_uat'],
    ['minPopulation', 'min_population'],
    ['maxPopulation', 'max_population'],
    ['functionalCodes', 'functional_codes'],
    ['functionalPrefixes', 'functional_prefixes'],
    ['economicCodes', 'economic_codes'],
    ['economicPrefixes', 'economic_prefixes'],
    ['fundingSourceIds', 'funding_source_ids'],
    ['budgetSectorIds', 'budget_sector_ids'],
    ['expenseTypes', 'expense_types'],
    ['programCodes', 'program_codes'],
  ];

  for (const [camelCase, snakeCase] of fieldMappings) {
    if (normalizedFilter[camelCase] !== undefined) {
      internal[snakeCase] = normalizedFilter[camelCase];
    }
  }

  // Handle exclusions
  if (normalizedFilter['exclude'] !== undefined) {
    const exclude = normalizedFilter['exclude'] as Record<string, unknown>;
    internal['exclude'] = exclude;
  }

  return internal;
}

/**
 * Maps MCP normalization mode to internal format.
 */
function mapNormalization(mode: string | undefined): string {
  switch (mode) {
    case 'per_capita':
    case 'per_capita_euro':
      return 'per_capita';
    case 'total_euro':
    case 'total':
    default:
      return 'total';
  }
}

/**
 * Normalizes report type from various formats to database format.
 */
function normalizeReportType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const raw = value.trim();
  const DB_PRINCIPAL = 'Executie bugetara agregata la nivel de ordonator principal';
  const DB_SECONDARY = 'Executie bugetara agregata la nivel de ordonator secundar';
  const DB_DETAILED = 'Executie bugetara detaliata';

  // Pass-through for exact DB enum values
  if (raw === DB_PRINCIPAL || raw === DB_SECONDARY || raw === DB_DETAILED) return raw;

  // Normalize common aliases
  const lc = raw.toLowerCase().replace(/\s+/g, '_');
  if (lc === 'principal_aggregated') return DB_PRINCIPAL;
  if (lc === 'secondary_aggregated') return DB_SECONDARY;
  if (lc === 'detailed') return DB_DETAILED;

  // Uppercase GraphQL style tokens
  if (raw === 'PRINCIPAL_AGGREGATED') return DB_PRINCIPAL;
  if (raw === 'SECONDARY_AGGREGATED') return DB_SECONDARY;
  if (raw === 'DETAILED') return DB_DETAILED;

  return raw;
}

/**
 * Builds a shareable chart link.
 */
function buildChartLink(
  baseUrl: string,
  title: string,
  series: { label: string; filter: Record<string, unknown> }[],
  period: QueryTimeseriesInput['period']
): string {
  const chartSchema = {
    title,
    period,
    series: series.map((s) => ({
      label: s.label,
      filter: s.filter,
    })),
  };

  const params = new URLSearchParams();
  params.set('view', 'chart');
  params.set('schema', JSON.stringify(chartSchema));
  return `${baseUrl}/analytics?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query multi-series time-series data for comparison and analysis.
 */
export async function queryTimeseries(
  deps: QueryTimeseriesDeps,
  input: QueryTimeseriesInput
): Promise<Result<QueryTimeseriesOutput, McpError>> {
  const { title, period, series } = input;

  // Validate series count
  if (series.length === 0) {
    return err(invalidInputError('At least one series is required'));
  }
  if (series.length > MAX_TIMESERIES_SERIES) {
    return err(invalidInputError(`Maximum ${String(MAX_TIMESERIES_SERIES)} series allowed`));
  }

  // Validate period selection
  const periodValidation = validatePeriodSelection(period.selection, period.type);
  if (periodValidation.isErr()) {
    return err(periodValidation.error);
  }

  // Build analytics inputs for each series
  const analyticsInputs: AnalyticsInput[] = series.map((s, index) => {
    const filter = s.filter as Record<string, unknown>;
    const internalFilter = toInternalFilter(filter, period);

    return {
      seriesId: `series-${String(index)}`,
      filter: internalFilter,
    };
  });

  // Fetch data for all series
  const result = await deps.analyticsService.getAnalyticsSeries(analyticsInputs);
  if (result.isErr()) {
    const domainError = result.error as { type?: string; message?: string; cause?: unknown };
    if (domainError.type !== undefined) {
      return err(toMcpError({ type: domainError.type, message: domainError.message ?? '' }));
    }
    // Extract error message for debugging
    const errorDetail =
      domainError.message ?? (result.error instanceof Error ? result.error.message : undefined);
    return err(databaseError(errorDetail));
  }

  const analyticsResults = result.value;

  // Build output series with statistics
  const dataSeries = analyticsResults.flatMap((ar, index) => {
    const seriesDef = series[index];
    if (seriesDef === undefined) {
      // Skip missing series definitions (should never happen but satisfies type checker)
      return [];
    }
    const filter = seriesDef.filter as Record<string, unknown>;

    // Synthesize label if not provided
    const label = seriesDef.label ?? synthesizeLabelFromFilter(filter);

    // Compute statistics
    const statistics = computeStatistics(ar.data);

    // Map axes
    const xAxisUnit = mapGranularityToAxisUnit(period.type);
    const yAxisUnit = mapNormalizationToValueUnit(filter['normalization'] as string | undefined);

    return [
      {
        label,
        seriesId: ar.seriesId,
        xAxis: {
          name: ar.xAxis.name,
          unit: xAxisUnit,
        },
        yAxis: {
          name: ar.yAxis.name,
          unit: yAxisUnit,
        },
        dataPoints: ar.data.map((d) => ({ x: d.x, y: d.y })),
        statistics,
      },
    ];
  });

  // Generate title
  const firstSeries = dataSeries[0];
  const chartTitle =
    title ??
    (dataSeries.length === 1 && firstSeries !== undefined
      ? firstSeries.label
      : 'Budget Comparison');

  // Build shareable link
  const fullLink = buildChartLink(
    deps.config.clientBaseUrl,
    chartTitle,
    series.map((s, i) => {
      const dataSeriesItem = dataSeries[i];
      return {
        label: dataSeriesItem !== undefined ? dataSeriesItem.label : `Series ${String(i)}`,
        filter: s.filter as Record<string, unknown>,
      };
    }),
    period
  );
  const linkResult = await deps.shareLink.create(fullLink);
  const dataLink = linkResult.isOk() ? linkResult.value : fullLink;

  return ok({
    ok: true,
    title: chartTitle,
    dataLink,
    dataSeries,
  });
}
