import { Decimal } from 'decimal.js';

import { Frequency } from '@/common/types/temporal.js';

/**
 * A factor map is keyed by period label (YYYY, YYYY-MM, or YYYY-QN).
 * Values are Decimal factors used for normalization.
 */
export type FactorMap = Map<string, Decimal>;

/**
 * Source data for generating factor maps.
 * Each map is keyed by period label with Decimal values.
 */
export interface FactorDatasets {
  /** Yearly factors (required) - key format: "YYYY" */
  yearly: FactorMap;
  /** Quarterly factors (optional) - key format: "YYYY-QN" */
  quarterly?: FactorMap;
  /** Monthly factors (optional) - key format: "YYYY-MM" */
  monthly?: FactorMap;
}

/**
 * Generates all month labels for a year range.
 * @returns Array of labels like ["2020-01", "2020-02", ..., "2023-12"]
 */
function generateMonthLabels(startYear: number, endYear: number): string[] {
  const labels: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    for (let month = 1; month <= 12; month++) {
      labels.push(`${year.toString()}-${month.toString().padStart(2, '0')}`);
    }
  }
  return labels;
}

/**
 * Generates all quarter labels for a year range.
 * @returns Array of labels like ["2020-Q1", "2020-Q2", ..., "2023-Q4"]
 */
function generateQuarterLabels(startYear: number, endYear: number): string[] {
  const labels: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    for (let quarter = 1; quarter <= 4; quarter++) {
      labels.push(`${year.toString()}-Q${quarter.toString()}`);
    }
  }
  return labels;
}

/**
 * Generates all year labels for a year range.
 * @returns Array of labels like ["2020", "2021", "2022", "2023"]
 */
function generateYearLabels(startYear: number, endYear: number): string[] {
  const labels: string[] = [];
  for (let year = startYear; year <= endYear; year++) {
    labels.push(year.toString());
  }
  return labels;
}

/**
 * Extracts the year from a period label.
 * Handles: "2023", "2023-01", "2023-Q1"
 */
function extractYear(label: string): number {
  return Number.parseInt(label.substring(0, 4), 10);
}

/**
 * Generates a complete factor map at the requested frequency.
 *
 * This function creates a map with entries for every period in the range,
 * using the fallback strategy when higher-frequency data is not available:
 *
 * - MONTHLY: Try monthly → fallback to yearly → fallback to previous value
 * - QUARTERLY: Try quarterly → fallback to yearly → fallback to previous value
 * - YEARLY: Use yearly → fallback to previous value
 *
 * Gap filling strategy: When no value is found for a period (neither at the
 * requested frequency nor yearly), the previous period's value is used.
 * This is more accurate for financial data like CPI and exchange rates,
 * which don't suddenly reset but rather carry forward.
 *
 * @param frequency - Target frequency for the factor map
 * @param startYear - First year to include
 * @param endYear - Last year to include
 * @param datasets - Available factor data at different frequencies
 * @returns Complete factor map at the requested frequency
 *
 * @example
 * ```typescript
 * const cpiDatasets = {
 *   yearly: new Map([["2023", new Decimal(1.1)], ["2024", new Decimal(1.0)]]),
 *   monthly: new Map([["2024-01", new Decimal(1.02)], ["2024-02", new Decimal(1.01)]]),
 * };
 *
 * // Generate monthly CPI factors for 2023-2024
 * const monthlyFactors = generateFactorMap(
 *   Frequency.MONTHLY,
 *   2023,
 *   2024,
 *   cpiDatasets
 * );
 * // Result: Map with 24 entries
 * // 2023-01 through 2023-12: all use 1.1 (yearly fallback)
 * // 2024-01: 1.02 (from monthly)
 * // 2024-02: 1.01 (from monthly)
 * // 2024-03 through 2024-12: all use 1.01 (previous value - 2024-02)
 * ```
 */
export function generateFactorMap(
  frequency: Frequency,
  startYear: number,
  endYear: number,
  datasets: FactorDatasets
): FactorMap {
  const result: FactorMap = new Map();
  let previousValue: Decimal | undefined;

  switch (frequency) {
    case Frequency.MONTHLY: {
      const labels = generateMonthLabels(startYear, endYear);
      for (const label of labels) {
        let value: Decimal | undefined;

        // Try monthly first
        if (datasets.monthly !== undefined) {
          value = datasets.monthly.get(label);
        }

        // Fallback to yearly
        if (value === undefined) {
          const year = extractYear(label);
          value = datasets.yearly.get(year.toString());
        }

        // Fallback to previous value
        value ??= previousValue;

        // Only set if we have a value
        if (value !== undefined) {
          result.set(label, value);
          previousValue = value;
        }
      }
      break;
    }

    case Frequency.QUARTERLY: {
      const labels = generateQuarterLabels(startYear, endYear);
      for (const label of labels) {
        let value: Decimal | undefined;

        // Try quarterly first
        if (datasets.quarterly !== undefined) {
          value = datasets.quarterly.get(label);
        }

        // Fallback to yearly
        if (value === undefined) {
          const year = extractYear(label);
          value = datasets.yearly.get(year.toString());
        }

        // Fallback to previous value
        value ??= previousValue;

        // Only set if we have a value
        if (value !== undefined) {
          result.set(label, value);
          previousValue = value;
        }
      }
      break;
    }

    case Frequency.YEARLY: {
      const labels = generateYearLabels(startYear, endYear);
      for (const label of labels) {
        let value = datasets.yearly.get(label);

        // Fallback to previous value
        value ??= previousValue;

        // Only set if we have a value
        if (value !== undefined) {
          result.set(label, value);
          previousValue = value;
        }
      }
      break;
    }
  }

  return result;
}

/**
 * Converts a dataset (with x/y points) to a FactorMap.
 *
 * @param points - Array of points with x (label) and y (value)
 * @returns FactorMap keyed by the x labels
 */
export function datasetToFactorMap(points: { x: string; y: Decimal }[]): FactorMap {
  const map: FactorMap = new Map();
  for (const point of points) {
    map.set(point.x, point.y);
  }
  return map;
}

/**
 * Creates FactorDatasets from available dataset points.
 *
 * @param yearly - Required yearly dataset points
 * @param quarterly - Optional quarterly dataset points
 * @param monthly - Optional monthly dataset points
 * @returns FactorDatasets structure ready for generateFactorMap
 */
export function createFactorDatasets(
  yearly: { x: string; y: Decimal }[],
  quarterly?: { x: string; y: Decimal }[],
  monthly?: { x: string; y: Decimal }[]
): FactorDatasets {
  const result: FactorDatasets = {
    yearly: datasetToFactorMap(yearly),
  };

  if (quarterly !== undefined) {
    result.quarterly = datasetToFactorMap(quarterly);
  }

  if (monthly !== undefined) {
    result.monthly = datasetToFactorMap(monthly);
  }

  return result;
}

/**
 * Gets a factor value from a map, with a default fallback.
 *
 * @param map - The factor map
 * @param key - The period label
 * @param defaultValue - Value to return if key not found (default: 1.0)
 * @returns The factor value
 */
export function getFactorOrDefault(
  map: FactorMap,
  key: string,
  defaultValue: Decimal = new Decimal(1)
): Decimal {
  return map.get(key) ?? defaultValue;
}
