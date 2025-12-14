import type { TransformationOptions } from './types.js';
import type { Currency, NormalizationMode } from '@/common/types/analytics.js';

/**
 * GraphQL Normalization enum values (legacy + current).
 *
 * This enum mixes "mode" (total/per_capita/percent_gdp) with legacy
 * currency shortcuts (total_euro/per_capita_euro).
 */
export type GqlNormalization =
  | 'total'
  | 'total_euro'
  | 'per_capita'
  | 'per_capita_euro'
  | 'percent_gdp';

export interface NormalizationRequestInput {
  normalization?: GqlNormalization | null;
  currency?: Currency | null;
  inflationAdjusted?: boolean | null;
  showPeriodGrowth?: boolean | null;
}

export interface ResolvedNormalizationRequest {
  normalization: NormalizationMode;
  currency: Currency;
  inflationAdjusted: boolean;
  showPeriodGrowth: boolean;
  /**
   * Transformation options suitable for NormalizationService.normalize().
   *
   * Note: for per-capita requests, this sets `normalization: 'total'` so that
   * callers can apply the appropriate population denominator separately
   * (entity-specific or filter-specific).
   */
  transformation: TransformationOptions;
  /**
   * True when the requested normalization is per-capita and callers must divide
   * by a population denominator outside of the core normalization service.
   */
  requiresExternalPerCapitaDivision: boolean;
}

const resolveLegacyModeAndCurrency = (
  gqlNorm: GqlNormalization | null | undefined
): { normalization: NormalizationMode; currency: Currency } => {
  switch (gqlNorm) {
    case 'total_euro':
      return { normalization: 'total', currency: 'EUR' };
    case 'per_capita':
      return { normalization: 'per_capita', currency: 'RON' };
    case 'per_capita_euro':
      return { normalization: 'per_capita', currency: 'EUR' };
    case 'percent_gdp':
      return { normalization: 'percent_gdp', currency: 'RON' };
    case 'total':
    default:
      return { normalization: 'total', currency: 'RON' };
  }
};

/**
 * Resolves a consistent normalization request from:
 * - legacy GraphQL Normalization enum
 * - explicit currency / inflation / growth options
 *
 * Precedence:
 * - `currency` overrides the legacy-derived currency for `total`/`per_capita`
 * - `percent_gdp` ignores currency and inflation adjustment at execution time
 */
export const resolveNormalizationRequest = (
  input: NormalizationRequestInput
): ResolvedNormalizationRequest => {
  const legacy = resolveLegacyModeAndCurrency(input.normalization);

  const inflationAdjusted = input.inflationAdjusted === true;
  const showPeriodGrowth = input.showPeriodGrowth === true;

  const requestedNormalization = legacy.normalization;

  const resolvedCurrency =
    requestedNormalization === 'percent_gdp' ? 'RON' : (input.currency ?? legacy.currency);

  const requiresExternalPerCapitaDivision = requestedNormalization === 'per_capita';

  const transformation: TransformationOptions = {
    inflationAdjusted,
    currency: resolvedCurrency,
    normalization: requiresExternalPerCapitaDivision ? 'total' : requestedNormalization,
    showPeriodGrowth,
  };

  return {
    normalization: requestedNormalization,
    currency: resolvedCurrency,
    inflationAdjusted,
    showPeriodGrowth,
    transformation,
    requiresExternalPerCapitaDivision,
  };
};
