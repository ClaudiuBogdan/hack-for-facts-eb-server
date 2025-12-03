import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { getPreviousPeriodLabel } from '@/common/period-labels/index.js';

import type { DatasetRepo, Dataset, DataPoint } from '../../../datasets/index.js';
import type { AnalyticsError } from '../errors.js';
import type { AnalyticsRepository } from '../ports.js';
import type {
  AnalyticsSeries,
  AnalyticsInput,
  ProcessingContext,
  IntermediatePoint,
  NormalizationOptions,
  Axis,
  AnalyticsFilter,
  Currency,
  NormalizationMode,
  PeriodType,
} from '../types.js';
import type { DataSeries } from '@/common/types/temporal.js';

export interface GetAnalyticsSeriesDeps {
  analyticsRepo: AnalyticsRepository;
  datasetRepo: DatasetRepo;
}

// Helper to get a value from a dataset for a specific year
const getDatasetValue = (dataset: Dataset, year: number): Decimal | null => {
  const point = dataset.points.find((p: DataPoint) => p.x === year.toString());
  return point !== undefined ? point.y : null;
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
      const year = parseInt(point.date.substring(0, 4), 10);
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

      if (ctx.filter.normalization === 'per_capita' && ctx.datasets.population !== undefined) {
        data = this.applyPerCapita(data, ctx.datasets.population);
      }
    }

    // 3. Apply Growth (Optional)
    if (ctx.filter.show_period_growth) {
      data = this.applyGrowth(data, ctx.granularity);
    }

    return data;
  }

  private applyPercentGDP(data: IntermediatePoint[], gdpData?: Dataset): IntermediatePoint[] {
    if (gdpData === undefined) return data;
    return data.map((p) => {
      const gdp = getDatasetValue(gdpData, p.year);
      if (gdp === null || gdp.isZero()) return { ...p, y: 0 };
      // GDP unit is million_ron. Input is RON.
      // Formula: (y / (gdp * 1,000,000)) * 100
      const gdpVal = gdp.toNumber() * 1000000;
      return { ...p, y: (p.y / gdpVal) * 100 };
    });
  }

  private applyInflation(data: IntermediatePoint[], cpiData: Dataset): IntermediatePoint[] {
    const cpiRefDec = getDatasetValue(cpiData, 2024) ?? new Decimal(100);
    const cpiRef = cpiRefDec.toNumber();

    return data.map((p) => {
      const cpiYearDec = getDatasetValue(cpiData, p.year);
      if (cpiYearDec === null || cpiYearDec.isZero()) return p;
      const cpiYear = cpiYearDec.toNumber();
      // Real = Nominal * (CPI_Ref / CPI_Year)
      return { ...p, y: p.y * (cpiRef / cpiYear) };
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

  private applyPerCapita(data: IntermediatePoint[], populationData: Dataset): IntermediatePoint[] {
    return data.map((p) => {
      const popDec = getDatasetValue(populationData, p.year);
      if (popDec === null || popDec.isZero()) return p;
      const pop = popDec.toNumber();
      return { ...p, y: p.y / pop };
    });
  }

  private applyGrowth(data: IntermediatePoint[], granularity: PeriodType): IntermediatePoint[] {
    const lookup = new Map(data.map((p) => [p.x, p.y]));

    return data.map((curr) => {
      // Use common module for label logic
      const prevKey = getPreviousPeriodLabel(curr.x, granularity);
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
    let strictNormalization: NormalizationMode = 'total';
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
      granularity: strictFilter.report_period.type,
      datasets: {},
    };

    if (strictFilter.normalization === 'percent_gdp') {
      const res = await datasetRepo.getById('ro.economics.gdp.annual');
      if (res.isOk()) ctx.datasets.gdp = res.value;
    } else {
      if (strictFilter.inflation_adjusted) {
        const res = await datasetRepo.getById('ro.economics.cpi.annual');
        if (res.isOk()) ctx.datasets.cpi = res.value;
      }
      if (strictFilter.currency === 'EUR') {
        const res = await datasetRepo.getById('ro.economics.exchange.ron_eur.annual');
        if (res.isOk()) ctx.datasets.exchange = res.value;
      }
      // TODO: Add USD support

      if (strictFilter.normalization === 'per_capita') {
        const res = await datasetRepo.getById('ro.demographics.population.annual');
        if (res.isOk()) ctx.datasets.population = res.value;
      }
    }

    // 3. Transform (apply normalization)
    const processedPoints = normalizationService.transform(rawSeries, ctx);

    // Sort by X (ISO date string)
    processedPoints.sort((a, b) => a.x.localeCompare(b.x));

    const finalAxis = getResultAxis(strictFilter);

    // 4. Convert to AnalyticsSeries for GraphQL
    results.push({
      seriesId: seriesId ?? 'default',
      xAxis: {
        name: 'Time',
        type: 'DATE',
        unit: strictFilter.report_period.type.toLowerCase(),
      },
      yAxis: finalAxis,
      data: processedPoints.map((p) => ({ x: p.x, y: p.y })),
    });
  }

  return ok(results);
}
