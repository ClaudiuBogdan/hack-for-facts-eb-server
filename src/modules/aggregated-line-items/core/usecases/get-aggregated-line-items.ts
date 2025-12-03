import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import { createNormalizationDataError, type AggregatedLineItemsError } from '../errors.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type AggregatedLineItemsInput,
  type AggregatedLineItemConnection,
  type AggregatedLineItem,
  type ClassificationPeriodData,
  type AggregatedClassification,
  type NormalizationOptions,
} from '../types.js';

import type { AggregatedLineItemsRepository } from '../ports.js';
import type { NormalizationFactors, TransformationOptions } from '@/modules/normalization/index.js';

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
}

// -----------------------------------------
// Use Case Implementation
// -----------------------------------------

/**
 * Fetches aggregated line items with proper normalization.
 *
 * This use case implements the normalize-then-aggregate pattern:
 * 1. Fetch raw data grouped by (classification, year)
 * 2. Normalize each row using year-specific factors
 * 3. Aggregate by classification (sum across years)
 * 4. Apply HAVING-equivalent filters
 * 5. Sort by amount DESC
 * 6. Apply pagination
 *
 * This ensures correct handling of multi-year data where
 * normalization factors (CPI, exchange rates) vary by year.
 */
export async function getAggregatedLineItems(
  deps: GetAggregatedLineItemsDeps,
  input: AggregatedLineItemsInput
): Promise<Result<AggregatedLineItemConnection, AggregatedLineItemsError>> {
  const { repo, normalization } = deps;
  const { filter, limit: rawLimit, offset: rawOffset } = input;

  // 1. Sanitize pagination params
  const limit = Math.min(Math.max(rawLimit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
  const offset = Math.max(rawOffset ?? 0, 0);

  // 2. Fetch raw data (per classification, per year)
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

  // 3. Extract year range for factor generation
  const years = rows.map((r) => r.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  // 4. Generate normalization factors (if needed)
  const needsFactors = needsNormalization(filter);
  let factors: NormalizationFactors | null = null;

  if (needsFactors) {
    try {
      factors = await normalization.generateFactors(
        filter.report_period.frequency,
        minYear,
        maxYear
      );
    } catch (error) {
      return err(
        createNormalizationDataError(
          `Failed to generate normalization factors: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  // 5. Build transformation options
  const transformOptions = buildTransformOptions(filter);

  // 6. Normalize and aggregate
  const aggregated = normalizeAndAggregate(rows, transformOptions, factors);

  // 7. Apply aggregate amount filters (HAVING equivalent)
  const filtered = applyAggregateFilters(aggregated, filter);

  // 8. Sort by amount DESC
  filtered.sort((a, b) => b.amount.minus(a.amount).toNumber());

  // 9. Apply pagination
  const totalCount = filtered.length;
  const paged = filtered.slice(offset, offset + limit); // TODO: fix this

  // 10. Convert to output format
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
 * Normalizes each row and aggregates by classification.
 *
 * For each row:
 * 1. Look up year-specific factors
 * 2. Apply normalization transformations
 * 3. Accumulate into classification buckets
 */
function normalizeAndAggregate(
  rows: ClassificationPeriodData[],
  options: TransformationOptions,
  factors: NormalizationFactors | null
): AggregatedClassification[] {
  // Map: "functional_code|economic_code" -> aggregated data
  const aggregationMap = new Map<string, AggregatedClassification>();

  for (const row of rows) {
    // Generate period label for factor lookup (using year)
    const periodLabel = String(row.year);

    // Normalize the amount
    const normalizedAmount = normalizeAmount(row.amount, periodLabel, options, factors);

    // Generate aggregation key
    const key = `${row.functional_code}|${row.economic_code}`;

    // Accumulate
    const existing = aggregationMap.get(key);
    if (existing !== undefined) {
      existing.amount = existing.amount.plus(normalizedAmount);
      existing.count += row.count;
    } else {
      aggregationMap.set(key, {
        functional_code: row.functional_code,
        functional_name: row.functional_name,
        economic_code: row.economic_code,
        economic_name: row.economic_name,
        amount: normalizedAmount,
        count: row.count,
      });
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
 */
function normalizeAmount(
  amount: Decimal,
  periodLabel: string,
  options: TransformationOptions,
  factors: NormalizationFactors | null
): Decimal {
  if (factors === null) {
    return amount;
  }

  let result = amount;

  if (options.normalization === 'percent_gdp') {
    // Path B: Percent GDP (ignores inflation and currency)
    const gdp = factors.gdp.get(periodLabel);
    if (gdp !== undefined && !gdp.isZero()) {
      // GDP is in millions, amount is in RON
      // Result = (amount / (GDP * 1,000,000)) * 100
      result = result.div(gdp.mul(1_000_000)).mul(100);
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
    if (options.normalization === 'per_capita') {
      const pop = factors.population.get(periodLabel);
      if (pop !== undefined && !pop.isZero()) {
        result = result.div(pop);
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
