import { Frequency } from '@/common/types/temporal.js';

// Re-export Frequency for convenience
export { Frequency } from '@/common/types/temporal.js';

/**
 * Formats database row to date string based on frequency.
 *
 * Output format matches the DataPoint.date specification:
 * - YEARLY: YYYY (e.g., 2024)
 * - MONTHLY: YYYY-MM (e.g., 2024-03)
 * - QUARTERLY: YYYY-QN (e.g., 2024-Q1)
 */
export function formatDateFromRow(year: number, periodValue: number, frequency: Frequency): string {
  if (frequency === Frequency.MONTH) {
    const month = String(periodValue).padStart(2, '0');
    return `${String(year)}-${month}`;
  }

  if (frequency === Frequency.QUARTER) {
    return `${String(year)}-Q${String(periodValue)}`;
  }

  // YEARLY
  return String(year);
}

/**
 * Parsed period components from a date string.
 */
export interface ParsedPeriod {
  year: number;
  month?: number;
  quarter?: number;
}

/**
 * Parses a period date string into its components.
 *
 * Handles formats:
 * - YYYY (e.g., "2024") - returns { year: 2024 }
 * - YYYY-MM (e.g., "2024-03") - returns { year: 2024, month: 3 }
 * - YYYY-QN (e.g., "2024-Q1") - returns { year: 2024, quarter: 1 }
 *
 * @returns Parsed period components, or null if parsing fails
 */
export function parsePeriodDate(dateStr: string): ParsedPeriod | null {
  // Try year-only format: YYYY
  const yearOnlyMatch = /^(\d{4})$/.exec(dateStr);
  if (yearOnlyMatch?.[1] !== undefined) {
    return { year: parseInt(yearOnlyMatch[1], 10) };
  }

  // Try year-month format: YYYY-MM
  const yearMonthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(dateStr);
  if (yearMonthMatch?.[1] !== undefined && yearMonthMatch[2] !== undefined) {
    return {
      year: parseInt(yearMonthMatch[1], 10),
      month: parseInt(yearMonthMatch[2], 10),
    };
  }

  // Try year-quarter format: YYYY-QN
  const yearQuarterMatch = /^(\d{4})-Q([1-4])$/.exec(dateStr);
  if (yearQuarterMatch?.[1] !== undefined && yearQuarterMatch[2] !== undefined) {
    return {
      year: parseInt(yearQuarterMatch[1], 10),
      quarter: parseInt(yearQuarterMatch[2], 10),
    };
  }

  return null;
}

/**
 * Extracts year from a date string.
 *
 * Handles formats:
 * - YYYY (e.g., "2024")
 * - YYYY-MM (e.g., "2024-03")
 * - YYYY-QN (e.g., "2024-Q1")
 * - Any string starting with 4 digits (e.g., "2024-01-15")
 *
 * @returns The year as a number, or null if parsing fails
 */
export function extractYear(dateStr: string): number | null {
  if (dateStr.length < 4) {
    return null;
  }

  const yearPart = dateStr.substring(0, 4);

  // Validate that all 4 characters are digits
  if (!/^\d{4}$/.test(yearPart)) {
    return null;
  }

  const year = parseInt(yearPart, 10);

  if (Number.isNaN(year)) {
    return null;
  }

  return year;
}

/**
 * Extracts month from a date string.
 *
 * Handles format: YYYY-MM (e.g., "2024-03")
 *
 * @returns The month as a number (1-12), or null if parsing fails or format is not YYYY-MM
 */
export function extractMonth(dateStr: string): number | null {
  const parsed = parsePeriodDate(dateStr);
  return parsed?.month ?? null;
}

/**
 * Extracts quarter from a date string.
 *
 * Handles format: YYYY-QN (e.g., "2024-Q1")
 *
 * @returns The quarter as a number (1-4), or null if parsing fails or format is not YYYY-QN
 */
export function extractQuarter(dateStr: string): number | null {
  const parsed = parsePeriodDate(dateStr);
  return parsed?.quarter ?? null;
}

/**
 * Converts an array of string IDs to numeric IDs, filtering out invalid values.
 *
 * Filters out:
 * - Empty strings
 * - Whitespace-only strings
 * - Non-numeric strings
 *
 * @param ids - Array of string IDs
 * @returns Array of valid numeric IDs
 */
export function toNumericIds(ids: readonly string[]): number[] {
  return ids
    .filter((id) => id.trim() !== '') // Filter out empty/whitespace strings
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

/**
 * Filter type for entity join checks.
 * Uses snake_case to match existing AnalyticsFilter type from GraphQL schema.
 */
interface EntityJoinFilter {
  entity_types?: readonly string[];
  is_uat?: boolean;
  uat_ids?: readonly string[];
  county_codes?: readonly string[];
  exclude?: {
    entity_types?: readonly string[];
    uat_ids?: readonly string[];
    county_codes?: readonly string[];
  };
}

/**
 * Checks if a value needs entity table join for filtering.
 *
 * Note: `is_uat` being undefined means "no filter", while `true`/`false`
 * means we need to filter on the entity table.
 */
export function needsEntityJoin(filter: EntityJoinFilter): boolean {
  // is_uat must be explicitly true or false (not undefined) to require join
  const hasUatFilter = filter.is_uat !== undefined;

  const hasEntityTypes = filter.entity_types !== undefined && filter.entity_types.length > 0;
  const hasUatIds = filter.uat_ids !== undefined && filter.uat_ids.length > 0;
  const hasCountyCodes = filter.county_codes !== undefined && filter.county_codes.length > 0;

  const hasExcludeEntityTypes =
    filter.exclude?.entity_types !== undefined && filter.exclude.entity_types.length > 0;
  const hasExcludeUatIds =
    filter.exclude?.uat_ids !== undefined && filter.exclude.uat_ids.length > 0;
  const hasExcludeCountyCodes =
    filter.exclude?.county_codes !== undefined && filter.exclude.county_codes.length > 0;

  return (
    hasEntityTypes ||
    hasUatFilter ||
    hasUatIds ||
    hasCountyCodes ||
    hasExcludeEntityTypes ||
    hasExcludeUatIds ||
    hasExcludeCountyCodes
  );
}

/**
 * Filter type for UAT join checks.
 * Uses snake_case to match existing AnalyticsFilter type from GraphQL schema.
 */
interface UatJoinFilter {
  county_codes?: readonly string[];
  exclude?: {
    county_codes?: readonly string[];
  };
}

/**
 * Checks if a value needs UAT table join for filtering.
 */
export function needsUatJoin(filter: UatJoinFilter): boolean {
  const hasCountyCodes = filter.county_codes !== undefined && filter.county_codes.length > 0;
  const hasExcludeCountyCodes =
    filter.exclude?.county_codes !== undefined && filter.exclude.county_codes.length > 0;

  return hasCountyCodes || hasExcludeCountyCodes;
}
