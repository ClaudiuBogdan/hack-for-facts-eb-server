/**
 * Custom Span Attribute Helpers
 *
 * Provides type-safe helpers for adding business context to OpenTelemetry spans.
 * These should only be called from the shell layer (resolvers, handlers).
 *
 * Usage:
 * ```typescript
 * import { setEntityContext, setAnalyticsContext } from '@/infra/telemetry/attributes.js';
 *
 * // In a resolver
 * setEntityContext(entity.cui, entity.name);
 * setAnalyticsContext('yearly', 'per_capita');
 * ```
 */

import { trace, type Span, SpanStatusCode } from '@opentelemetry/api';

// ─────────────────────────────────────────────────────────────────────────────
// Attribute Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom attribute names for Transparenta.eu domain concepts.
 * Using a namespace prefix to avoid conflicts with standard attributes.
 */
export const ATTR = {
  // Entity attributes
  ENTITY_CUI: 'transparenta.entity.cui',
  ENTITY_NAME: 'transparenta.entity.name',
  ENTITY_TYPE: 'transparenta.entity.type',

  // UAT (Administrative Unit) attributes
  UAT_ID: 'transparenta.uat.id',
  UAT_NAME: 'transparenta.uat.name',
  UAT_COUNTY: 'transparenta.uat.county',

  // Analytics attributes
  ANALYTICS_PERIOD_TYPE: 'transparenta.analytics.period_type',
  ANALYTICS_NORMALIZATION: 'transparenta.analytics.normalization',
  ANALYTICS_YEAR: 'transparenta.analytics.year',
  ANALYTICS_QUARTER: 'transparenta.analytics.quarter',
  ANALYTICS_MONTH: 'transparenta.analytics.month',

  // Budget attributes
  BUDGET_SECTOR_ID: 'transparenta.budget.sector_id',
  BUDGET_CLASSIFICATION: 'transparenta.budget.classification',
  BUDGET_FUNDING_SOURCE: 'transparenta.budget.funding_source',

  // Query attributes
  QUERY_FILTER_COUNT: 'transparenta.query.filter_count',
  QUERY_RESULT_COUNT: 'transparenta.query.result_count',
  QUERY_PAGINATION_OFFSET: 'transparenta.query.pagination_offset',
  QUERY_PAGINATION_LIMIT: 'transparenta.query.pagination_limit',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Span Access Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the currently active span, or undefined if no span is active.
 */
const getActiveSpan = (): Span | undefined => {
  return trace.getActiveSpan();
};

// ─────────────────────────────────────────────────────────────────────────────
// Entity Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds entity context to the current span.
 * Call this from entity resolvers to enable filtering traces by entity.
 *
 * @param cui - Entity CUI (Cod Unic de Identificare)
 * @param name - Optional entity name
 * @param entityType - Optional entity type classification
 */
export const setEntityContext = (cui: string, name?: string, entityType?: string): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.ENTITY_CUI, cui);
  if (name !== undefined) {
    span.setAttribute(ATTR.ENTITY_NAME, name);
  }
  if (entityType !== undefined) {
    span.setAttribute(ATTR.ENTITY_TYPE, entityType);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UAT Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds UAT (Administrative Territorial Unit) context to the current span.
 *
 * @param uatId - UAT ID
 * @param name - Optional UAT name
 * @param county - Optional county name
 */
export const setUatContext = (uatId: number, name?: string, county?: string): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.UAT_ID, uatId);
  if (name !== undefined) {
    span.setAttribute(ATTR.UAT_NAME, name);
  }
  if (county !== undefined) {
    span.setAttribute(ATTR.UAT_COUNTY, county);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds analytics context to the current span.
 * Call this from analytics resolvers to enable filtering by query parameters.
 *
 * @param periodType - Period type (yearly, quarterly, monthly)
 * @param normalization - Normalization method (absolute, per_capita, inflation_adjusted, etc.)
 */
export const setAnalyticsContext = (periodType: string, normalization: string): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.ANALYTICS_PERIOD_TYPE, periodType);
  span.setAttribute(ATTR.ANALYTICS_NORMALIZATION, normalization);
};

/**
 * Adds period-specific attributes to the current span.
 *
 * @param year - Year
 * @param quarter - Optional quarter (1-4)
 * @param month - Optional month (1-12)
 */
export const setPeriodContext = (year: number, quarter?: number, month?: number): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.ANALYTICS_YEAR, year);
  if (quarter !== undefined) {
    span.setAttribute(ATTR.ANALYTICS_QUARTER, quarter);
  }
  if (month !== undefined) {
    span.setAttribute(ATTR.ANALYTICS_MONTH, month);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Budget Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds budget sector context to the current span.
 *
 * @param sectorId - Budget sector ID
 */
export const setBudgetSectorContext = (sectorId: number): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.BUDGET_SECTOR_ID, sectorId);
};

/**
 * Adds budget classification context to the current span.
 *
 * @param classification - Classification code
 * @param fundingSource - Optional funding source
 */
export const setBudgetClassificationContext = (
  classification: string,
  fundingSource?: string
): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.BUDGET_CLASSIFICATION, classification);
  if (fundingSource !== undefined) {
    span.setAttribute(ATTR.BUDGET_FUNDING_SOURCE, fundingSource);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Query Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds query result metadata to the current span.
 * Call this after a query completes to record pagination and result info.
 *
 * @param resultCount - Number of results returned
 * @param offset - Pagination offset
 * @param limit - Pagination limit
 */
export const setQueryResultContext = (
  resultCount: number,
  offset?: number,
  limit?: number
): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.QUERY_RESULT_COUNT, resultCount);
  if (offset !== undefined) {
    span.setAttribute(ATTR.QUERY_PAGINATION_OFFSET, offset);
  }
  if (limit !== undefined) {
    span.setAttribute(ATTR.QUERY_PAGINATION_LIMIT, limit);
  }
};

/**
 * Records the number of active filters in a query.
 *
 * @param filterCount - Number of non-null filter parameters
 */
export const setFilterCount = (filterCount: number): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(ATTR.QUERY_FILTER_COUNT, filterCount);
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Recording
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records an error on the current span.
 * Use this for domain errors that should be visible in traces.
 *
 * @param error - Error object or message
 * @param errorType - Optional error type classification
 */
export const recordError = (error: Error | string, errorType?: string): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  if (typeof error === 'string') {
    span.recordException(new Error(error));
  } else {
    span.recordException(error);
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: typeof error === 'string' ? error : error.message,
  });

  if (errorType !== undefined) {
    span.setAttribute('error.type', errorType);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Generic Attribute Setter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets a custom attribute on the current span.
 * Use this for ad-hoc attributes not covered by the helpers above.
 *
 * @param key - Attribute key (should be namespaced, e.g., "transparenta.custom.xyz")
 * @param value - Attribute value (string, number, or boolean)
 */
export const setAttribute = (key: string, value: string | number | boolean): void => {
  const span = getActiveSpan();
  if (span === undefined) return;

  span.setAttribute(key, value);
};
