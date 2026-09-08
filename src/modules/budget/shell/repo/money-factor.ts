/** Exact reporting-year factors for native single-year reads. */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { factorCaseExpr, yearMultiplier } from './analytics.js';
import { loadMoneyContext } from '../../core/legacy-analytics/money-context.js';
import { exactYearMoneyMultipliers } from '../../core/legacy-analytics/yearly-multipliers.js';
import {
  budgetMoneyPlan,
  needsMoneyFactor,
  type BudgetMoneyOptions,
} from '../../core/money-options.js';

import type { BudgetNormalization } from '../../core/constants.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

/** Resolve distinct exact years from one admitted context; absent years remain sparse. */
export const availableYearMoneyFactors = async (
  source: FactorSource,
  normalization: BudgetNormalization,
  years: readonly number[],
  options: BudgetMoneyOptions = {}
): Promise<Result<ReadonlyMap<number, string>, ApiError>> => {
  const distinctYears = [...new Set(years)];
  if (distinctYears.length === 0) return ok(new Map());
  if (!needsMoneyFactor(normalization, options))
    return ok(new Map(distinctYears.map((year) => [year, '1'])));
  const plan = budgetMoneyPlan(normalization, options);
  const context = await loadMoneyContext(source, plan);
  if (context.isErr()) return err(context.error);
  const required =
    plan.mode === 'percent_gdp'
      ? [context.value.gdp]
      : [
          ...(plan.inflationAdjusted ? [context.value.cpiIndex] : []),
          ...(plan.currency !== 'RON' ? [context.value.fxRate] : []),
        ];
  for (const series of required) {
    if (series === undefined)
      return err({ type: 'ServiceUnavailable', message: 'Missing monetary factor kind' });
    if ([...series.values()].some((value) => !value.isFinite() || value.lte(0)))
      return err({ type: 'ServiceUnavailable', message: 'Invalid monetary factor value' });
  }
  if (plan.inflationAdjusted && context.value.cpiIndex?.size === 0)
    return err({ type: 'ServiceUnavailable', message: 'CPI base year is unavailable' });
  const baseYear =
    context.value.cpiIndex === undefined ? undefined : Math.max(...context.value.cpiIndex.keys());
  const eligible = distinctYears.filter((year) => {
    if (plan.mode === 'percent_gdp') return context.value.gdp?.has(year) === true;
    if (plan.inflationAdjusted && context.value.cpiIndex?.has(year) !== true) return false;
    if (plan.currency === 'RON') return true;
    const rateYear = plan.inflationAdjusted ? baseYear : year;
    return rateYear !== undefined && context.value.fxRate?.has(rateYear) === true;
  });
  return exactYearMoneyMultipliers(plan, context.value, eligible, 'cpi-base-year').map(
    (factors) => new Map([...factors].map(([year, factor]) => [year, factor.toFixed()]))
  );
};

export const availableSingleYearMoneyFactor = async (
  source: FactorSource,
  normalization: BudgetNormalization,
  year: number,
  options: BudgetMoneyOptions = {}
): Promise<Result<string | null, ApiError>> =>
  (await availableYearMoneyFactors(source, normalization, [year], options)).map(
    (factors) => factors.get(year) ?? null
  );

/** Native missing years produce no point; compatibility keeps its existing factors. */
export const seriesMoneyFactor = async (
  source: FactorSource | undefined,
  normalization: BudgetNormalization,
  years: readonly number[],
  options: BudgetMoneyOptions = {}
): Promise<Result<RawBuilder<unknown>, ApiError>> => {
  if (source === undefined) {
    if (options.inflationAdjusted === true || options.currency !== undefined)
      return err({
        type: 'ServiceUnavailable',
        message: 'Native monetary options are unavailable',
      });
    return ok(factorCaseExpr(years, normalization));
  }
  if (!needsMoneyFactor(normalization, options)) return ok(sql`1::numeric`);
  return (await availableYearMoneyFactors(source, normalization, years, options)).map((factors) => {
    const whens = [...factors].map(
      ([year, factor]) => sql`when mv.year = ${year} then ${factor}::numeric`
    );
    return whens.length === 0
      ? sql`null::numeric`
      : sql`(case ${sql.join(whens, sql` `)} else null::numeric end)`;
  });
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
