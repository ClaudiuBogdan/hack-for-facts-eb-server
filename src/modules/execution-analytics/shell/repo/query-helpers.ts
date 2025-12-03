import { Frequency } from '@/common/types/temporal.js';

/**
 * Period type for analytics queries.
 */
export type PeriodType = 'MONTH' | 'QUARTER' | 'YEAR';

/**
 * Formats database row to date string based on period type.
 *
 * Output format matches the DataPoint.date specification:
 * - YEAR: YYYY (e.g., 2024)
 * - MONTH: YYYY-MM (e.g., 2024-03)
 * - QUARTER: YYYY-QN (e.g., 2024-Q1)
 */
export function formatDateFromRow(
  year: number,
  periodValue: number,
  periodType: PeriodType
): string {
  if (periodType === 'MONTH') {
    const month = String(periodValue).padStart(2, '0');
    return `${String(year)}-${month}`;
  }

  if (periodType === 'QUARTER') {
    return `${String(year)}-Q${String(periodValue)}`;
  }

  // YEAR
  return String(year);
}

/**
 * Maps period type to Frequency enum.
 */
export function getFrequency(periodType: PeriodType): Frequency {
  if (periodType === 'MONTH') return Frequency.MONTHLY;
  if (periodType === 'QUARTER') return Frequency.QUARTERLY;
  return Frequency.YEARLY;
}

/**
 * Extracts year from a date string.
 *
 * Handles formats:
 * - YYYY (e.g., "2024")
 * - YYYY-MM (e.g., "2024-03")
 * - YYYY-QN (e.g., "2024-Q1")
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
