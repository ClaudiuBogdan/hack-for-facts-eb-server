/**
 * MCP Analytics Service Adapter
 *
 * Wraps the existing analytics repository to provide the interface
 * needed by the MCP queryTimeseries use case.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  Frequency,
  type DataSeries,
  type DataPoint as TemporalDataPoint,
  extractYearFromLabel,
  toNormalizableDataPoint,
} from '@/common/types/temporal.js';

import { databaseError, timeoutError, type McpError } from '../../core/errors.js';

import type {
  AnalyticsFilter,
  ExpenseType,
  PeriodSelection,
  NormalizationMode,
  Currency,
} from '@/common/types/analytics.js';
import type { AnalyticsRepository } from '@/modules/execution-analytics/core/ports.js';
import type { TransformationOptions, DataPoint } from '@/modules/normalization/core/types.js';
import type { NormalizationService } from '@/modules/normalization/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
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

/**
 * MCP Analytics Service interface (matches what queryTimeseries needs)
 */
export interface McpAnalyticsService {
  getAnalyticsSeries(inputs: AnalyticsInput[]): Promise<Result<AnalyticsSeriesResult[], McpError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts year range from data series.
 */
function extractYearRange(series: DataSeries): [number, number] {
  if (series.data.length === 0) {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear];
  }

  let minYear = Number.MAX_SAFE_INTEGER;
  let maxYear = Number.MIN_SAFE_INTEGER;

  for (const point of series.data) {
    const year = extractYearFromLabel(point.date);
    if (year !== null) {
      if (year < minYear) minYear = year;
      if (year > maxYear) maxYear = year;
    }
  }

  // Handle case where no valid years were found
  if (minYear === Number.MAX_SAFE_INTEGER) {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear];
  }

  return [minYear, maxYear];
}

/**
 * Converts DataSeries to normalization DataPoint format.
 */
function toNormalizationDataPoints(series: DataSeries): DataPoint[] {
  return series.data.map((point: TemporalDataPoint) => {
    const normalizable = toNormalizableDataPoint(point);
    return {
      x: normalizable.date,
      year: normalizable.year,
      y: normalizable.value,
    };
  });
}

/**
 * Converts normalization DataPoint array back to DataSeries format.
 */
function fromNormalizationDataPoints(points: DataPoint[], frequency: Frequency): DataSeries {
  return {
    frequency,
    data: points.map((point) => ({
      date: point.x,
      value: point.y,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

class McpAnalyticsServiceImpl implements McpAnalyticsService {
  constructor(
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly normalization: NormalizationService
  ) {}

  async getAnalyticsSeries(
    inputs: AnalyticsInput[]
  ): Promise<Result<AnalyticsSeriesResult[], McpError>> {
    const results: AnalyticsSeriesResult[] = [];

    for (const input of inputs) {
      const seriesId = input.seriesId ?? `series-${String(results.length)}`;

      // Extract filter and normalization options
      const { analyticsFilter, normOptions } = this.parseInput(input.filter);

      // Fetch raw data from analytics repo
      const dataResult = await this.analyticsRepo.getAggregatedSeries(analyticsFilter);
      if (dataResult.isErr()) {
        const error = dataResult.error;
        if (error.type === 'TimeoutError') {
          return err(timeoutError());
        }
        return err(databaseError());
      }

      const rawSeries = dataResult.value;

      // Apply normalization if needed
      const normalizedSeries = await this.applyNormalization(rawSeries, normOptions);

      // Determine axis units
      const xAxisUnit = this.getXAxisUnit(analyticsFilter.report_period.type);
      const yAxisUnit = this.getYAxisUnit(normOptions);

      results.push({
        seriesId,
        xAxis: { name: 'Period', type: 'temporal', unit: xAxisUnit },
        yAxis: { name: 'Amount', type: 'numeric', unit: yAxisUnit },
        data: normalizedSeries.data.map((point: TemporalDataPoint) => ({
          x: point.date,
          y: point.value.toNumber(),
        })),
      });
    }

    return ok(results);
  }

  /**
   * Parses MCP filter format to AnalyticsFilter and TransformationOptions.
   */
  private parseInput(filter: Record<string, unknown>): {
    analyticsFilter: AnalyticsFilter;
    normOptions: TransformationOptions;
  } {
    const reportPeriod = filter['report_period'] as
      | { type: Frequency; selection: PeriodSelection }
      | undefined;

    // Build analytics filter (database query filter)
    const accountCategory = filter['account_category'] as 'ch' | 'vn' | undefined;
    const reportType = filter['report_type'] as string | undefined;

    const analyticsFilter: AnalyticsFilter = {
      account_category: accountCategory ?? 'ch',
      report_type: reportType ?? 'Executie bugetara agregata la nivel de ordonator principal',
      report_period: {
        type: reportPeriod?.type ?? Frequency.YEAR,
        selection: reportPeriod?.selection ?? { interval: { start: '2020', end: '2024' } },
      },
    };

    // Map optional filter fields
    this.mapOptionalFilters(filter, analyticsFilter);

    // Build normalization options
    const normModeRaw = filter['normalization'] as NormalizationMode | undefined;
    const normMode: NormalizationMode = normModeRaw ?? 'total';
    const currencyRaw = filter['currency'] as string | undefined;
    const currency: Currency =
      currencyRaw === 'EUR' ? 'EUR' : currencyRaw === 'USD' ? 'USD' : 'RON';
    const inflationAdjustedRaw = filter['inflation_adjusted'] as boolean | undefined;
    const inflationAdjusted = inflationAdjustedRaw ?? false;

    const normOptions: TransformationOptions = {
      normalization: normMode,
      currency,
      inflationAdjusted,
      showPeriodGrowth: false,
    };

    return { analyticsFilter, normOptions };
  }

  /**
   * Maps optional filter fields from MCP format to AnalyticsFilter.
   */
  private mapOptionalFilters(
    filter: Record<string, unknown>,
    analyticsFilter: AnalyticsFilter
  ): void {
    if (filter['entity_cuis'] !== undefined) {
      analyticsFilter.entity_cuis = filter['entity_cuis'] as string[];
    }
    if (filter['uat_ids'] !== undefined) {
      // Convert number[] to string[] for the filter
      const uatIds = filter['uat_ids'] as number[];
      analyticsFilter.uat_ids = uatIds.map(String);
    }
    if (filter['county_codes'] !== undefined) {
      analyticsFilter.county_codes = filter['county_codes'] as string[];
    }
    if (filter['regions'] !== undefined) {
      analyticsFilter.regions = filter['regions'] as string[];
    }
    if (filter['is_uat'] !== undefined) {
      analyticsFilter.is_uat = filter['is_uat'] as boolean;
    }
    if (filter['min_population'] !== undefined) {
      analyticsFilter.min_population = filter['min_population'] as number;
    }
    if (filter['max_population'] !== undefined) {
      analyticsFilter.max_population = filter['max_population'] as number;
    }
    if (filter['functional_codes'] !== undefined) {
      analyticsFilter.functional_codes = filter['functional_codes'] as string[];
    }
    if (filter['functional_prefixes'] !== undefined) {
      analyticsFilter.functional_prefixes = filter['functional_prefixes'] as string[];
    }
    if (filter['economic_codes'] !== undefined) {
      analyticsFilter.economic_codes = filter['economic_codes'] as string[];
    }
    if (filter['economic_prefixes'] !== undefined) {
      analyticsFilter.economic_prefixes = filter['economic_prefixes'] as string[];
    }
    if (filter['funding_source_ids'] !== undefined) {
      const ids = filter['funding_source_ids'] as number[];
      analyticsFilter.funding_source_ids = ids.map(String);
    }
    if (filter['budget_sector_ids'] !== undefined) {
      const ids = filter['budget_sector_ids'] as number[];
      analyticsFilter.budget_sector_ids = ids.map(String);
    }
    if (filter['expense_types'] !== undefined) {
      analyticsFilter.expense_types = filter['expense_types'] as ExpenseType[];
    }
    if (filter['program_codes'] !== undefined) {
      analyticsFilter.program_codes = filter['program_codes'] as string[];
    }
  }

  /**
   * Applies normalization to the raw data series.
   */
  private async applyNormalization(
    series: DataSeries,
    options: TransformationOptions
  ): Promise<DataSeries> {
    // If no normalization needed, return raw data
    if (
      options.normalization === 'total' &&
      !options.inflationAdjusted &&
      options.currency === 'RON'
    ) {
      return series;
    }

    // Convert to normalization format
    const dataPoints = toNormalizationDataPoints(series);
    const yearRange = extractYearRange(series);

    // Apply normalization
    const normalizedResult = await this.normalization.normalize(
      dataPoints,
      options,
      series.frequency,
      yearRange
    );

    if (normalizedResult.isErr()) {
      // If normalization fails, return raw data
      return series;
    }

    return fromNormalizationDataPoints(normalizedResult.value, series.frequency);
  }

  /**
   * Gets X axis unit based on frequency.
   */
  private getXAxisUnit(frequency: Frequency): string {
    switch (frequency) {
      case Frequency.YEAR:
        return 'year';
      case Frequency.QUARTER:
        return 'quarter';
      case Frequency.MONTH:
        return 'month';
      default:
        return 'period';
    }
  }

  /**
   * Gets Y axis unit based on normalization options.
   */
  private getYAxisUnit(options: TransformationOptions): string {
    const currencySymbol = options.currency;

    if (options.normalization === 'per_capita') {
      return `${currencySymbol}/capita`;
    }
    if (options.normalization === 'percent_gdp') {
      return '% of GDP';
    }
    return currencySymbol;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an MCP analytics service.
 */
export const makeMcpAnalyticsService = (
  analyticsRepo: AnalyticsRepository,
  normalization: NormalizationService
): McpAnalyticsService => {
  return new McpAnalyticsServiceImpl(analyticsRepo, normalization);
};
