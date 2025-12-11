/**
 * MCP Module - Core Utilities
 *
 * Pure utility functions for MCP tools.
 * These are used across use cases for validation and normalization.
 */

import { ok, err, type Result } from 'neverthrow';

import { invalidPeriodError, type McpError } from './errors.js';

import type { Granularity } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Classification Code Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a classification code by removing ".00" segments.
 *
 * This ensures consistency between user input and database storage,
 * where codes are stored without zero-only segments.
 *
 * Handles both:
 * - Exact codes: "65.00" → "65", "65.10.00" → "65.10"
 * - Prefix codes: "65.00." → "65.", "65.10.00." → "65.10."
 *
 * @param code - The classification code to normalize
 * @returns The normalized code
 *
 * @example
 * normalizeClassificationCode("65.00")      // → "65"
 * normalizeClassificationCode("65.10.00")   // → "65.10"
 * normalizeClassificationCode("65.00.")     // → "65." (prefix)
 * normalizeClassificationCode("65.10.03")   // → "65.10.03" (unchanged)
 * normalizeClassificationCode("65")         // → "65" (unchanged)
 * normalizeClassificationCode("65.")        // → "65." (prefix, unchanged)
 */
export function normalizeClassificationCode(code: string): string {
  // Check if it's a prefix code (ends with dot)
  const isPrefix = code.endsWith('.');

  if (isPrefix) {
    // For prefix codes, remove .00 segments before the trailing dot
    // "65.00." → "65.", "65.10.00." → "65.10."
    const withoutTrailingDot = code.slice(0, -1);
    const normalized = withoutTrailingDot.replace(/(?:\.00)+$/, '');
    return normalized + '.';
  }

  // For exact codes, remove trailing .00 segments
  // "65.00" → "65", "65.10.00" → "65.10"
  return code.replace(/(?:\.00)+$/, '');
}

/**
 * Normalizes an array of classification codes.
 *
 * @param codes - Array of classification codes
 * @returns Array of normalized codes
 */
export function normalizeClassificationCodes(codes: string[]): string[] {
  return codes.map(normalizeClassificationCode);
}

/**
 * Classification code field names that may appear in filters.
 */
const CLASSIFICATION_CODE_FIELDS = [
  'functionalCodes',
  'functionalPrefixes',
  'functional_codes',
  'functional_prefixes',
  'economicCodes',
  'economicPrefixes',
  'economic_codes',
  'economic_prefixes',
] as const;

/**
 * Normalizes classification codes in a filter object.
 * Handles both single codes and arrays of codes.
 *
 * @param filter - Filter object that may contain classification codes
 * @returns New filter object with normalized codes
 */
export function normalizeFilterClassificationCodes(
  filter: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...filter };

  for (const field of CLASSIFICATION_CODE_FIELDS) {
    const value = result[field];
    if (Array.isArray(value)) {
      result[field] = normalizeClassificationCodes(value as string[]);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Period Format Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regular expressions for period format validation.
 */
const PERIOD_PATTERNS = {
  /** YYYY format for yearly data (e.g., "2023") */
  YEAR: /^\d{4}$/,
  /** YYYY-MM format for monthly data (e.g., "2023-06") */
  MONTH: /^\d{4}-(0[1-9]|1[0-2])$/,
  /** YYYY-QN format for quarterly data (e.g., "2023-Q2") */
  QUARTER: /^\d{4}-Q[1-4]$/,
} as const;

/**
 * Validates that a period string matches the expected format for its granularity.
 *
 * @param period - The period string to validate
 * @param granularity - The expected granularity (YEAR, MONTH, QUARTER)
 * @returns Ok(period) if valid, Err(McpError) if invalid
 *
 * @example
 * validatePeriodFormat("2023", "YEAR")      // → Ok("2023")
 * validatePeriodFormat("2023-06", "MONTH")  // → Ok("2023-06")
 * validatePeriodFormat("2023-Q2", "QUARTER") // → Ok("2023-Q2")
 * validatePeriodFormat("2023-06", "YEAR")   // → Err(INVALID_PERIOD)
 */
export function validatePeriodFormat(
  period: string,
  granularity: Granularity
): Result<string, McpError> {
  const pattern = PERIOD_PATTERNS[granularity];

  if (!pattern.test(period)) {
    const expectedFormat = getExpectedFormat(granularity);
    return err(
      invalidPeriodError(
        `Period "${period}" does not match ${granularity} format (${expectedFormat})`
      )
    );
  }

  return ok(period);
}

/**
 * Returns the expected format description for a granularity.
 */
function getExpectedFormat(granularity: Granularity): string {
  switch (granularity) {
    case 'YEAR':
      return 'YYYY';
    case 'MONTH':
      return 'YYYY-MM';
    case 'QUARTER':
      return 'YYYY-QN';
  }
}

/**
 * Validates an array of periods against a granularity.
 *
 * @param periods - Array of period strings
 * @param granularity - Expected granularity
 * @returns Ok(periods) if all valid, Err with first invalid period
 */
export function validatePeriods(
  periods: string[],
  granularity: Granularity
): Result<string[], McpError> {
  for (const period of periods) {
    const result = validatePeriodFormat(period, granularity);
    if (result.isErr()) {
      return err(result.error);
    }
  }
  return ok(periods);
}

/**
 * Validates a period interval (start and end).
 *
 * @param start - Start period
 * @param end - End period
 * @param granularity - Expected granularity
 * @returns Ok({ start, end }) if valid, Err if invalid
 */
export function validatePeriodInterval(
  start: string,
  end: string,
  granularity: Granularity
): Result<{ start: string; end: string }, McpError> {
  const startResult = validatePeriodFormat(start, granularity);
  if (startResult.isErr()) {
    return err(startResult.error);
  }

  const endResult = validatePeriodFormat(end, granularity);
  if (endResult.isErr()) {
    return err(endResult.error);
  }

  // Validate that start <= end
  if (start > end) {
    return err(
      invalidPeriodError(`Start period "${start}" must be before or equal to end period "${end}"`)
    );
  }

  return ok({ start, end });
}

/**
 * Validates period selection (either interval or explicit dates).
 *
 * @param selection - Period selection object
 * @param granularity - Expected granularity
 * @returns Ok(selection) if valid, Err if invalid
 */
export function validatePeriodSelection(
  selection: { interval?: { start: string; end: string }; dates?: string[] },
  granularity: Granularity
): Result<typeof selection, McpError> {
  if (selection.interval !== undefined) {
    const result = validatePeriodInterval(
      selection.interval.start,
      selection.interval.end,
      granularity
    );
    if (result.isErr()) {
      return err(result.error);
    }
  } else if (selection.dates !== undefined) {
    const result = validatePeriods(selection.dates, granularity);
    if (result.isErr()) {
      return err(result.error);
    }
  } else {
    return err(invalidPeriodError('Period selection must have either interval or dates'));
  }

  return ok(selection);
}

// ─────────────────────────────────────────────────────────────────────────────
// Number Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a number in compact form with suffix.
 *
 * @param amount - The amount to format
 * @param currency - Currency code (RON, EUR)
 * @returns Compact formatted string (e.g., "5.23M RON")
 */
export function formatCompact(amount: number, currency = 'RON'): string {
  const absAmount = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (absAmount >= 1_000_000_000) {
    return `${sign}${(absAmount / 1_000_000_000).toFixed(2)}B ${currency}`;
  }
  if (absAmount >= 1_000_000) {
    return `${sign}${(absAmount / 1_000_000).toFixed(2)}M ${currency}`;
  }
  if (absAmount >= 1_000) {
    return `${sign}${(absAmount / 1_000).toFixed(2)}K ${currency}`;
  }
  return `${sign}${absAmount.toFixed(2)} ${currency}`;
}

/**
 * Formats a number in standard form with thousands separator.
 *
 * @param amount - The amount to format
 * @param currency - Currency code (RON, EUR)
 * @returns Standard formatted string (e.g., "5,234,567.89 RON")
 */
export function formatStandard(amount: number, currency = 'RON'): string {
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${formatted} ${currency}`;
}

/**
 * Creates bilingual formatted amount string.
 *
 * @param amount - The amount to format
 * @param labelRo - Romanian label
 * @param labelEn - English label
 * @param currency - Currency code
 * @returns Bilingual formatted string
 */
export function formatAmountBilingual(
  amount: number,
  labelRo: string,
  labelEn: string,
  currency = 'RON'
): string {
  const compact = formatCompact(amount, currency);
  const standard = formatStandard(amount, currency);
  return `${labelRo} / ${labelEn}: ${compact} (${standard})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// General Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generates a period range based on granularity.
 *
 * @param start - Start period
 * @param end - End period
 * @param granularity - Period granularity
 * @returns Array of periods in the range
 */
export function generatePeriodRange(
  start: string,
  end: string,
  granularity: Granularity
): string[] {
  const periods: string[] = [];

  switch (granularity) {
    case 'YEAR': {
      const startYear = parseInt(start, 10);
      const endYear = parseInt(end, 10);
      for (let year = startYear; year <= endYear; year++) {
        periods.push(String(year));
      }
      break;
    }
    case 'MONTH': {
      const [startYear, startMonth] = start.split('-').map(Number) as [number, number];
      const [endYear, endMonth] = end.split('-').map(Number) as [number, number];

      let year = startYear;
      let month = startMonth;

      while (year < endYear || (year === endYear && month <= endMonth)) {
        periods.push(`${String(year)}-${String(month).padStart(2, '0')}`);
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
      break;
    }
    case 'QUARTER': {
      const startYear = parseInt(start.substring(0, 4), 10);
      const startQuarter = parseInt(start.substring(6), 10);
      const endYear = parseInt(end.substring(0, 4), 10);
      const endQuarter = parseInt(end.substring(6), 10);

      let year = startYear;
      let quarter = startQuarter;

      while (year < endYear || (year === endYear && quarter <= endQuarter)) {
        periods.push(`${String(year)}-Q${String(quarter)}`);
        quarter++;
        if (quarter > 4) {
          quarter = 1;
          year++;
        }
      }
      break;
    }
  }

  return periods;
}

/**
 * Synthesizes a label from an analytics filter.
 * Used when no explicit label is provided for a series.
 *
 * @param filter - Analytics filter object
 * @returns Synthesized label string
 */
export function synthesizeLabelFromFilter(filter: Record<string, unknown>): string {
  const parts: string[] = [];

  // Entity scope
  if (Array.isArray(filter['entityCuis']) && filter['entityCuis'].length > 0) {
    const cuis = filter['entityCuis'] as string[];
    const firstCui = cuis[0] ?? 'unknown';
    parts.push(cuis.length === 1 ? `Entity ${firstCui}` : `${String(cuis.length)} entities`);
  }
  if (Array.isArray(filter['uatIds']) && filter['uatIds'].length > 0) {
    const uats = filter['uatIds'] as string[];
    const firstUat = uats[0] ?? 'unknown';
    parts.push(uats.length === 1 ? `UAT ${firstUat}` : `${String(uats.length)} UATs`);
  }
  if (Array.isArray(filter['countyCodes']) && filter['countyCodes'].length > 0) {
    const counties = filter['countyCodes'] as string[];
    parts.push(counties.join(', '));
  }

  // Classification scope
  if (Array.isArray(filter['functionalPrefixes']) && filter['functionalPrefixes'].length > 0) {
    const prefixes = filter['functionalPrefixes'] as string[];
    parts.push(`Fn: ${prefixes.join(', ')}`);
  }
  if (Array.isArray(filter['economicPrefixes']) && filter['economicPrefixes'].length > 0) {
    const prefixes = filter['economicPrefixes'] as string[];
    parts.push(`Ec: ${prefixes.join(', ')}`);
  }

  // Account category
  const accountCategory = filter['accountCategory'] as string | undefined;
  if (accountCategory === 'ch') {
    parts.push('Expenses');
  } else if (accountCategory === 'vn') {
    parts.push('Income');
  }

  return parts.length > 0 ? parts.join(' - ') : 'Series';
}
