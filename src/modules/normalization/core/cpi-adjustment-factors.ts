import { Decimal } from 'decimal.js';

import type { FactorMap } from './factor-maps.js';

const YEAR_RE = /^\d{4}$/;

/**
 * Builds CPI inflation-adjustment factors suitable for:
 *
 *   real_value = nominal_value * cpi_factor[year]
 *
 * Expected CPI dataset format:
 * - yearly points keyed by "YYYY"
 * - values are a year-over-year index (e.g. 105.59 means +5.59% vs previous year)
 *
 * The output factor is the ratio of the reference-year price level over the
 * target-year price level, derived by chaining YoY indices into a cumulative
 * price-level series.
 */
export const computeCpiAdjustmentFactorMap = (
  cpiYoYIndexYearly: FactorMap,
  referenceYear: number
): FactorMap => {
  const years = [...cpiYoYIndexYearly.keys()]
    .filter((k) => YEAR_RE.test(k))
    .map((k) => Number.parseInt(k, 10))
    .filter((y) => !Number.isNaN(y))
    .sort((a, b) => a - b);

  if (years.length === 0) return new Map();

  const maxYear = years.at(-1);
  if (maxYear === undefined) return new Map();

  const effectiveReferenceYear = cpiYoYIndexYearly.has(String(referenceYear))
    ? referenceYear
    : maxYear;

  const levelByYear = new Map<number, Decimal>();
  const firstYear = years[0];
  if (firstYear === undefined) return new Map();

  // Base level is arbitrary; it cancels out in ref/year ratios.
  levelByYear.set(firstYear, new Decimal(1));

  for (let i = 1; i < years.length; i++) {
    const year = years[i];
    const prevYear = years[i - 1];
    if (year === undefined || prevYear === undefined) continue;

    const prevLevel = levelByYear.get(prevYear);
    const yoyIndex = cpiYoYIndexYearly.get(String(year));

    if (prevLevel === undefined || yoyIndex === undefined) continue;
    if (!yoyIndex.isFinite() || yoyIndex.isZero()) continue;

    // YoY index is e.g. 105.59, meaning a multiplier of 1.0559.
    const multiplier = yoyIndex.div(100);
    levelByYear.set(year, prevLevel.mul(multiplier));
  }

  const referenceLevel = levelByYear.get(effectiveReferenceYear);
  if (referenceLevel === undefined || referenceLevel.isZero()) return new Map();

  const factors: FactorMap = new Map();

  for (const year of years) {
    const level = levelByYear.get(year);
    if (level === undefined || level.isZero()) continue;
    factors.set(String(year), referenceLevel.div(level));
  }

  return factors;
};
