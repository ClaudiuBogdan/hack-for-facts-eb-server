/**
 * Pagination Constants
 *
 * SECURITY: SEC-006 - Centralized pagination limits for all modules.
 * Prevents DoS attacks via unbounded data fetching.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default number of records per page */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum allowed records per page */
export const MAX_PAGE_SIZE = 100;

/** Default offset for pagination */
export const DEFAULT_OFFSET = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a limit value to the allowed range.
 *
 * SECURITY: SEC-006 - Enforces maximum pagination limit
 * Silently clamps values that exceed the maximum rather than throwing errors.
 * This provides a better UX while still protecting against abuse.
 *
 * @param limit - Requested limit (may be undefined or exceed max)
 * @param defaultValue - Default if limit is undefined
 * @param maxValue - Maximum allowed value
 * @returns Clamped limit value
 *
 * @example
 * clampLimit(undefined)    // Returns 20 (default)
 * clampLimit(50)           // Returns 50
 * clampLimit(500)          // Returns 100 (max)
 * clampLimit(-1)           // Returns 1 (min)
 */
export function clampLimit(
  limit: number | undefined | null,
  defaultValue: number = DEFAULT_PAGE_SIZE,
  maxValue: number = MAX_PAGE_SIZE
): number {
  if (limit === undefined || limit === null) {
    return defaultValue;
  }
  return Math.min(Math.max(1, limit), maxValue);
}

/**
 * Validates and clamps pagination parameters.
 *
 * @param params - Pagination parameters to normalize
 * @returns Normalized pagination with clamped limit and valid offset
 */
export function normalizePagination(params: { limit?: number | null; offset?: number | null }): {
  limit: number;
  offset: number;
} {
  return {
    limit: clampLimit(params.limit),
    offset: Math.max(0, params.offset ?? DEFAULT_OFFSET),
  };
}
