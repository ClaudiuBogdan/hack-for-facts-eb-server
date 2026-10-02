/**
 * Companies analytics — exact decimal arithmetic (BigInt only, never floats).
 *
 * Money is `Decimal(18, 2)` in the release and is carried as an integer of
 * bani (scale 2). Headcounts are integers. ClickHouse may print a decimal
 * without trailing zeros (`12.5`, `7`), so parsing accepts 0–2 fractional
 * digits and formatting always writes exactly two.
 */

import type { CompanyAnalysisUnit } from './analytics-types.js';

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u;
const INTEGER_RE = /^-?\d+$/u;
const COUNT_RE = /^\d+$/u;

/** A decimal string → bani; null when the text is not an exact 2-place decimal. */
export const parseMoney = (raw: string): bigint | null => {
  const match = MONEY_RE.exec(raw);
  if (match === null) return null;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -value : value;
};

export const parseInteger = (raw: string): bigint | null =>
  INTEGER_RE.test(raw) ? BigInt(raw) : null;

export const parseCount = (raw: string): bigint | null => (COUNT_RE.test(raw) ? BigInt(raw) : null);

/** A value in the metric's own unit → its scaled integer (bani or heads). */
export const parseMetricValue = (raw: string, unit: CompanyAnalysisUnit): bigint | null =>
  unit === 'RON' ? parseMoney(raw) : parseInteger(raw);

const formatTwoPlaces = (scaled: bigint): string => {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/** Scaled integer → canonical text: money with exactly 2 places, headcount as an integer. */
export const formatMetricValue = (scaled: bigint, unit: CompanyAnalysisUnit): string =>
  unit === 'RON' ? formatTwoPlaces(scaled) : scaled.toString();

/** Integer division rounded half away from zero. `denominator` must be positive. */
const divideRounded = (numerator: bigint, denominator: bigint): bigint => {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice < denominator) return quotient;
  return numerator < 0n ? quotient - 1n : quotient + 1n;
};

/**
 * The mean over contributors, 2 decimals, half away from zero. Null without
 * contributors (an empty set has no mean; it is never 0).
 */
export const meanOf = (
  sumScaled: bigint | null,
  contributors: bigint,
  unit: CompanyAnalysisUnit
): string | null => {
  if (sumScaled === null || contributors === 0n) return null;
  const hundredths = unit === 'RON' ? sumScaled : sumScaled * 100n;
  return formatTwoPlaces(divideRounded(hundredths, contributors));
};

/** Bounds a range value may take in each unit (the column types' exact range). */
const MONEY_ABS_LIMIT = 10n ** 18n; // Decimal(18, 2): |bani| < 10^18
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** True when the scaled value fits the release column type of the unit. */
export const fitsColumn = (scaled: bigint, unit: CompanyAnalysisUnit): boolean =>
  unit === 'RON'
    ? scaled > -MONEY_ABS_LIMIT && scaled < MONEY_ABS_LIMIT
    : scaled >= INT64_MIN && scaled <= INT64_MAX;
