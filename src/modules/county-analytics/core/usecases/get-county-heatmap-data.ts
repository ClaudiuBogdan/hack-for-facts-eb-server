/**
 * Get County Heatmap Data Use Case
 *
 * Orchestrates fetching county heatmap data with optional normalization.
 * Applies transformations in the correct order:
 * 1. Inflation adjustment (if enabled)
 * 2. Currency conversion (if EUR)
 * 3. Aggregate by county
 * 4. Per-capita division using county population (if enabled)
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import {
  createMissingRequiredFilterError,
  createNormalizationError,
  type CountyAnalyticsError,
} from '../errors.js';

import type { CountyAnalyticsRepository } from '../ports.js';
import type {
  HeatmapCountyDataPoint,
  NormalizedCountyHeatmapDataPoint,
  CountyHeatmapTransformationOptions,
} from '../types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { NormalizationService, NormalizationFactors } from '@/modules/normalization/index.js';

/**
 * Dependencies for the get-county-heatmap-data use case.
 */
export interface GetCountyHeatmapDataDeps {
  repo: CountyAnalyticsRepository;
  normalizationService: NormalizationService;
}

/**
 * Input options for fetching county heatmap data.
 */
export interface GetCountyHeatmapDataInput {
  filter: AnalyticsFilter;
  options?: CountyHeatmapTransformationOptions;
}

/**
 * Default transformation options.
 */
const DEFAULT_OPTIONS: CountyHeatmapTransformationOptions = {
  inflationAdjusted: false,
  currency: 'RON',
  normalization: 'total',
};

/**
 * Aggregated county data for normalization processing.
 */
interface AggregatedCountyData {
  county_code: string;
  county_name: string;
  county_population: number;
  county_entity_cui: string | null;
  total_amount: Decimal;
  gdp_total: Decimal | null;
}

/**
 * Validates that required filter fields are present.
 *
 * Note: account_category and report_period are already required by AnalyticsFilter type.
 * We only validate report_type which is optional in the base type but required for heatmap.
 */
function validateFilter(filter: AnalyticsFilter): Result<void, CountyAnalyticsError> {
  // report_type is optional in AnalyticsFilter but required for heatmap queries
  if (filter.report_type === undefined) {
    return err(createMissingRequiredFilterError('report_type'));
  }

  return ok(undefined);
}

/**
 * Normalizes and aggregates data points by county.
 *
 * Applies transformations in the correct order:
 * 1. Inflation adjustment (if enabled) - multiply by CPI factor
 * 2. Currency conversion (if EUR) - divide by EUR rate
 * 3. Aggregate by county - sum all normalized amounts per county
 */
function normalizeAndAggregate(
  dataPoints: HeatmapCountyDataPoint[],
  options: CountyHeatmapTransformationOptions,
  factors: NormalizationFactors
): AggregatedCountyData[] {
  const countyMap = new Map<string, AggregatedCountyData>();

  for (const point of dataPoints) {
    const periodLabel = String(point.year);
    let amount = point.total_amount;

    if (options.normalization !== 'percent_gdp') {
      // Step 1: Apply inflation adjustment (if enabled)
      if (options.inflationAdjusted) {
        const cpi = factors.cpi.get(periodLabel);
        if (cpi !== undefined && !cpi.isZero()) {
          amount = amount.mul(cpi);
        }
      }

      // Step 2: Apply currency conversion (if EUR or USD)
      if (options.currency === 'EUR') {
        const rate = factors.eur.get(periodLabel);
        if (rate !== undefined && !rate.isZero()) {
          amount = amount.div(rate);
        }
      }

      if (options.currency === 'USD') {
        const rate = factors.usd.get(periodLabel);
        if (rate !== undefined && !rate.isZero()) {
          amount = amount.div(rate);
        }
      }
    }

    const gdp =
      options.normalization === 'percent_gdp'
        ? (factors.gdp.get(periodLabel) ?? new Decimal(0))
        : null;

    // Step 3: Aggregate by county
    const existing = countyMap.get(point.county_code);
    if (existing === undefined) {
      countyMap.set(point.county_code, {
        county_code: point.county_code,
        county_name: point.county_name,
        county_population: point.county_population,
        county_entity_cui: point.county_entity_cui,
        total_amount: amount,
        gdp_total: gdp,
      });
    } else {
      existing.total_amount = existing.total_amount.plus(amount);
      if (existing.gdp_total !== null && gdp !== null) {
        existing.gdp_total = existing.gdp_total.plus(gdp);
      }
    }
  }

  return Array.from(countyMap.values());
}

/**
 * Converts aggregated data to normalized output format.
 *
 * Step 4: Apply per-capita division using county's population.
 * Uses Decimal for division to maintain precision.
 */
function toNormalizedOutput(
  aggregatedData: AggregatedCountyData[],
  normalization: CountyHeatmapTransformationOptions['normalization']
): NormalizedCountyHeatmapDataPoint[] {
  return aggregatedData.map((item) => {
    const totalAmount = item.total_amount;
    const population = item.county_population;

    // Use Decimal for per-capita division to maintain precision
    const perCapitaAmount = population > 0 ? totalAmount.div(population) : new Decimal(0);

    const percentGdpAmount =
      item.gdp_total !== null && !item.gdp_total.isZero()
        ? totalAmount.div(item.gdp_total).mul(100)
        : new Decimal(0);

    // Primary amount based on mode
    let amount: Decimal;
    if (normalization === 'per_capita') {
      amount = perCapitaAmount;
    } else if (normalization === 'percent_gdp') {
      amount = percentGdpAmount;
    } else {
      amount = totalAmount;
    }

    return {
      county_code: item.county_code,
      county_name: item.county_name,
      county_population: item.county_population,
      county_entity_cui: item.county_entity_cui,
      amount: amount.toNumber(),
      total_amount: totalAmount.toNumber(),
      per_capita_amount: perCapitaAmount.toNumber(),
    };
  });
}

/**
 * Fetches and normalizes county heatmap data.
 *
 * @param deps - Repository and normalization service
 * @param input - Filter and transformation options
 * @returns Normalized heatmap data points
 */
export async function getCountyHeatmapData(
  deps: GetCountyHeatmapDataDeps,
  input: GetCountyHeatmapDataInput
): Promise<Result<NormalizedCountyHeatmapDataPoint[], CountyAnalyticsError>> {
  const { repo, normalizationService } = deps;
  const { filter, options = DEFAULT_OPTIONS } = input;

  // Validate required fields
  const validationResult = validateFilter(filter);
  if (validationResult.isErr()) {
    return err(validationResult.error);
  }

  // Fetch raw data from repository
  const repoResult = await repo.getHeatmapData(filter);
  if (repoResult.isErr()) {
    return err(repoResult.error);
  }

  const dataPoints = repoResult.value;

  // If no data, return empty array
  if (dataPoints.length === 0) {
    return ok([]);
  }

  // Extract year range for normalization factors
  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);

  // Generate normalization factors once
  let factors: NormalizationFactors;
  try {
    factors = await normalizationService.generateFactors(Frequency.YEAR, startYear, endYear);
  } catch (error) {
    return err(
      createNormalizationError(
        `Failed to generate normalization factors: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  // Apply transformations in correct order: inflation -> currency -> aggregate
  const aggregatedData = normalizeAndAggregate(dataPoints, options, factors);

  // Apply per-capita (using county population) and convert to output format
  const normalizedData = toNormalizedOutput(aggregatedData, options.normalization);

  return ok(normalizedData);
}
