/** Exact reporting-year factors for native single-year reads. */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { factorCaseExpr, yearMultiplier } from './analytics.js';
import { loadMoneyContext } from '../../core/legacy-analytics/money-context.js';
import { exactYearMoneyMultipliers } from '../../core/legacy-analytics/yearly-multipliers.js';

import type { BudgetNormalization } from '../../core/constants.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { NormalizationPlan } from '../../core/legacy-analytics/types.js';
import type { ApiError } from '@/modules/shared/index.js';

/** Resolve distinct exact years from one admitted context; absent years remain sparse. */
export const availableYearMoneyFactors = async (
  source: FactorSource,
  normalization: BudgetNormalization,
  years: readonly number[]
): Promise<Result<ReadonlyMap<number, string>, ApiError>> => {
  const distinctYears = [...new Set(years)];
  if (distinctYears.length === 0) return ok(new Map());
  if (normalization === 'TOTAL' || normalization === 'PER_CAPITA')
    return ok(new Map(distinctYears.map((year) => [year, '1'])));
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
  return exactYearMoneyMultipliers(
    plan,
    context.value,
    distinctYears.filter((year) => series.has(year))
  ).map((factors) => new Map([...factors].map(([year, factor]) => [year, factor.toFixed()])));
};

export const availableSingleYearMoneyFactor = async (
  source: FactorSource,
  normalization: BudgetNormalization,
  year: number
): Promise<Result<string | null, ApiError>> =>
  (await availableYearMoneyFactors(source, normalization, [year])).map(
    (factors) => factors.get(year) ?? null
  );

/** Native missing years produce no point; compatibility keeps its existing factors. */
export const seriesMoneyFactor = async (
  source: FactorSource | undefined,
  normalization: BudgetNormalization,
  years: readonly number[]
): Promise<Result<RawBuilder<unknown>, ApiError>> => {
  if (source === undefined) return ok(factorCaseExpr(years, normalization));
  if (normalization === 'TOTAL' || normalization === 'PER_CAPITA') return ok(sql`1::numeric`);
  return (await availableYearMoneyFactors(source, normalization, years)).map((factors) => {
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
