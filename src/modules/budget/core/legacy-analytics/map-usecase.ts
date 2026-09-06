/** Each year is normalized before interval aggregation; incomplete territories stay null. */
import { err, ok, type Result } from 'neverthrow';

import { invalidInput, serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { cleanFilter } from './clean.js';
import { legacyDecimal } from './decimal.js';
import { loadMoneyContext } from './money-context.js';
import { computeCpiFactors, resolveNormalizationPlan, resultAxis } from './normalize.js';
import { exactYearMoneyMultipliers } from './yearly-multipliers.js';

import type {
  BudgetMapInput,
  BudgetMapPopulationSource,
  BudgetMapRepo,
  BudgetMapResult,
} from './map-types.js';
import type { FactorSource } from './ports.js';
import type { Decimal } from 'decimal.js';

export interface BudgetMapDeps {
  readonly repo: BudgetMapRepo;
  readonly factors: FactorSource;
  readonly population: BudgetMapPopulationSource;
}

const positiveDecimal = (value: string | null | undefined): Decimal | null => {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const decimal = legacyDecimal(value);
  return decimal.isFinite() && decimal.gt(0) ? decimal : null;
};

export const budgetMapValues = async (
  deps: BudgetMapDeps,
  input: BudgetMapInput
): Promise<Result<BudgetMapResult, ApiError>> => {
  const query = cleanFilter(input.filter);
  if (query.isErr()) return err(query.error);
  const plan = resolveNormalizationPlan(input.filter);
  if (plan.showPeriodGrowth)
    return err(
      invalidInput('Period growth cannot be aggregated into a map interval', 'show_period_growth')
    );
  const result = await deps.repo.yearlyAmounts(query.value, input.granularity);
  if (result.isErr()) return err(result.error);
  const rows = result.value;
  if (
    rows.some(
      (row) => typeof row.nominalAmount !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(row.nominalAmount)
    )
  )
    return err(serviceUnavailable('Selected map amounts are incomplete or invalid'));
  const mapped = rows.filter((row) => row.coverage === 'mapped');
  const context = await loadMoneyContext(deps.factors, plan);
  if (context.isErr()) return err(context.error);
  const years = [...new Set(mapped.map((row) => row.year))];
  const multipliers = new Map<number, Decimal>();
  // Missing exact-year factors are coverage gaps for that year. Adapter/manifest
  // failures above still fail the request; a corrupt factor set is not a data gap.
  for (const year of years) {
    const multiplier = exactYearMoneyMultipliers(plan, context.value, [year]);
    if (multiplier.isOk()) {
      const value = multiplier.value.get(year);
      if (value !== undefined) multipliers.set(year, value);
    }
  }
  const populations =
    plan.mode === 'per_capita' ? await deps.population.annualUnions(mapped) : ok([]);
  if (populations.isErr()) return err(populations.error);
  const populationByKey = new Map<string, Decimal | null>();
  for (const row of populations.value) {
    const key = `${row.territoryCode}:${String(row.year)}`;
    if (populationByKey.has(key)) return err(serviceUnavailable('Ambiguous annual map population'));
    populationByKey.set(key, positiveDecimal(row.population));
  }
  const totals = new Map<string, { amount: Decimal; missingYears: Set<number> }>();
  const seen = new Set<string>();
  for (const row of mapped) {
    const code = row.territoryCode;
    if (code === null) return err(serviceUnavailable('Map territory identity is unavailable'));
    const key = `${code}:${String(row.year)}`;
    if (seen.has(key)) return err(serviceUnavailable('Duplicate map territory/year'));
    seen.add(key);
    const total = totals.get(code) ?? { amount: legacyDecimal(0), missingYears: new Set<number>() };
    const multiplier = multipliers.get(row.year);
    const population = plan.mode === 'per_capita' ? populationByKey.get(key) : legacyDecimal(1);
    if (multiplier === undefined || population == null) total.missingYears.add(row.year);
    else
      total.amount = total.amount.plus(
        legacyDecimal(row.nominalAmount).mul(multiplier).div(population)
      );
    totals.set(code, total);
  }
  const cpiBaseYear =
    context.value.cpiIndex === undefined
      ? null
      : (computeCpiFactors(context.value.cpiIndex)?.baseYear ?? null);
  return ok({
    unit: resultAxis(plan, cpiBaseYear).unit,
    values: [...totals].map(([territoryCode, total]) => {
      // User decision: limits apply to the final territory result, in its output
      // unit, after all selected institutions/years and normalization.
      const outsideBounds =
        (query.value.aggregateMinAmount !== undefined &&
          total.amount.lt(query.value.aggregateMinAmount)) ||
        (query.value.aggregateMaxAmount !== undefined &&
          total.amount.gt(query.value.aggregateMaxAmount));
      const status =
        total.missingYears.size > 0
          ? 'unavailable'
          : outsideBounds
            ? 'outside_bounds'
            : 'available';
      return {
        territoryCode,
        value: status === 'available' ? total.amount.toFixed() : null,
        status,
        missingYears: [...total.missingYears].sort((a, b) => a - b),
      };
    }),
    years: rows,
    populations: populations.value,
  });
};
