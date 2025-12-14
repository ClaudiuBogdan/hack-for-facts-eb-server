import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import {
  getDenominatorPopulation,
  computeCpiAdjustmentFactorMap,
  type PopulationRepository,
} from '@/modules/normalization/index.js';

import { getPreviousPeriodLabel } from '../period-labels.js';
import {
  Frequency,
  type AnalyticsSeries,
  type AnalyticsInput,
  type ProcessingContext,
  type IntermediatePoint,
  type NormalizationOptions,
  type Axis,
  type AnalyticsFilter,
  type Currency,
  type NormalizationMode,
} from '../types.js';

import type { DatasetRepo, Dataset, DataPoint } from '../../../datasets/index.js';
import type { AnalyticsError } from '../errors.js';
import type { AnalyticsRepository } from '../ports.js';
import type { DataSeries } from '@/common/types/temporal.js';

export interface GetAnalyticsSeriesDeps {
  analyticsRepo: AnalyticsRepository;
  datasetRepo: DatasetRepo;
  populationRepo: PopulationRepository;
}

/**
 * Helper to get a value from a dataset for a specific year.
 *
 * Implements carry-forward logic: if the exact year is not found,
 * returns the value from the most recent available year before the requested year.
 * This handles the case where datasets (e.g., exchange rates) only have data
 * through a certain year but the user queries for future years.
 *
 * @param dataset - The dataset to search
 * @param year - The year to look up
 * @returns The value for that year, or carry-forward value, or null if no data before the year
 */
const getDatasetValue = (dataset: Dataset, year: number): Decimal | null => {
  const yearStr = year.toString();

  // First try exact match
  const exactPoint = dataset.points.find((p: DataPoint) => p.x === yearStr);
  if (exactPoint !== undefined) {
    return exactPoint.y;
  }

  // Carry-forward: find the most recent year that has data before the requested year
  // Dataset points are typically sorted, but we'll be safe and find the max
  let bestYear: number | null = null;
  let bestValue: Decimal | null = null;

  for (const point of dataset.points) {
    const pointYear = Number.parseInt(point.x, 10);
    if (!Number.isNaN(pointYear) && pointYear < year) {
      if (bestYear === null || pointYear > bestYear) {
        bestYear = pointYear;
        bestValue = point.y;
      }
    }
  }

  return bestValue;
};

/**
 * Normalization service for transforming time series data.
 * Internal helper class for getAnalyticsSeries.
 */
class NormalizationService {
  transform(series: DataSeries, ctx: ProcessingContext): IntermediatePoint[] {
    // 1. Map DataSeries to Intermediate format
    let data: IntermediatePoint[] = series.data.map((point) => {
      // Extract year from ISO date string (YYYY-MM-DD)
      const year = Number.parseInt(point.date.substring(0, 4), 10);
      return {
        x: point.date, // Keep ISO date as x label
        year,
        y: point.value.toNumber(), // Convert Decimal to number for processing
      };
    });

    // 2. Apply Branch Logic
    if (ctx.filter.normalization === 'percent_gdp') {
      // Path B: Strict Nominal/Nominal
      data = this.applyPercentGDP(data, ctx.datasets.gdp);
    } else {
      // Path A: Standard
      if (ctx.filter.inflation_adjusted && ctx.datasets.cpi !== undefined) {
        data = this.applyInflation(data, ctx.datasets.cpi);
      }

      if (
        ctx.filter.currency !== undefined &&
        ctx.filter.currency !== 'RON' &&
        ctx.datasets.exchange !== undefined
      ) {
        data = this.applyCurrency(data, ctx.datasets.exchange);
      }

      if (ctx.filter.normalization === 'per_capita') {
        data = this.applyPerCapita(data, ctx.filterPopulation);
      }
    }

    // 3. Apply Growth (Optional)
    if (ctx.filter.show_period_growth) {
      data = this.applyGrowth(data, ctx.frequency);
    }

    return data;
  }

  private applyPercentGDP(data: IntermediatePoint[], gdpData?: Dataset): IntermediatePoint[] {
    if (gdpData === undefined) return data;
    return data.map((p) => {
      const gdp = getDatasetValue(gdpData, p.year);
      if (gdp === null || gdp.isZero()) return { ...p, y: 0 };
      // GDP dataset is stored in RON. Input is RON.
      // Formula: (y / gdp) * 100
      const gdpVal = gdp.toNumber();
      return { ...p, y: (p.y / gdpVal) * 100 };
    });
  }

  private applyInflation(data: IntermediatePoint[], cpiData: Dataset): IntermediatePoint[] {
    const cpiIndex = new Map(cpiData.points.map((p) => [p.x, p.y]));
    const factorMap = computeCpiAdjustmentFactorMap(cpiIndex, 2024);

    const factorYears = [...factorMap.keys()]
      .map((k) => Number.parseInt(k, 10))
      .filter((y) => !Number.isNaN(y))
      .sort((a, b) => a - b);

    const lastFactorYear = factorYears.at(-1) ?? null;

    return data.map((p) => {
      const direct = factorMap.get(p.year.toString());
      if (direct !== undefined) {
        return { ...p, y: p.y * direct.toNumber() };
      }

      // Carry-forward for years beyond the dataset horizon.
      if (lastFactorYear !== null && p.year > lastFactorYear) {
        const fallback = factorMap.get(lastFactorYear.toString());
        if (fallback !== undefined) {
          return { ...p, y: p.y * fallback.toNumber() };
        }
      }

      return p;
    });
  }

  private applyCurrency(data: IntermediatePoint[], exchangeData: Dataset): IntermediatePoint[] {
    // Assuming exchangeData is RON/EUR or RON/USD
    return data.map((p) => {
      const rateDec = getDatasetValue(exchangeData, p.year);
      if (rateDec === null || rateDec.isZero()) return p;
      const rate = rateDec.toNumber();
      return { ...p, y: p.y / rate };
    });
  }

  private applyPerCapita(
    data: IntermediatePoint[],
    filterPopulation?: Decimal
  ): IntermediatePoint[] {
    // Population is constant per query (filter-based from database)
    // No year-specific fallback - if no population, skip normalization
    if (filterPopulation === undefined || filterPopulation.isZero()) {
      return data;
    }

    const popValue = filterPopulation.toNumber();
    return data.map((p) => ({ ...p, y: p.y / popValue }));
  }

  private applyGrowth(data: IntermediatePoint[], frequency: Frequency): IntermediatePoint[] {
    const lookup = new Map(data.map((p) => [p.x, p.y]));

    return data.map((curr) => {
      // Use common module for label logic
      const prevKey = getPreviousPeriodLabel(curr.x, frequency);
      if (prevKey === null) return { ...curr, y: 0 };

      const prevValue = lookup.get(prevKey);

      if (prevValue === undefined || prevValue === 0) {
        return { ...curr, y: 0 };
      }

      const growth = ((curr.y - prevValue) / prevValue) * 100;
      return { ...curr, y: growth };
    });
  }
}

function getResultAxis(filter: NormalizationOptions): Axis {
  // Priority 1: Growth
  if (filter.show_period_growth) {
    return { name: 'Growth', type: 'FLOAT', unit: '%' };
  }

  // Priority 2: Normalization Mode
  if (filter.normalization === 'percent_gdp') {
    return { name: 'Share of GDP', type: 'FLOAT', unit: '% of GDP' };
  }

  // Priority 3: Currency & Inflation
  const currency = filter.currency ?? 'RON';
  const realSuffix = filter.inflation_adjusted ? ' (real 2024)' : '';
  const capitaSuffix = filter.normalization === 'per_capita' ? '/capita' : '';

  return {
    name: 'Amount',
    type: 'FLOAT',
    unit: `${currency}${capitaSuffix}${realSuffix}`,
  };
}

/**
 * Get xAxis metadata based on period frequency type.
 * Maps to the format expected by the production API.
 */
function getXAxisMetadata(periodType: string): Axis {
  switch (periodType.toUpperCase()) {
    case 'YEAR':
      return { name: 'Year', type: 'INTEGER', unit: 'year' };
    case 'QUARTER':
      return { name: 'Quarter', type: 'STRING', unit: 'quarter' };
    case 'MONTH':
      return { name: 'Month', type: 'STRING', unit: 'month' };
    default:
      return { name: 'Time', type: 'STRING', unit: periodType.toLowerCase() };
  }
}

/**
 * Fetches and normalizes analytics series based on input filters.
 *
 * Each input generates one AnalyticsSeries in the output.
 * Normalization is applied per data point to ensure correct
 * inflation and currency adjustments across years.
 */
export async function getAnalyticsSeries(
  deps: GetAnalyticsSeriesDeps,
  inputs: AnalyticsInput[]
): Promise<Result<AnalyticsSeries[], AnalyticsError>> {
  const { analyticsRepo, datasetRepo } = deps;
  const normalizationService = new NormalizationService();
  const results: AnalyticsSeries[] = [];

  for (const input of inputs) {
    const { seriesId } = input;

    // Explicit mapping of legacy input types to strict domain types
    let strictNormalization: NormalizationMode;
    let strictCurrency: Currency | undefined = input.filter.currency;

    if (input.filter.normalization === 'total_euro') {
      strictNormalization = 'total';
      strictCurrency = 'EUR';
    } else if (input.filter.normalization === 'per_capita_euro') {
      strictNormalization = 'per_capita';
      strictCurrency = 'EUR';
    } else {
      strictNormalization = input.filter.normalization;
    }

    // Create a clean strict filter object
    const strictFilter: AnalyticsFilter & NormalizationOptions = {
      ...input.filter,
      normalization: strictNormalization,
      ...(strictCurrency !== undefined && { currency: strictCurrency }),
      inflation_adjusted: input.filter.inflation_adjusted,
      show_period_growth: input.filter.show_period_growth,
    };

    // 1. Fetch Raw Data (Nominal RON) - returns DataSeries
    // Note: The repo expects AnalyticsFilter, which is satisfied by strictFilter
    const seriesResult = await analyticsRepo.getAggregatedSeries(strictFilter);
    if (seriesResult.isErr()) return err(seriesResult.error);
    const rawSeries = seriesResult.value;

    // 2. Prepare Context (Datasets)
    const ctx: ProcessingContext = {
      filter: strictFilter,
      frequency: strictFilter.report_period.type,
      datasets: {},
    };

    if (strictFilter.normalization === 'percent_gdp') {
      const res = await datasetRepo.getById('ro.economics.gdp.yearly');
      if (res.isOk()) ctx.datasets.gdp = res.value;
    } else {
      if (strictFilter.inflation_adjusted) {
        const res = await datasetRepo.getById('ro.economics.cpi.yearly');
        if (res.isOk()) ctx.datasets.cpi = res.value;
      }
      if (strictFilter.currency === 'EUR') {
        const res = await datasetRepo.getById('ro.economics.exchange.ron_eur.yearly');
        if (res.isOk()) ctx.datasets.exchange = res.value;
      }
      if (strictFilter.currency === 'USD') {
        const res = await datasetRepo.getById('ro.economics.exchange.ron_usd.yearly');
        if (res.isOk()) ctx.datasets.exchange = res.value;
      }

      if (strictFilter.normalization === 'per_capita') {
        // Population comes from database via PopulationRepository, not from datasets.
        // It's filter-dependent (constant per query), not year-specific.
        // - No entity filters → country population
        // - With entity_cuis/uat_ids/county_codes → filtered entity population
        const popResult = await getDenominatorPopulation(strictFilter, deps.populationRepo);
        if (popResult !== undefined) {
          ctx.filterPopulation = popResult;
        }
      }
    }

    // 3. Transform (apply normalization)
    const processedPoints = normalizationService.transform(rawSeries, ctx);

    // Sort by X (ISO date string)
    processedPoints.sort((a, b) => a.x.localeCompare(b.x));

    const finalAxis = getResultAxis(strictFilter);

    // 4. Convert to AnalyticsSeries for GraphQL
    // Map period type to xAxis metadata (matching prod API format)
    const periodType = strictFilter.report_period.type;
    const xAxisMeta = getXAxisMetadata(periodType);

    results.push({
      seriesId: seriesId ?? 'default',
      xAxis: xAxisMeta,
      yAxis: finalAxis,
      data: processedPoints.map((p) => ({ x: p.x, y: p.y })),
    });
  }

  return ok(results);
}
