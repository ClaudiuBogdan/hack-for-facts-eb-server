/**
 * Decimal.js-aware JSON serialization for cache values.
 * Preserves financial precision across serialization boundaries.
 */

import { Decimal } from 'decimal.js';

import { CacheError } from './ports.js';

const DECIMAL_MARKER = '__decimal__';

/**
 * Check if a value is a Decimal instance.
 */
const isDecimal = (val: unknown): val is Decimal => {
  return val !== null && typeof val === 'object' && val instanceof Decimal;
};

/**
 * Recursively transform an object, replacing Decimal instances with marked objects.
 * Must be done before JSON.stringify because Decimal.toJSON() is called first.
 */
const transformDecimals = (value: unknown): unknown => {
  if (isDecimal(value)) {
    return { [DECIMAL_MARKER]: value.toString() };
  }

  if (Array.isArray(value)) {
    return value.map(transformDecimals);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = transformDecimals(val);
    }
    return result;
  }

  return value;
};

/**
 * Serialize a value to JSON string, preserving Decimal instances.
 */
export const serialize = (value: unknown): string => {
  const transformed = transformDecimals(value);
  return JSON.stringify(transformed);
};

/**
 * Deserialize a JSON string, restoring Decimal instances.
 * Returns a Result to handle parse errors.
 */
export const deserialize = (
  json: string
): { ok: true; value: unknown } | { ok: false; error: CacheError } => {
  try {
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse is wrapped in try-catch with proper error handling
    const value = JSON.parse(json, (_key, val: unknown) => {
      if (val !== null && typeof val === 'object' && DECIMAL_MARKER in val) {
        const decimalVal = val as { [DECIMAL_MARKER]: string };
        return new Decimal(decimalVal[DECIMAL_MARKER]);
      }
      return val;
    }) as unknown;
    return { ok: true, value };
  } catch (cause) {
    return {
      ok: false,
      error: CacheError.serialization('Failed to deserialize cached value', cause),
    };
  }
};
