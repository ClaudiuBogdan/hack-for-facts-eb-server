/**
 * Get Heatmap Data Use Case
 *
 * Orchestrates fetching UAT heatmap data with optional normalization.
 * Applies transformations in the correct order:
 * 1. Inflation adjustment (if enabled)
 * 2. Currency conversion (if EUR)
 * 3. Aggregate by UAT
 * 4. Per-capita division using UAT population (if enabled)
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import {
  createMissingRequiredFilterError,
  createNormalizationError,
  type UATAnalyticsError,
} from '../errors.js';

import type { UATAnalyticsRepository } from '../ports.js';
import type {
  HeatmapUATDataPoint,
  NormalizedHeatmapDataPoint,
  HeatmapTransformationOptions,
} from '../types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { NormalizationService, NormalizationFactors } from '@/modules/normalization/index.js';

/**
 * Dependencies for the get-heatmap-data use case.
 */
export interface GetHeatmapDataDeps {
  repo: UATAnalyticsRepository;
  normalizationService: NormalizationService;
}

/**
 * Input options for fetching heatmap data.
 */
export interface GetHeatmapDataInput {
  filter: AnalyticsFilter;
  options?: HeatmapTransformationOptions;
}

/**
 * Default transformation options.
 */
const DEFAULT_OPTIONS: HeatmapTransformationOptions = {
  inflationAdjusted: false,
  currency: 'RON',
  perCapita: false,
};

/**
 * Aggregated UAT data for normalization processing.
 */
interface AggregatedUATData {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  siruta_code: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;
  total_amount: Decimal;
}

/**
 * Validates that required filter fields are present.
 *
 * Note: account_category and report_period are already required by AnalyticsFilter type.
 * We only validate report_type which is optional in the base type but required for heatmap.
 */
function validateFilter(filter: AnalyticsFilter): Result<void, UATAnalyticsError> {
  // report_type is optional in AnalyticsFilter but required for heatmap queries
  if (filter.report_type === undefined) {
    return err(createMissingRequiredFilterError('report_type'));
  }

  return ok(undefined);
}

/**
 * Normalizes and aggregates data points by UAT.
 *
 * Applies transformations in the correct order:
 * 1. Inflation adjustment (if enabled) - multiply by CPI factor
 * 2. Currency conversion (if EUR) - divide by EUR rate
 * 3. Aggregate by UAT - sum all normalized amounts per UAT
 */
function normalizeAndAggregate(
  dataPoints: HeatmapUATDataPoint[],
  options: HeatmapTransformationOptions,
  factors: NormalizationFactors
): AggregatedUATData[] {
  const uatMap = new Map<number, AggregatedUATData>();

  for (const point of dataPoints) {
    const periodLabel = String(point.year);
    let amount = point.total_amount;

    // Step 1: Apply inflation adjustment (if enabled)
    if (options.inflationAdjusted) {
      const cpi = factors.cpi.get(periodLabel);
      if (cpi !== undefined && !cpi.isZero()) {
        amount = amount.mul(cpi);
      }
    }

    // Step 2: Apply currency conversion (if EUR)
    if (options.currency === 'EUR') {
      const rate = factors.eur.get(periodLabel);
      if (rate !== undefined && !rate.isZero()) {
        amount = amount.div(rate);
      }
    }

    // Step 3: Aggregate by UAT
    const existing = uatMap.get(point.uat_id);
    if (existing !== undefined) {
      existing.total_amount = existing.total_amount.plus(amount);
    } else {
      uatMap.set(point.uat_id, {
        uat_id: point.uat_id,
        uat_code: point.uat_code,
        uat_name: point.uat_name,
        siruta_code: point.siruta_code,
        county_code: point.county_code,
        county_name: point.county_name,
        region: point.region,
        population: point.population,
        total_amount: amount,
      });
    }
  }

  return Array.from(uatMap.values());
}

/**
 * Converts aggregated data to normalized output format.
 *
 * Step 4: Apply per-capita division using UAT's individual population.
 * Uses Decimal for division to maintain precision.
 */
function toNormalizedOutput(
  aggregatedData: AggregatedUATData[],
  perCapita: boolean
): NormalizedHeatmapDataPoint[] {
  return aggregatedData.map((item) => {
    const totalAmount = item.total_amount;
    const population = item.population ?? 0;

    // Use Decimal for per-capita division to maintain precision
    const perCapitaAmount = population > 0 ? totalAmount.div(population) : new Decimal(0);

    // Primary amount based on mode
    const amount = perCapita ? perCapitaAmount : totalAmount;

    return {
      uat_id: item.uat_id,
      uat_code: item.uat_code,
      uat_name: item.uat_name,
      siruta_code: item.siruta_code,
      county_code: item.county_code,
      county_name: item.county_name,
      region: item.region,
      population: item.population,
      amount: amount.toNumber(),
      total_amount: totalAmount.toNumber(),
      per_capita_amount: perCapitaAmount.toNumber(),
    };
  });
}

/**
 * Fetches and normalizes UAT heatmap data.
 *
 * @param deps - Repository and normalization service
 * @param input - Filter and transformation options
 * @returns Normalized heatmap data points
 */
export async function getHeatmapData(
  deps: GetHeatmapDataDeps,
  input: GetHeatmapDataInput
): Promise<Result<NormalizedHeatmapDataPoint[], UATAnalyticsError>> {
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

  // Apply transformations in correct order: inflation → currency → aggregate
  const aggregatedData = normalizeAndAggregate(dataPoints, options, factors);

  // Apply per-capita (using UAT population) and convert to output format
  const normalizedData = toNormalizedOutput(aggregatedData, options.perCapita);

  return ok(normalizedData);
}
