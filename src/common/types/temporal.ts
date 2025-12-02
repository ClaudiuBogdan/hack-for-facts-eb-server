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
 * A single data point in a time series
 */
export interface DataPoint {
  /** ISO 8601 date string (YYYY-MM-DD) */
  date: string;
  /** Decimal value */
  value: Decimal;
}

/**
 * Time series data with consistent frequency
 */
export interface DataSeries {
  /** Frequency of the data points */
  frequency: Frequency;
  /** Ordered array of data points */
  data: DataPoint[];
}
