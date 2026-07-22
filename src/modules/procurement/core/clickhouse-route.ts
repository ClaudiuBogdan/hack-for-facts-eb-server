/**
 * Routing for the ClickHouse dev backend (2026-07-22).
 *
 * Under ClickHouse the capability contract collapses to "any subset of the
 * published dims is valid" (analytics v3 design): the wide fact tables serve
 * arbitrary conjunctions, so the rollup matrix's geography rejections
 * (buyerCounty / supplierCounty / supplierRegion — combinations.ts wave-2/M3
 * TODOs) do not apply. Everything else — shape validation, dimension
 * pinning, per-grain exclusions, grain fan-out — is still delegated to
 * `routeAnalysis` so the two backends disagree ONLY where ClickHouse is
 * genuinely more capable. The repo receives the ORIGINAL scope and applies
 * the geography dims in SQL; only the validation copy is stripped.
 */

import { routeAnalysis } from './combinations.js';

/** Dims the rollup matrix rejects but the ClickHouse fact tables serve. */
const CLICKHOUSE_EXTRA_DIMS = [
  'buyerCounty',
  'buyerRegion',
  'buyerSiruta',
  'supplierCounty',
  'supplierRegion',
] as const;

/** New geo breakdown dims validate as buyerRegion (same class; matrix has no rows for them). */
const DIMENSION_VALIDATION_ALIAS: Record<string, 'buyerRegion'> = {
  buyerCounty: 'buyerRegion',
  buyerSiruta: 'buyerRegion',
};

export const clickhouseRouteAnalysis: typeof routeAnalysis = (scope, shape, dimension, measure) => {
  const validationScope = Object.fromEntries(
    Object.entries(scope).filter(
      ([key]) => !(CLICKHOUSE_EXTRA_DIMS as readonly string[]).includes(key)
    )
  );
  const validationDimension =
    dimension !== undefined ? (DIMENSION_VALIDATION_ALIAS[dimension] ?? dimension) : undefined;
  return routeAnalysis(validationScope, shape, validationDimension, measure);
};
