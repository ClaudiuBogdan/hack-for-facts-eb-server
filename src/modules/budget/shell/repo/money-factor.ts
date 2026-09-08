/** Exact reporting-year factors for native single-year reads. */
import { err, ok, type Result } from 'neverthrow';

import { yearMultiplier } from './analytics.js';
import { loadMoneyContext } from '../../core/legacy-analytics/money-context.js';
import { exactYearMoneyMultipliers } from '../../core/legacy-analytics/yearly-multipliers.js';

import type { BudgetNormalization } from '../../core/constants.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { NormalizationPlan } from '../../core/legacy-analytics/types.js';
import type { ApiError } from '@/modules/shared/index.js';

export const availableSingleYearMoneyFactor = async (
  source: FactorSource,
  normalization: BudgetNormalization,
  year: number
): Promise<Result<string | null, ApiError>> => {
  if (normalization === 'TOTAL' || normalization === 'PER_CAPITA') return ok('1');
  const plan: NormalizationPlan = {
    mode: normalization === 'PERCENT_GDP' ? 'percent_gdp' : 'total',
    currency: normalization === 'PERCENT_GDP' ? 'RON' : 'EUR',
    inflationAdjusted: false,
    showPeriodGrowth: false,
  };
  const context = await loadMoneyContext(source, plan);
  if (context.isErr()) return err(context.error);
  const series = plan.mode === 'percent_gdp' ? context.value.gdp : context.value.fxRate;
  if (series === undefined)
    return err({ type: 'ServiceUnavailable', message: 'Missing monetary factor kind' });
  if (!series.has(year)) return ok(null);
  return exactYearMoneyMultipliers(plan, context.value, [year]).andThen(
    (factors): Result<string, ApiError> => {
      const factor = factors.get(year);
      return factor === undefined
        ? err({
            type: 'ServiceUnavailable',
            message: `Missing monetary factor for ${String(year)}`,
          })
        : ok(factor.toFixed());
    }
  );
};

/** Strict consumers reject gaps; availability consumers keep them distinct from admission failures. */
export const singleYearMoneyFactor = async (
  source: FactorSource | undefined,
  normalization: BudgetNormalization,
  year: number
): Promise<Result<string, ApiError>> => {
  // Omitted dependency is the explicit compatibility path, never an error fallback.
  if (source === undefined) return ok(String(yearMultiplier(normalization, year)));
  const result = await availableSingleYearMoneyFactor(source, normalization, year);
  if (result.isErr()) return err(result.error);
  return result.value === null
    ? err({
        type: 'ServiceUnavailable',
        message: `Monetary factor is unavailable for ${String(year)}`,
      })
    : ok(result.value);
};
