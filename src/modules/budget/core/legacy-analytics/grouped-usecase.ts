import { err, ok, type Result } from 'neverthrow';

import { invalidInput, serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { cleanFilter } from './clean.js';
import { legacyDecimal } from './decimal.js';
import {
  GROUPED_MAX_LIMIT,
  ENTITY_SORT_FIELDS,
  type EntitySortField,
  type GroupedInput,
  type GroupedQuery,
  type GroupedAnalyticsRepo,
  type GroupedPage,
  type GroupedEntity,
  type GroupedClassification,
} from './grouped-types.js';
import { loadMoneyContext } from './money-context.js';
import { resolveNormalizationPlan } from './normalize.js';
import { resolveGroupedPopulationScope } from './population.js';
import { exactYearMoneyMultipliers } from './yearly-multipliers.js';

import type { FactorSource, PopulationSource } from './ports.js';
import type { PeriodPlan } from './types.js';

export interface GroupedAnalyticsDeps {
  readonly grouped: GroupedAnalyticsRepo;
  readonly factors: FactorSource;
  readonly population: PopulationSource;
  readonly onClamped?: (info: { requested: number; clamp: number }) => void;
}

/** Intersect the bounded year plan with any additional sparse-period selection. */
export const groupedYears = (period: PeriodPlan): readonly number[] => {
  const years =
    'in' in period.years
      ? [...period.years.in]
      : Array.from({ length: Math.max(0, period.years.to - period.years.from + 1) }, (_, i) =>
          'in' in period.years ? i : period.years.from + i
        );
  return [...new Set(years)]
    .filter(
      (year) =>
        (period.yearList === undefined || period.yearList.includes(year)) &&
        (period.tupleList === undefined || period.tupleList.some((tuple) => tuple.year === year))
    )
    .sort((a, b) => a - b);
};

const prepare = async (
  deps: GroupedAnalyticsDeps,
  input: GroupedInput,
  grouping: 'entity' | 'classification'
): Promise<Result<GroupedQuery, ApiError>> => {
  const cleaned = cleanFilter(input.filter);
  if (cleaned.isErr()) return err(cleaned.error);
  const plan = resolveNormalizationPlan(input.filter);
  const requested = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return err(invalidInput('limit and offset must be non-negative integers'));
  }
  const limit = Math.min(requested, GROUPED_MAX_LIMIT);
  if (requested > limit) deps.onClamped?.({ requested, clamp: limit });
  const by =
    input.sort?.by.toUpperCase() ?? (plan.mode === 'per_capita' ? 'AMOUNT' : 'TOTAL_AMOUNT');
  const order = input.sort?.order.toUpperCase() ?? 'DESC';
  if (
    !ENTITY_SORT_FIELDS.includes(by as EntitySortField) ||
    (order !== 'ASC' && order !== 'DESC')
  ) {
    return err(invalidInput('Invalid entity analytics sort', 'sort'));
  }
  if (plan.mode === 'percent_gdp' && by === 'PER_CAPITA_AMOUNT') {
    return err(invalidInput('GDP percentage cannot be ranked by per-capita amount', 'sort'));
  }
  const years = groupedYears(cleaned.value.period);
  const context = await loadMoneyContext(deps.factors, plan);
  if (context.isErr()) return err(context.error);
  const multipliers = exactYearMoneyMultipliers(plan, context.value, years);
  if (multipliers.isErr()) return err(multipliers.error);
  const query: GroupedQuery = {
    filter: cleaned.value,
    moneyMultipliers: multipliers.value,
    mode: plan.mode,
    requirePopulation:
      plan.mode === 'per_capita' || (grouping === 'entity' && by === 'PER_CAPITA_AMOUNT'),
    limit,
    offset,
    sort: { by: by as EntitySortField, order },
  };
  if (grouping !== 'classification' || query.mode !== 'per_capita' || years.length === 0)
    return ok(query);
  // Transitional population policy only: this port is replaced with annual union coverage
  // before final migration acceptance. It is never a monetary-factor fallback.
  const scope = resolveGroupedPopulationScope(cleaned.value);
  let population;
  if (scope.kind === 'country') {
    const national = await deps.factors.yearly('population_ro');
    if (national.isErr()) return err(national.error);
    const latest = [...(national.value?.keys() ?? [])].sort((a, b) => b - a)[0];
    population = latest === undefined ? null : (national.value?.get(latest) ?? null);
  } else {
    const scoped = await deps.population.scopedPopulation(scope);
    if (scoped.isErr()) return err(scoped.error);
    population = scoped.value;
  }
  if (population == null || !population.isFinite() || population.lte(0)) {
    return err(serviceUnavailable('Per-capita population is unavailable for the selected scope'));
  }
  return ok({
    ...query,
    scopePopulations: new Map(years.map((year) => [year, legacyDecimal(population)])),
  });
};

export const groupedEntityAnalytics = async (
  deps: GroupedAnalyticsDeps,
  input: GroupedInput
): Promise<Result<GroupedPage<GroupedEntity>, ApiError>> => {
  const query = await prepare(deps, input, 'entity');
  return query.isErr() ? err(query.error) : deps.grouped.entities(query.value);
};
export const groupedClassificationAnalytics = async (
  deps: GroupedAnalyticsDeps,
  input: GroupedInput
): Promise<Result<GroupedPage<GroupedClassification>, ApiError>> => {
  const query = await prepare(deps, input, 'classification');
  return query.isErr() ? err(query.error) : deps.grouped.classifications(query.value);
};
