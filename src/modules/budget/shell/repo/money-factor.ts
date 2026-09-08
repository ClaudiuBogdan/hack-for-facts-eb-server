/** Exact reporting-year factors for native single-year reads. */
import { err, ok, type Result } from 'neverthrow';

import { yearMultiplier } from './analytics.js';
import { loadMoneyContext } from '../../core/legacy-analytics/money-context.js';
import { exactYearMoneyMultipliers } from '../../core/legacy-analytics/yearly-multipliers.js';

import type { BudgetNormalization } from '../../core/constants.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { NormalizationPlan } from '../../core/legacy-analytics/types.js';
import type { ApiError } from '@/modules/shared/index.js';

export const singleYearMoneyFactor = async (
  source: FactorSource | undefined,
  normalization: BudgetNormalization,
  year: number
): Promise<Result<string, ApiError>> => {
  // Omitted dependency is the explicit compatibility path, never an error fallback.
  if (source === undefined) return ok(String(yearMultiplier(normalization, year)));
  if (normalization === 'TOTAL' || normalization === 'PER_CAPITA') return ok('1');
  const plan: NormalizationPlan = {
    mode: normalization === 'PERCENT_GDP' ? 'percent_gdp' : 'total',
    currency: normalization === 'PERCENT_GDP' ? 'RON' : 'EUR',
    inflationAdjusted: false,
    showPeriodGrowth: false,
  };
  const context = await loadMoneyContext(source, plan);
  if (context.isErr()) return err(context.error);
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
