import { Decimal } from 'decimal.js';

import { getFactorOrDefault, type FactorMap } from './factor-maps.js';

import type { DataPoint, NormalizationFactors, TransformationOptions, Currency } from './types.js';

/**
 * Applies inflation adjustment using period-matched CPI factors.
 * Multiplies value by CPI factor for the period.
 *
 * @param data - Data points with x (period label) and y (value)
 * @param cpiMap - CPI factors keyed by period label
 */
export function applyInflation(data: DataPoint[], cpiMap: FactorMap): DataPoint[] {
  return data.map((point) => {
    const factor = getFactorOrDefault(cpiMap, point.x);
    return { ...point, y: point.y.mul(factor) };
  });
}

/**
 * Applies currency conversion using period-matched exchange rates.
 * Divides value by exchange rate.
 *
 * @param data - Data points with x (period label) and y (value in RON)
 * @param currency - Target currency (EUR or USD)
 * @param factors - Normalization factors containing exchange rate maps
 */
export function applyCurrency(
  data: DataPoint[],
  currency: Currency,
  factors: NormalizationFactors
): DataPoint[] {
  if (currency === 'RON') return data;

  const rateMap = currency === 'EUR' ? factors.eur : factors.usd;

  return data.map((point) => {
    const rate = getFactorOrDefault(rateMap, point.x);
    if (rate.isZero()) return point;
    return { ...point, y: point.y.div(rate) };
  });
}

/**
 * Applies per capita scaling using period-matched population.
 * Divides value by population.
 *
 * @param data - Data points with x (period label) and y (value)
 * @param populationMap - Population values keyed by period label
 */
export function applyPerCapita(data: DataPoint[], populationMap: FactorMap): DataPoint[] {
  return data.map((point) => {
    const pop = populationMap.get(point.x);
    if (pop === undefined || pop.isZero()) return point;
    return { ...point, y: point.y.div(pop) };
  });
}

/**
 * Applies % of GDP scaling using period-matched GDP.
 * Divides value by Nominal GDP.
 *
 * @param data - Data points with x (period label) and y (value)
 * @param gdpMap - GDP values keyed by period label
 */
export function applyPercentGDP(data: DataPoint[], gdpMap: FactorMap): DataPoint[] {
  return data.map((point) => {
    const gdp = gdpMap.get(point.x);
    if (gdp === undefined || gdp.isZero()) return { ...point, y: new Decimal(0) };
    // Result is percentage (0-100)
    return { ...point, y: point.y.div(gdp).mul(100) };
  });
}

/**
 * Calculates period-over-period growth.
 * Returns percentage change from previous period.
 *
 * Note: This assumes data is sorted chronologically.
 */
export function applyGrowth(data: DataPoint[]): DataPoint[] {
  const result: DataPoint[] = [];
  for (let i = 0; i < data.length; i++) {
    const current = data[i];
    if (current === undefined) continue;

    const prev = i > 0 ? data[i - 1] : undefined;

    if (prev === undefined || prev.y.isZero()) {
      result.push({ ...current, y: new Decimal(0) });
    } else {
      const growth = current.y.minus(prev.y).div(prev.y).mul(100);
      result.push({ ...current, y: growth });
    }
  }
  return result;
}

/**
 * Main transformation pipeline.
 *
 * Applies normalization transformations in the correct order:
 * 1. Inflation adjustment (if requested and not percent_gdp mode)
 * 2. Currency conversion (if not RON and not percent_gdp mode)
 * 3. Per capita scaling (if per_capita mode)
 * 4. Percent of GDP (if percent_gdp mode - mutually exclusive with above)
 * 5. Growth calculation (if requested)
 *
 * @param data - Data points to transform
 * @param options - Transformation options
 * @param factors - Normalization factors (period-matched FactorMaps)
 */
export function normalizeData(
  data: DataPoint[],
  options: TransformationOptions,
  factors: NormalizationFactors
): DataPoint[] {
  let result = [...data];

  if (options.normalization === 'percent_gdp') {
    result = applyPercentGDP(result, factors.gdp);
  } else {
    if (options.inflationAdjusted) {
      result = applyInflation(result, factors.cpi);
    }

    if (options.currency !== 'RON') {
      result = applyCurrency(result, options.currency, factors);
    }

    if (options.normalization === 'per_capita') {
      result = applyPerCapita(result, factors.population);
    }
  }

  if (options.showPeriodGrowth === true) {
    result = applyGrowth(result);
  }

  return result;
}
