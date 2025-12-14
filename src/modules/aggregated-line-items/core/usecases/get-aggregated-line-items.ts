import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import {
  Frequency,
  generatePeriodLabels,
  extractYearRangeFromSelection,
} from '@/common/types/temporal.js';
import {
  getDenominatorPopulation,
  type NormalizationFactors,
  type TransformationOptions,
  type PopulationRepository,
} from '@/modules/normalization/index.js';

import { createNormalizationDataError, type AggregatedLineItemsError } from '../errors.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type AggregateFilters,
  type AggregatedLineItemsInput,
  type AggregatedLineItemConnection,
  type AggregatedLineItem,
  type ClassificationPeriodData,
  type AggregatedClassification,
  type NormalizationOptions,
  type PeriodFactorMap,
} from '../types.js';

import type { AggregatedLineItemsRepository } from '../ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';

// -----------------------------------------
// Dependencies
// -----------------------------------------

/**
 * Simplified normalization port for this use case.
 * We only need factor generation, not the full normalize() method,
 * since we apply normalization row-by-row ourselves.
 */
export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetAggregatedLineItemsDeps {
  repo: AggregatedLineItemsRepository;
  normalization: NormalizationFactorProvider;
  populationRepo: PopulationRepository;
}

// -----------------------------------------
// Use Case Implementation
// -----------------------------------------

/**
 * Fetches aggregated line items with proper normalization.
 *
 * This use case supports two execution paths:
 *
 * **SQL-Level Normalization** (when populationRepo is provided):
 * - Pre-computes combined multipliers per period
 * - Passes factors to SQL via VALUES CTE
 * - SQL handles aggregation, sorting, and pagination
 * - Best for large datasets where in-memory pagination is inefficient
 *
 * **In-Memory Normalization** (fallback):
 * - Fetches raw data grouped by (classification, year)
 * - Normalizes each row using year-specific factors
 * - Aggregates by classification (sum across years)
 * - Applies filters, sorting, and pagination in memory
 *
 * This ensures correct handling of multi-year data where
 * normalization factors (CPI, exchange rates) vary by year.
 */
export async function getAggregatedLineItems(
  deps: GetAggregatedLineItemsDeps,
  input: AggregatedLineItemsInput
): Promise<Result<AggregatedLineItemConnection, AggregatedLineItemsError>> {
  const { repo } = deps;
  const { limit: rawLimit, offset: rawOffset } = input;

  // Sanitize pagination params
  const limit = Math.min(Math.max(rawLimit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
  const offset = Math.max(rawOffset ?? 0, 0);

  // Use SQL-level normalization if repository supports it
  // This enables correct pagination ordering for normalized amounts
  if ('getNormalizedAggregatedItems' in repo) {
    return getAggregatedLineItemsSqlNormalized(deps, input, limit, offset);
  }

  // Fallback to in-memory normalization
  return getAggregatedLineItemsInMemory(deps, input, limit, offset);
}

/**
 * SQL-level normalization path.
 *
 * Uses pre-computed combined multipliers passed to SQL via VALUES CTE.
 * SQL handles aggregation, sorting, and pagination.
 */
export async function getAggregatedLineItemsSqlNormalized(
  deps: GetAggregatedLineItemsDeps,
  input: AggregatedLineItemsInput,
  limit: number,
  offset: number
): Promise<Result<AggregatedLineItemConnection, AggregatedLineItemsError>> {
  const { repo, normalization, populationRepo } = deps;
  const { filter } = input;

  // 1. Extract year range from filter
  const { startYear, endYear } = extractYearRange(filter);

  // 2. Generate normalization factors
  let factors: NormalizationFactors;
  try {
    factors = await normalization.generateFactors(filter.report_period.type, startYear, endYear);
  } catch (error) {
    return err(
      createNormalizationDataError(
        `Failed to generate normalization factors: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  // 3. Compute denominator population for per_capita mode only
  const denominatorPopulation =
    filter.normalization === 'per_capita'
      ? await getDenominatorPopulation(filter, populationRepo)
      : undefined;

  // 4. Compute combined factor map
  const transformOptions = buildTransformOptions(filter);
  const periodLabels = generatePeriodLabels(startYear, endYear, filter.report_period.type);
  const factorMap = computeCombinedFactorMap(
    transformOptions,
    factors,
    periodLabels,
    denominatorPopulation
  );

  // 5. Build aggregate filters (only include defined values)
  const aggregateFilters = buildAggregateFilters(filter);

  // 6. Call repository with SQL-level pagination
  const result = await repo.getNormalizedAggregatedItems(
    filter,
    factorMap,
    { limit, offset },
    Object.keys(aggregateFilters).length > 0 ? aggregateFilters : undefined
  );

  if (result.isErr()) return err(result.error);

  const { items, totalCount } = result.value;

  // 7. Convert to output format
  const nodes: AggregatedLineItem[] = items.map((row) => ({
    functional_code: row.functional_code,
    functional_name: row.functional_name,
    economic_code: row.economic_code,
    economic_name: row.economic_name,
    amount: row.amount.toNumber(),
    count: row.count,
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

/**
 * In-memory normalization path (fallback).
 *
 * Fetches raw data, normalizes in memory, aggregates, filters, sorts, and paginates.
 */
export async function getAggregatedLineItemsInMemory(
  deps: GetAggregatedLineItemsDeps,
  input: AggregatedLineItemsInput,
  limit: number,
  offset: number
): Promise<Result<AggregatedLineItemConnection, AggregatedLineItemsError>> {
  const { repo, normalization, populationRepo } = deps;
  const { filter } = input;

  // 1. Fetch raw data (per classification, per year)
  const result = await repo.getClassificationPeriodData(filter);
  if (result.isErr()) return err(result.error);

  const { rows } = result.value;

  // Handle empty results
  if (rows.length === 0) {
    return ok({
      nodes: [],
      pageInfo: {
        totalCount: 0,
        hasNextPage: false,
        hasPreviousPage: offset > 0,
      },
    });
  }

  // 2. Extract year range for factor generation
  const years = rows.map((r) => r.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  // 3. Generate normalization factors (if needed)
  const needsFactors = needsNormalization(filter);
  let factors: NormalizationFactors | null = null;

  if (needsFactors) {
    try {
      factors = await normalization.generateFactors(filter.report_period.type, minYear, maxYear);
    } catch (error) {
      return err(
        createNormalizationDataError(
          `Failed to generate normalization factors: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  // 4. Compute denominator population for per_capita mode only
  // This is filter-based (constant per query), not year-specific
  const denominatorPopulation =
    filter.normalization === 'per_capita'
      ? await getDenominatorPopulation(filter, populationRepo)
      : undefined;

  // 5. Build transformation options
  const transformOptions = buildTransformOptions(filter);

  // 6. Normalize and aggregate
  const aggregated = normalizeAndAggregate(rows, transformOptions, factors, denominatorPopulation);

  // 6. Apply aggregate amount filters (HAVING equivalent)
  const filtered = applyAggregateFilters(aggregated, filter);

  // 7. Sort by amount DESC
  filtered.sort((a, b) => b.amount.minus(a.amount).toNumber());

  // 8. Apply pagination
  const totalCount = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  // 9. Convert to output format
  const nodes: AggregatedLineItem[] = paged.map((row) => ({
    functional_code: row.functional_code,
    functional_name: row.functional_name,
    economic_code: row.economic_code,
    economic_name: row.economic_name,
    amount: row.amount.toNumber(),
    count: row.count,
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
 * Determines if normalization is needed based on filter options.
 */
function needsNormalization(filter: NormalizationOptions): boolean {
  return (
    filter.inflation_adjusted ||
    filter.currency !== 'RON' ||
    filter.normalization === 'per_capita' ||
    filter.normalization === 'percent_gdp'
  );
}

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
 * Builds AggregateFilters from NormalizationOptions.
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

/**
 * Normalizes each row and aggregates by classification.
 *
 * For each row:
 * 1. Look up year-specific factors
 * 2. Apply normalization transformations
 * 3. Accumulate into classification buckets
 *
 * @param denominatorPopulation - Filter-based population for per_capita mode (constant per query)
 */
function normalizeAndAggregate(
  rows: ClassificationPeriodData[],
  options: TransformationOptions,
  factors: NormalizationFactors | null,
  denominatorPopulation?: Decimal
): AggregatedClassification[] {
  // Map: "functional_code|economic_code" -> aggregated data
  const aggregationMap = new Map<string, AggregatedClassification>();

  for (const row of rows) {
    // Generate period label for factor lookup (using year)
    const periodLabel = String(row.year);

    // Normalize the amount
    const normalizedAmount = normalizeAmount(
      row.amount,
      periodLabel,
      options,
      factors,
      denominatorPopulation
    );

    // Generate aggregation key
    const key = `${row.functional_code}|${row.economic_code}`;

    // Accumulate
    const existing = aggregationMap.get(key);
    if (existing === undefined) {
      aggregationMap.set(key, {
        functional_code: row.functional_code,
        functional_name: row.functional_name,
        economic_code: row.economic_code,
        economic_name: row.economic_name,
        amount: normalizedAmount,
        count: row.count,
      });
    } else {
      existing.amount = existing.amount.plus(normalizedAmount);
      existing.count += row.count;
    }
  }

  return Array.from(aggregationMap.values());
}

/**
 * Applies normalization transformations to a single amount.
 *
 * Transformation order (following the spec):
 * 1. Inflation adjustment (if not percent_gdp)
 * 2. Currency conversion (if not percent_gdp)
 * 3. Per capita scaling (if per_capita mode)
 * 4. Percent GDP scaling (if percent_gdp mode - exclusive)
 *
 * Note: Growth calculation is not applicable for aggregated totals.
 *
 * @param denominatorPopulation - Filter-based population for per_capita mode.
 *   If provided, uses this constant value. Otherwise, falls back to year-specific
 *   population from factors (legacy behavior).
 */
function normalizeAmount(
  amount: Decimal,
  periodLabel: string,
  options: TransformationOptions,
  factors: NormalizationFactors | null,
  denominatorPopulation?: Decimal
): Decimal {
  if (factors === null) {
    return amount;
  }

  let result = amount;

  if (options.normalization === 'percent_gdp') {
    // Path B: Percent GDP (ignores inflation and currency)
    const gdp = factors.gdp.get(periodLabel);
    if (gdp !== undefined && !gdp.isZero()) {
      // GDP dataset is in RON, amount is in RON
      // Result = (amount / GDP) * 100
      result = result.div(gdp).mul(100);
    } else {
      result = new Decimal(0);
    }
  } else {
    // Path A: Standard normalization

    // 1. Inflation adjustment
    if (options.inflationAdjusted) {
      const cpi = factors.cpi.get(periodLabel);
      if (cpi !== undefined && !cpi.isZero()) {
        // CPI factor is already calculated as (CPI_ref / CPI_year)
        result = result.mul(cpi);
      }
    }

    // 2. Currency conversion
    if (options.currency !== 'RON') {
      const rateMap = options.currency === 'EUR' ? factors.eur : factors.usd;
      const rate = rateMap.get(periodLabel);
      if (rate !== undefined && !rate.isZero()) {
        result = result.div(rate);
      }
    }

    // 3. Per capita scaling
    // Use filter-based population if provided, otherwise fall back to year-specific
    if (options.normalization === 'per_capita') {
      if (denominatorPopulation !== undefined && !denominatorPopulation.isZero()) {
        // Filter-based population (constant per query) - preferred
        result = result.div(denominatorPopulation);
      } else {
        // Fallback to year-specific population from factors (legacy)
        const pop = factors.population.get(periodLabel);
        if (pop !== undefined && !pop.isZero()) {
          result = result.div(pop);
        }
      }
    }
  }

  return result;
}

/**
 * Applies aggregate amount filters (HAVING equivalent).
 */
function applyAggregateFilters(
  data: AggregatedClassification[],
  filter: NormalizationOptions & {
    aggregate_min_amount?: number | null;
    aggregate_max_amount?: number | null;
  }
): AggregatedClassification[] {
  return data.filter((row) => {
    const amount = row.amount.toNumber();

    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      if (amount < filter.aggregate_min_amount) return false;
    }

    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      if (amount > filter.aggregate_max_amount) return false;
    }

    return true;
  });
}

// -----------------------------------------
// SQL Normalization Helpers
// -----------------------------------------

/**
 * Computes a combined normalization multiplier for each period.
 *
 * All normalization transforms (CPI, currency, per_capita) are pre-composed
 * into a single multiplier per period for efficient SQL-level computation.
 *
 * Supports any frequency (YEAR, QUARTER, MONTH) by using period labels.
 *
 * @param options - Transformation options (inflation, currency, normalization mode)
 * @param factors - Year-specific factors from NormalizationService
 * @param periodLabels - Period keys (e.g., ["2020", "2021", "2022"])
 * @param denominatorPopulation - Filter-based population for per_capita mode (optional)
 * @returns Map of period keys to combined multipliers
 */
export function computeCombinedFactorMap(
  options: TransformationOptions,
  factors: NormalizationFactors,
  periodLabels: string[],
  denominatorPopulation?: Decimal
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
        // GDP dataset is in RON; multiplier yields percentage (0-100)
        multiplier = new Decimal(100).div(gdp);
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

      // 3. Per capita scaling (filter-based constant, same for all years)
      if (options.normalization === 'per_capita') {
        if (denominatorPopulation !== undefined && !denominatorPopulation.isZero()) {
          multiplier = multiplier.div(denominatorPopulation);
        }
        // If no denominator, per_capita is effectively disabled (multiplier unchanged)
      }
    }

    result.set(label, multiplier);
  }

  return result;
}

/**
 * Extracts year range from analytics filter.
 *
 * Delegates to the shared extractYearRangeFromSelection utility from common/types/temporal.
 *
 * @param filter - Analytics filter with report period
 * @returns Object with startYear and endYear
 */
export function extractYearRange(filter: AnalyticsFilter): { startYear: number; endYear: number } {
  return extractYearRangeFromSelection(filter.report_period.selection);
}
