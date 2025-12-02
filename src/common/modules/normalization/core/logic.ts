import { Decimal } from 'decimal.js';

import { DataPoint, NormalizationFactors, TransformationOptions, Currency } from './types.js';

/**
 * Applies inflation adjustment.
 * Multiplies value by CPI factor for the year.
 */
export function applyInflation(data: DataPoint[], cpiMap: Map<number, Decimal>): DataPoint[] {
  return data.map((point) => {
    const factor = cpiMap.get(point.year) ?? new Decimal(1);
    return { ...point, y: point.y.mul(factor) };
  });
}

/**
 * Applies currency conversion.
 * Divides value by exchange rate.
 */
export function applyCurrency(
  data: DataPoint[],
  currency: Currency,
  factors: NormalizationFactors
): DataPoint[] {
  if (currency === 'RON') return data;

  const rateMap = currency === 'EUR' ? factors.eur : factors.usd;

  return data.map((point) => {
    const rate = rateMap.get(point.year) ?? new Decimal(1);
    if (rate.isZero()) return point;
    return { ...point, y: point.y.div(rate) };
  });
}

/**
 * Applies per capita scaling.
 * Divides value by population.
 */
export function applyPerCapita(
  data: DataPoint[],
  populationMap: Map<number, Decimal>
): DataPoint[] {
  return data.map((point) => {
    const pop = populationMap.get(point.year);
    if (pop === undefined || pop.isZero()) return point;
    return { ...point, y: point.y.div(pop) };
  });
}

/**
 * Applies % of GDP scaling.
 * Divides value by Nominal GDP.
 */
export function applyPercentGDP(data: DataPoint[], gdpMap: Map<number, Decimal>): DataPoint[] {
  return data.map((point) => {
    const gdp = gdpMap.get(point.year);
    if (gdp === undefined || gdp.isZero()) return { ...point, y: new Decimal(0) };
    // Result is percentage (0-100)
    return { ...point, y: point.y.div(gdp).mul(100) };
  });
}

/**
 * Calculates period-over-period growth.
 * Returns percentage change.
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
