/** Native execution series: preserve nominal filters, normalize each reference year. */
import { err, ok, type Result } from 'neverthrow';

import { cleanFilter } from './clean.js';
import { legacyDecimal } from './decimal.js';
import { loadMoneyContext } from './money-context.js';
import { normalizeNativePoints, selectedPeriodLabels } from './native-normalize.js';
import { periodAxis, resolveNormalizationPlan, resultAxis } from './normalize.js';
import { formatPeriodLabel } from './period.js';
import { resolvePopulationScope } from './population.js';
import { LEGACY_ANALYTICS_MAX_POINTS } from './ports.js';

import type {
  LegacyAnalyticsInput,
  LegacyAnalyticsSeries,
  PopulationScope,
  YearlySeries,
} from './types.js';
import type { LegacyExecutionSeriesDeps } from './usecase.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface NativeExecutionSeriesDeps extends Omit<LegacyExecutionSeriesDeps, 'population'> {
  readonly annualPopulation: (
    scope: PopulationScope,
    years: readonly number[]
  ) => Promise<Result<YearlySeries, ApiError>>;
}

export async function nativeExecutionSeries(
  deps: NativeExecutionSeriesDeps,
  inputs: readonly LegacyAnalyticsInput[]
): Promise<Result<LegacyAnalyticsSeries[], ApiError>> {
  const results: LegacyAnalyticsSeries[] = [];
  for (const input of inputs) {
    const query = cleanFilter(input.filter);
    if (query.isErr()) return err(query.error);
    const q = query.value;
    const plan = resolveNormalizationPlan(input.filter);
    const context = await loadMoneyContext(deps.factors, plan);
    if (context.isErr()) return err(context.error);
    const selected = selectedPeriodLabels(q.period, q.frequency);
    let populations: YearlySeries | undefined;
    if (plan.mode === 'per_capita' && selected.length > 0) {
      const population = await deps.annualPopulation(resolvePopulationScope(q), [
        ...new Set(selected.map((p) => p.year)),
      ]);
      if (population.isErr()) return err(population.error);
      populations = population.value;
    }
    const aggregate = await deps.aggregate.legacyExecutionAggregate(q);
    if (aggregate.isErr()) return err(aggregate.error);
    const seriesId = input.seriesId ?? 'default';
    if (aggregate.value.capped) deps.onCapped?.({ seriesId, cap: LEGACY_ANALYTICS_MAX_POINTS });
    const normalized = normalizeNativePoints(
      aggregate.value.rows.map((row) => ({
        x: formatPeriodLabel(row.year, row.periodValue, q.frequency),
        year: row.year,
        y: legacyDecimal(row.amount),
      })),
      plan,
      context.value,
      q.frequency,
      selected,
      populations
    );
    if (normalized.isErr()) return err(normalized.error);
    results.push({
      seriesId,
      xAxis: periodAxis(q.frequency),
      yAxis: resultAxis(plan, normalized.value.cpiBaseYear),
      data: normalized.value.points,
      missingPeriods: normalized.value.missingPeriods,
    });
  }
  return ok(results);
}
