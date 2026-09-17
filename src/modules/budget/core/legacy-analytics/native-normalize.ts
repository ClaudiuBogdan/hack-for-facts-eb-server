/** Exact native period normalization with explicit, source-derived coverage gaps. */
import { err, ok, type Result } from 'neverthrow';

import { HUNDRED, legacyDecimal } from './decimal.js';
import { groupedYears } from './grouped-usecase.js';
import { eligibleMoneyYears } from './money-eligibility.js';
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
import type { ApiError } from '@/modules/shared/index.js';

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
  const years = [...new Set(selected.map((p) => p.year))];
  const eligibility = eligibleMoneyYears(plan, context, years);
  if (eligibility.isErr()) return err(eligibility.error);
  const { eligible } = eligibility.value;
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
