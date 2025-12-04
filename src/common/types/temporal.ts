import { Decimal } from 'decimal.js';

/**
 * Frequency of temporal data points
 */
export enum Frequency {
  MONTH = 'MONTH',
  QUARTER = 'QUARTER',
  YEAR = 'YEAR',
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

// ============================================================================
// Period Label Utilities
// ============================================================================

/**
 * Generates period labels for a year range.
 *
 * For yearly frequency, generates labels like ["2020", "2021", "2022"].
 * For monthly frequency, generates labels like ["2020-01", "2020-02", ..., "2022-12"].
 * For quarterly frequency, generates labels like ["2020-Q1", "2020-Q2", ..., "2022-Q4"].
 *
 * @param startYear - First year in range (inclusive)
 * @param endYear - Last year in range (inclusive)
 * @param frequency - Target frequency for labels (defaults to YEAR)
 * @returns Array of period label strings
 */
export function generatePeriodLabels(
  startYear: number,
  endYear: number,
  frequency: Frequency = Frequency.YEAR
): string[] {
  const labels: string[] = [];

  switch (frequency) {
    case Frequency.MONTH:
      for (let year = startYear; year <= endYear; year++) {
        for (let month = 1; month <= 12; month++) {
          labels.push(`${String(year)}-${String(month).padStart(2, '0')}`);
        }
      }
      break;

    case Frequency.QUARTER:
      for (let year = startYear; year <= endYear; year++) {
        for (let quarter = 1; quarter <= 4; quarter++) {
          labels.push(`${String(year)}-Q${String(quarter)}`);
        }
      }
      break;

    case Frequency.YEAR:
    default:
      for (let year = startYear; year <= endYear; year++) {
        labels.push(String(year));
      }
      break;
  }

  return labels;
}

/**
 * Extracts the year from a period label string.
 *
 * Handles formats: YYYY, YYYY-MM, YYYY-QN
 *
 * @param label - Period label string
 * @returns The year as a number, or null if parsing fails
 */
export function extractYearFromLabel(label: string): number | null {
  if (label.length < 4) {
    return null;
  }

  const yearPart = label.substring(0, 4);
  if (!/^\d{4}$/.test(yearPart)) {
    return null;
  }

  const year = Number.parseInt(yearPart, 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * Year range result type
 */
export interface YearRange {
  startYear: number;
  endYear: number;
}

/**
 * Period selection type for extractYearRange.
 *
 * Accepts both the discriminated union from analytics.ts and simpler formats.
 * With exactOptionalPropertyTypes, we need to handle undefined explicitly.
 */
interface PeriodSelection {
  interval?: { start: string; end: string } | undefined;
  dates?: string[] | undefined;
}

/**
 * Extracts year range from a period selection (interval or discrete dates).
 *
 * This function is used by analytics modules to determine the year range
 * needed for normalization factor generation.
 *
 * @param selection - Period selection with either interval or dates
 * @param fallbackYear - Year to use if extraction fails (defaults to current year)
 * @returns Object with startYear and endYear
 */
export function extractYearRangeFromSelection(
  selection: PeriodSelection,
  fallbackYear?: number
): YearRange {
  const defaultYear = fallbackYear ?? new Date().getFullYear();
  let startYear = defaultYear;
  let endYear = defaultYear;

  if (selection.interval !== undefined) {
    const parsedStart = extractYearFromLabel(selection.interval.start);
    const parsedEnd = extractYearFromLabel(selection.interval.end);

    if (parsedStart !== null) {
      startYear = parsedStart;
    }
    if (parsedEnd !== null) {
      endYear = parsedEnd;
    }
  } else if (selection.dates !== undefined && selection.dates.length > 0) {
    const years = selection.dates
      .map((d) => extractYearFromLabel(d))
      .filter((y): y is number => y !== null);

    if (years.length > 0) {
      startYear = Math.min(...years);
      endYear = Math.max(...years);
    }
  }

  return { startYear, endYear };
}
