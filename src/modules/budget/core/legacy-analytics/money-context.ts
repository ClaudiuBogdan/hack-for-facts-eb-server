/** Load monetary reference series once; each consumer owns its coverage policy. */
import { err, ok, type Result } from 'neverthrow';

import type { NormalizationContext } from './normalize.js';
import type { FactorSource } from './ports.js';
import type { NormalizationPlan } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export const loadMoneyContext = async (
  factors: FactorSource,
  plan: NormalizationPlan
): Promise<Result<NormalizationContext, ApiError>> => {
  if (plan.mode === 'percent_gdp') {
    const gdp = await factors.yearly('gdp_ron');
    if (gdp.isErr()) return err(gdp.error);
    return ok(gdp.value === null ? {} : { gdp: gdp.value });
  }
  let context: NormalizationContext = {};
  if (plan.inflationAdjusted) {
    const cpi = await factors.yearly('cpi_index');
    if (cpi.isErr()) return err(cpi.error);
    if (cpi.value !== null) context = { ...context, cpiIndex: cpi.value };
  }
  if (plan.currency !== 'RON') {
    const fx = await factors.yearly(plan.currency === 'EUR' ? 'ron_per_eur' : 'ron_per_usd');
    if (fx.isErr()) return err(fx.error);
    if (fx.value !== null) context = { ...context, fxRate: fx.value };
  }
  return ok(context);
};
