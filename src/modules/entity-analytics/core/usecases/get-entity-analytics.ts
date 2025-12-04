import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import { createNormalizationDataError, type EntityAnalyticsError } from '../errors.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_SORT,
  MAX_LIMIT,
  type AggregateFilters,
  type EntityAnalyticsInput,
  type EntityAnalyticsConnection,
  type EntityAnalyticsDataPoint,
  type EntityAnalyticsSort,
  type NormalizationOptions,
  type PeriodFactorMap,
} from '../types.js';

import type { EntityAnalyticsRepository } from '../ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { NormalizationFactors, TransformationOptions } from '@/modules/normalization/index.js';

// -----------------------------------------
// Dependencies
// -----------------------------------------

/**
 * Simplified normalization port for this use case.
 * We only need factor generation, not the full normalize() method,
 * since population is computed per-entity in SQL.
 */
export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetEntityAnalyticsDeps {
  repo: EntityAnalyticsRepository;
  normalization: NormalizationFactorProvider;
}

// -----------------------------------------
// Use Case Implementation
// -----------------------------------------

/**
 * Fetches entity-level analytics with proper normalization.
 *
 * This use case aggregates ExecutionLineItems by entity_cui to provide
 * entity-level budget analytics with ranking and comparison capabilities.
 *
 * Key Differences from getAggregatedLineItems:
 * 1. Groups by entity_cui (not classification codes)
 * 2. Population is entity-specific (computed per row in SQL), not filter-based
 * 3. Supports 8 sortable fields (not just amount DESC)
 * 4. Does NOT need PopulationRepository (population handled in SQL)
 *
 * The factor map passed to SQL does NOT include population because:
 * - Population varies by entity type (UAT vs county council vs other)
 * - Population is computed per-entity in the SQL query based on entity type
 */
export async function getEntityAnalytics(
  deps: GetEntityAnalyticsDeps,
  input: EntityAnalyticsInput
): Promise<Result<EntityAnalyticsConnection, EntityAnalyticsError>> {
  const { repo, normalization } = deps;
  const { filter, sort: inputSort, limit: rawLimit, offset: rawOffset } = input;

  // 1. Sanitize pagination params
  const limit = Math.min(Math.max(rawLimit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
  const offset = Math.max(rawOffset ?? 0, 0);

  // 2. Use default sort if not provided
  const sort: EntityAnalyticsSort = inputSort ?? DEFAULT_SORT;

  // 3. Extract year range from filter
  const { startYear, endYear } = extractYearRange(filter);

  // 4. Generate normalization factors
  let factors: NormalizationFactors;
  try {
    factors = await normalization.generateFactors(
      filter.report_period.frequency,
      startYear,
      endYear
    );
  } catch (error) {
    return err(
      createNormalizationDataError(
        `Failed to generate normalization factors: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  // 5. Compute combined factor map WITHOUT population
  // Population is entity-specific and computed in SQL based on entity type
  const transformOptions = buildTransformOptions(filter);
  const periodLabels = generatePeriodLabels(startYear, endYear);
  const factorMap = computeCombinedFactorMapWithoutPopulation(
    transformOptions,
    factors,
    periodLabels
  );

  // 6. Build aggregate filters (only include defined values)
  const aggregateFilters = buildAggregateFilters(filter);

  // 7. Call repository
  const result = await repo.getEntityAnalytics(
    filter,
    factorMap,
    { limit, offset },
    sort,
    Object.keys(aggregateFilters).length > 0 ? aggregateFilters : undefined
  );

  if (result.isErr()) return err(result.error);

  const { items, totalCount } = result.value;

  // 8. Convert to output format
  const nodes: EntityAnalyticsDataPoint[] = items.map((row) => ({
    entity_cui: row.entity_cui,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
    uat_id: row.uat_id !== null ? String(row.uat_id) : null,
    county_code: row.county_code,
    county_name: row.county_name,
    population: row.population,
    amount: row.total_amount.toNumber(), // Display amount = total_amount for now
    total_amount: row.total_amount.toNumber(),
    per_capita_amount: row.per_capita_amount.toNumber(),
  }));

  return ok({
    nodes,
    pageInfo: {
      totalCount,
      hasNextPage: offset + limit < totalCount,
      hasPreviousPage: offset > 0,
    },
  });
}

// -----------------------------------------
// Helper Functions
// -----------------------------------------

/**
 * Builds TransformationOptions from NormalizationOptions.
 * Maps snake_case GraphQL fields to camelCase internal fields.
 */
function buildTransformOptions(filter: NormalizationOptions): TransformationOptions {
  return {
    inflationAdjusted: filter.inflation_adjusted,
    currency: filter.currency ?? 'RON',
    normalization: filter.normalization,
    showPeriodGrowth: filter.show_period_growth,
  };
}

/**
 * Builds AggregateFilters from filter options.
 * Only includes properties that have defined values to satisfy exactOptionalPropertyTypes.
 */
function buildAggregateFilters(
  filter: NormalizationOptions & {
    aggregate_min_amount?: number | null;
    aggregate_max_amount?: number | null;
  }
): AggregateFilters {
  const result: AggregateFilters = {};

  if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
    result.minAmount = new Decimal(filter.aggregate_min_amount);
  }

  if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
    result.maxAmount = new Decimal(filter.aggregate_max_amount);
  }

  return result;
}

// -----------------------------------------
// SQL Normalization Helpers
// -----------------------------------------

/**
 * Computes a combined normalization multiplier for each period WITHOUT population.
 *
 * IMPORTANT: This differs from the aggregatedLineItems version!
 *
 * For entity-analytics, population is NOT included in the factor map because:
 * - Population varies by entity type (UAT, county council, or other)
 * - Population is computed per-entity in the SQL query based on entity type
 * - Per-capita division happens in SQL: normalized_amount / population
 *
 * Only CPI, currency, and GDP normalization are pre-computed here.
 *
 * @param options - Transformation options (inflation, currency, normalization mode)
 * @param factors - Year-specific factors from NormalizationService
 * @param periodLabels - Period keys (e.g., ["2020", "2021", "2022"])
 * @returns Map of period keys to combined multipliers (without population)
 */
export function computeCombinedFactorMapWithoutPopulation(
  options: TransformationOptions,
  factors: NormalizationFactors,
  periodLabels: string[]
): PeriodFactorMap {
  const result = new Map<string, Decimal>();

  for (const label of periodLabels) {
    let multiplier: Decimal;

    if (options.normalization === 'percent_gdp') {
      // Path B: Percent GDP (exclusive, ignores inflation/currency)
      const gdp = factors.gdp.get(label);
      if (gdp === undefined || gdp.isZero()) {
        multiplier = new Decimal(0);
      } else {
        // GDP is in millions, result is percentage (0-100)
        multiplier = new Decimal(100).div(gdp.mul(1_000_000));
      }
    } else {
      // Path A: Standard normalization (composable)
      multiplier = new Decimal(1);

      // 1. Inflation adjustment (per-year factor)
      if (options.inflationAdjusted) {
        const cpi = factors.cpi.get(label);
        if (cpi !== undefined && !cpi.isZero()) {
          multiplier = multiplier.mul(cpi);
        }
      }

      // 2. Currency conversion (per-year factor)
      if (options.currency === 'EUR') {
        const rate = factors.eur.get(label);
        if (rate !== undefined && !rate.isZero()) {
          multiplier = multiplier.div(rate);
        }
      } else if (options.currency === 'USD') {
        const rate = factors.usd.get(label);
        if (rate !== undefined && !rate.isZero()) {
          multiplier = multiplier.div(rate);
        }
      }

      // NOTE: per_capita is NOT applied here!
      // For entity-analytics, population is computed per-entity in SQL
      // based on entity type (UAT, county council, or other)
    }

    result.set(label, multiplier);
  }

  return result;
}

/**
 * Generates period labels for factor lookup.
 *
 * For yearly frequency, generates labels like ["2020", "2021", "2022"].
 *
 * @param startYear - First year in range
 * @param endYear - Last year in range (inclusive)
 * @returns Array of period label strings
 */
export function generatePeriodLabels(startYear: number, endYear: number): string[] {
  const labels: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    labels.push(String(year));
  }
  return labels;
}

/**
 * Extracts year range from analytics filter.
 *
 * @param filter - Analytics filter with report period
 * @returns Object with startYear and endYear
 */
export function extractYearRange(filter: AnalyticsFilter): { startYear: number; endYear: number } {
  const { selection } = filter.report_period;
  const currentYear = new Date().getFullYear();

  let startYear = currentYear;
  let endYear = currentYear;

  const yearPattern = /^(\d{4})/;

  if (selection.interval !== undefined) {
    const startMatch = yearPattern.exec(selection.interval.start);
    const endMatch = yearPattern.exec(selection.interval.end);

    const startYearStr = startMatch?.[1];
    const endYearStr = endMatch?.[1];

    if (startYearStr !== undefined) {
      startYear = Number.parseInt(startYearStr, 10);
    }
    if (endYearStr !== undefined) {
      endYear = Number.parseInt(endYearStr, 10);
    }
  } else if ('dates' in selection) {
    const dates = selection.dates;
    if (dates.length > 0) {
      const years = dates
        .map((d) => {
          const match = yearPattern.exec(d);
          const yearStr = match?.[1];
          return yearStr === undefined ? null : Number.parseInt(yearStr, 10);
        })
        .filter((y): y is number => y !== null);

      if (years.length > 0) {
        startYear = Math.min(...years);
        endYear = Math.max(...years);
      }
    }
  }

  return { startYear, endYear };
}
