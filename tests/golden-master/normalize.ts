/**
 * Number normalization shared by the snapshot matcher (setup.ts) and the
 * cutover comparison (compare.ts). Kept side-effect free so compare.ts can
 * import it without pulling in the vitest hooks that setup.ts registers.
 */

/**
 * Number of decimal places to round floating-point numbers for comparison.
 * This is a temporary fix until precision can be configured from the API.
 *
 * FIXME: In the future, precision should come from the API response metadata.
 * For now, we use 2 decimal places which is sufficient for financial data display.
 */
export const COMPARISON_DECIMAL_PLACES = 2;

/**
 * Recursively rounds all numbers in an object to the specified decimal places.
 * This normalizes floating-point precision differences between prod and local.
 *
 * @param obj - The object to normalize
 * @param decimalPlaces - Number of decimal places (default: COMPARISON_DECIMAL_PLACES)
 * @returns A new object with all numbers rounded
 */
export function normalizeNumbers<T>(obj: T, decimalPlaces: number = COMPARISON_DECIMAL_PLACES): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'number') {
    // Round to specified decimal places
    const factor = Math.pow(10, decimalPlaces);
    return (Math.round(obj * factor) / factor) as T;
  }

  if (Array.isArray(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Generic recursion requires any
    return obj.map((item) => normalizeNumbers(item, decimalPlaces)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = normalizeNumbers(value, decimalPlaces);
    }
    return result as T;
  }

  return obj;
}
