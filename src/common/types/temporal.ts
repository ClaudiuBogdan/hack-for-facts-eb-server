import { Decimal } from 'decimal.js';

/**
 * Frequency of temporal data points
 */
export enum Frequency {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
}

/**
 * A single data point in a time series.
 *
 * This is the wire format used for storage and GraphQL responses.
 */
export interface DataPoint {
  /** Date string: YYYY, YYYY-MM, or YYYY-QN */
  date: string;
  /** Decimal value */
  value: Decimal;
}

/**
 * Time series data with consistent frequency.
 *
 * This is the primary format for temporal data throughout the system.
 * All data requiring normalization (inflation adjustment, currency conversion, etc.)
 * should be fetched as a DataSeries first.
 */
export interface DataSeries {
  /** Frequency of the data points */
  frequency: Frequency;
  /** Ordered array of data points */
  data: DataPoint[];
}

/**
 * A data point enriched with parsed year for normalization lookups.
 *
 * Used internally by the normalization pipeline to map data points
 * to their corresponding normalization factors (CPI, exchange rates, etc.)
 * by year.
 */
export interface NormalizableDataPoint {
  /** Original date label (YYYY, YYYY-MM, or YYYY-QN) */
  date: string;
  /** Parsed year for factor lookups (extracted from date) */
  year: number;
  /** Value to be transformed */
  value: Decimal;
}

/**
 * Converts a DataPoint to NormalizableDataPoint by extracting the year.
 */
export function toNormalizableDataPoint(point: DataPoint): NormalizableDataPoint {
  // Extract year from date string (first 4 characters)
  const yearStr = point.date.substring(0, 4);
  const year = Number.parseInt(yearStr, 10);
  return {
    date: point.date,
    year: Number.isNaN(year) ? 0 : year,
    value: point.value,
  };
}

/**
 * Converts a NormalizableDataPoint back to DataPoint.
 */
export function fromNormalizableDataPoint(point: NormalizableDataPoint): DataPoint {
  return {
    date: point.date,
    value: point.value,
  };
}

/**
 * Converts a DataSeries to an array of NormalizableDataPoints.
 */
export function toNormalizableDataPoints(series: DataSeries): NormalizableDataPoint[] {
  return series.data.map(toNormalizableDataPoint);
}

/**
 * Creates a DataSeries from NormalizableDataPoints.
 */
export function fromNormalizableDataPoints(
  points: NormalizableDataPoint[],
  frequency: Frequency
): DataSeries {
  return {
    frequency,
    data: points.map(fromNormalizableDataPoint),
  };
}

/**
 * Creates a single-point DataSeries for point-in-time data.
 *
 * Use this when you have data for a specific period (e.g., a single year's total)
 * that needs normalization. The normalization pipeline will still work correctly
 * with a single-point series.
 *
 * @param date - Period identifier (YYYY, YYYY-MM, or YYYY-QN)
 * @param value - The value for that period
 * @param frequency - The frequency matching the date format
 */
export function createSinglePointSeries(
  date: string,
  value: Decimal,
  frequency: Frequency
): DataSeries {
  return {
    frequency,
    data: [{ date, value }],
  };
}
