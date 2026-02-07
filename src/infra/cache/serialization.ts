/**
 * Decimal.js-aware JSON serialization for cache values.
 * Preserves financial precision across serialization boundaries.
 */

import { Decimal } from 'decimal.js';

import { CacheError } from './ports.js';

const DECIMAL_MARKER = '__decimal__';
const DATE_MARKER = '__date__';

/**
 * Check if parsed JSON value is an exact marker object.
 * Marker revival only applies when the object has exactly one marker key.
 */
const isExactMarkerObject = <TMarker extends string>(
  val: unknown,
  marker: TMarker
): val is Record<TMarker, string> => {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }

  const record = val as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== marker) {
    return false;
  }

  return typeof record[marker] === 'string';
};

/**
 * Check if a value is a Decimal instance.
 */
const isDecimal = (val: unknown): val is Decimal => {
  return val !== null && typeof val === 'object' && val instanceof Decimal;
};

/**
 * Check if a value is a Date instance.
 */
const isDate = (val: unknown): val is Date => {
  return val !== null && typeof val === 'object' && val instanceof Date;
};

/**
 * Recursively transform an object, replacing special instances with marked objects.
 * Must be done before JSON.stringify because Decimal.toJSON() is called first.
 */
const transformDecimals = (value: unknown): unknown => {
  if (isDecimal(value)) {
    return { [DECIMAL_MARKER]: value.toString() };
  }

  if (isDate(value)) {
    return { [DATE_MARKER]: value.toISOString() };
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
 * Deserialize a JSON string, restoring special instances.
 * Returns a Result to handle parse errors.
 */
export const deserialize = (
  json: string
): { ok: true; value: unknown } | { ok: false; error: CacheError } => {
  try {
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse is wrapped in try-catch with proper error handling
    const value = JSON.parse(json, (_key, val: unknown) => {
      if (isExactMarkerObject(val, DECIMAL_MARKER)) {
        return new Decimal(val[DECIMAL_MARKER]);
      }
      if (isExactMarkerObject(val, DATE_MARKER)) {
        return new Date(val[DATE_MARKER]);
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
