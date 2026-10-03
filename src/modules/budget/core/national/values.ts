/**
 * National budget — exact values.
 *
 * Source amounts arrive as PostgreSQL numeric text. They are held as `Decimal`
 * and leave as `Decimal.toFixed()`, which equals `trim_scale(value)::text`; no
 * float is ever produced. Constructing a Decimal from text is exact; only
 * arithmetic is bounded by precision. The legacy analytics clone (40 digits)
 * would round the thousand-lei → RON product of an observed 43-digit value, so
 * this module uses its own clone for the only arithmetic it performs: a
 * multiplication by 1,000. Scaling by a power of ten keeps the significant
 * digits, so the product is exact whenever the input has at most `precision`
 * of them; the parse bound below guarantees that.
 */

import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { type DataSeries } from '@/common/types/temporal.js';

export const NationalDecimal = Decimal.clone({
  precision: 1000,
  rounding: Decimal.ROUND_HALF_EVEN,
});

/** Largest accepted significant-digit count (below the clone precision). */
export const MAX_SIGNIFICANT_DIGITS = 900;

/** Plain numeric text: optional minus, digits, optional fraction. No exponent/sign/space. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/u;

export interface SourceValueError {
  readonly kind: 'NOT_NUMERIC_TEXT' | 'TOO_MANY_DIGITS';
  readonly raw: string;
}

/** Parse numeric source text exactly. Trailing zeros are accepted and canonicalised. */
export const parseSourceDecimal = (raw: string): Result<Decimal, SourceValueError> => {
  if (!NUMERIC_TEXT.test(raw)) return err({ kind: 'NOT_NUMERIC_TEXT', raw });
  const value = new NationalDecimal(raw);
  if (value.sd(true) > MAX_SIGNIFICANT_DIGITS) return err({ kind: 'TOO_MANY_DIGITS', raw });
  return ok(value);
};

/** Wire form: `toFixed()` (no exponent, no trailing zeros); zero is always `0`. */
export const toWireDecimal = (value: Decimal): string => (value.isZero() ? '0' : value.toFixed());

const THOUSAND = new NationalDecimal(1000);

/**
 * Project a native law amount (thousand lei, parsed by `parseSourceDecimal`)
 * into the requested unit. RON is an exact multiplication by 1,000;
 * THOUSAND_LEI is the identity.
 */
export const projectLawAmount = (thousandLei: Decimal, unit: 'THOUSAND_LEI' | 'RON'): Decimal =>
  unit === 'RON' ? new NationalDecimal(thousandLei).times(THOUSAND) : thousandLei;

export interface WireDataPoint {
  readonly date: string;
  readonly value: string;
}

export interface WireDataSeries {
  readonly frequency: DataSeries['frequency'];
  readonly data: readonly WireDataPoint[];
}

/** The common `DataSeries` on the wire: exact `toFixed()` strings, order kept. */
export const toWireDataSeries = (series: DataSeries): WireDataSeries => ({
  frequency: series.frequency,
  data: series.data.map((point) => ({ date: point.date, value: toWireDecimal(point.value) })),
});
