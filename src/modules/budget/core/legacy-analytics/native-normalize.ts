/** Exact native period normalization with explicit, source-derived coverage gaps. */
import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { HUNDRED, legacyDecimal } from './decimal.js';
import { groupedYears } from './grouped-usecase.js';
import { formatPeriodLabel, previousPeriodLabel } from './period.js';
import { exactYearMoneyMultipliers } from './yearly-multipliers.js';

import type { NominalPoint, NormalizationContext } from './normalize.js';
import type {
  LegacyFrequency,
  LegacySeriesPoint,
  NormalizationPlan,
  PeriodPlan,
  YearlySeries,
} from './types.js';

/** The same intersection as the SQL period predicates; no sparse-date expansion. */
export function selectedPeriodLabels(period: PeriodPlan, frequency: LegacyFrequency) {
  const labels: { x: string; year: number }[] = [];
  const last = frequency === 'MONTH' ? 12 : frequency === 'QUARTER' ? 4 : 1;
  const tuples =
    period.tupleList === undefined
      ? undefined
      : new Set(period.tupleList.map((p) => `${String(p.year)}:${String(p.sub)}`));
  for (const year of groupedYears(period)) {
    for (let sub = 1; sub <= last; sub++) {
      const range = period.tupleRange;
      if (
        range !== undefined &&
        (year < range.start.year ||
          year > range.end.year ||
          (year === range.start.year && sub < range.start.sub) ||
          (year === range.end.year && sub > range.end.sub))
      )
        continue;
      if (tuples !== undefined && !tuples.has(`${String(year)}:${String(sub)}`)) continue;
      labels.push({ x: formatPeriodLabel(year, sub, frequency), year });
    }
  }
  return labels;
}

export function normalizeNativePoints(
  nominal: readonly NominalPoint[],
  plan: NormalizationPlan,
  context: NormalizationContext,
  frequency: LegacyFrequency,
  selected: readonly { readonly x: string; readonly year: number }[],
  populations?: YearlySeries
): Result<
  {
    points: readonly LegacySeriesPoint[];
    missingPeriods: readonly string[];
    cpiBaseYear: number | null;
  },
  ApiError
> {
  const required =
    plan.mode === 'percent_gdp'
      ? [context.gdp]
      : [
          ...(plan.inflationAdjusted ? [context.cpiIndex] : []),
          ...(plan.currency !== 'RON' ? [context.fxRate] : []),
        ];
  for (const series of required) {
    if (series === undefined) return err(serviceUnavailable('Missing monetary factor kind'));
    if ([...series.values()].some((value) => !value.isFinite() || value.lte(0)))
      return err(serviceUnavailable('Invalid monetary factor value'));
  }
  const baseYear =
    context.cpiIndex === undefined
      ? undefined
      : [...context.cpiIndex.keys()].sort((a, b) => b - a)[0];
  if (plan.mode !== 'percent_gdp' && plan.inflationAdjusted && baseYear === undefined)
    return err(serviceUnavailable('CPI base year is unavailable'));
  const years = [...new Set(selected.map((p) => p.year))];
  const eligible = years.filter((year) => {
    if (plan.mode === 'percent_gdp') return context.gdp?.has(year) === true;
    if (plan.inflationAdjusted && context.cpiIndex?.has(year) !== true) return false;
    if (plan.currency === 'RON') return true;
    const rateYear = plan.inflationAdjusted ? baseYear : year;
    return rateYear !== undefined && context.fxRate?.has(rateYear) === true;
  });
  const money = exactYearMoneyMultipliers(plan, context, eligible, 'cpi-base-year');
  if (money.isErr()) return err(money.error);
  const multipliers = new Map<number, ReturnType<typeof legacyDecimal>>();
  for (const year of years) {
    const factor = money.value.get(year);
    if (factor === undefined) continue;
    if (plan.mode !== 'per_capita') multipliers.set(year, factor);
    else {
      const population = populations?.get(year);
      if (population !== undefined && population.isFinite() && population.gt(0))
        multipliers.set(year, factor.div(population));
    }
  }
  const missing = new Set(selected.filter((p) => !multipliers.has(p.year)).map((p) => p.x));
  const normalized = nominal.flatMap((p) => {
    const factor = multipliers.get(p.year);
    return factor === undefined ? [] : [{ x: p.x, y: legacyDecimal(p.y).mul(factor) }];
  });
  const lookup = new Map(normalized.map((p) => [p.x, p.y]));
  const points = plan.showPeriodGrowth
    ? normalized.flatMap((p) => {
        const previous = previousPeriodLabel(p.x, frequency);
        const value = previous === null ? undefined : lookup.get(previous);
        if (value === undefined || value.isZero()) {
          missing.add(p.x);
          return [];
        }
        return [{ x: p.x, y: p.y.minus(value).div(value).mul(HUNDRED) }];
      })
    : normalized;
  const cpiBaseYear =
    plan.mode !== 'percent_gdp' && plan.inflationAdjusted && context.cpiIndex !== undefined
      ? ([...context.cpiIndex.keys()].sort((a, b) => b - a)[0] ?? null)
      : null;
  return ok({
    points: points.sort((a, b) => a.x.localeCompare(b.x)),
    missingPeriods: [...missing].sort(),
    cpiBaseYear,
  });
}
