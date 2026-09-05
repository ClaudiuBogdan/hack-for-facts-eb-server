/**
 * `legacyExecutionSeries(inputs)` — the usecase behind the legacy
 * `executionAnalytics(inputs: [AnalyticsInput!]!): [AnalyticsSeries!]!` root
 * (docs/server-redesign/13 §4 row 1). Output semantics frozen by the manifest:
 * one series per input IN INPUT ORDER; the first error aborts the batch;
 * `seriesId ?? 'default'`; sparse labels, no zero-fill; growth after
 * normalization; the 10,000-point cap kept and reported to the caller's log.
 */

import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { cleanFilter } from './clean.js';
import { legacyDecimal } from './decimal.js';
import { loadMoneyContext } from './money-context.js';
import {
  normalizePoints,
  periodAxis,
  resolveNormalizationPlan,
  resultAxis,
  type NominalPoint,
  type NormalizationContext,
} from './normalize.js';
import { formatPeriodLabel } from './period.js';
import { resolvePopulationScope } from './population.js';
import {
  LEGACY_ANALYTICS_MAX_POINTS,
  type FactorSource,
  type LegacyExecutionAggregateRepo,
  type PopulationSource,
} from './ports.js';

import type {
  LegacyAnalyticsInput,
  LegacyAnalyticsSeries,
  NormalizationPlan,
  YearlySeries,
} from './types.js';
import type { Decimal } from 'decimal.js';

export interface LegacyExecutionSeriesDeps {
  readonly aggregate: LegacyExecutionAggregateRepo;
  readonly factors: FactorSource;
  readonly population: PopulationSource;
  /** Observability hook: fired when a series hit the point cap (never silent). */
  readonly onCapped?: (info: { readonly seriesId: string; readonly cap: number }) => void;
}

/** The latest year's value of a yearly series (the country population rule). */
const latestValue = (series: YearlySeries): Decimal | null => {
  let bestYear: number | null = null;
  let best: Decimal | null = null;
  for (const [year, value] of series) {
    if (bestYear === null || year > bestYear) {
      bestYear = year;
      best = value;
    }
  }
  return best;
};

const loadContext = async (
  deps: LegacyExecutionSeriesDeps,
  plan: NormalizationPlan,
  scope: ReturnType<typeof resolvePopulationScope>
): Promise<Result<NormalizationContext, ApiError>> => {
  const money = await loadMoneyContext(deps.factors, plan);
  if (money.isErr()) return err(money.error);
  let ctx = money.value;
  if (plan.mode === 'per_capita') {
    if (scope.kind === 'country') {
      const pop = await deps.factors.yearly('population_ro');
      if (pop.isErr()) return err(pop.error);
      ctx = { ...ctx, population: pop.value === null ? null : latestValue(pop.value) };
    } else {
      const pop = await deps.population.scopedPopulation(scope);
      if (pop.isErr()) return err(pop.error);
      ctx = { ...ctx, population: pop.value };
    }
    if (ctx.population == null || !ctx.population.isFinite() || ctx.population.lte(0)) {
      return err(serviceUnavailable('Per-capita population is unavailable for the selected scope'));
    }
  }
  return ok(ctx);
};

export const legacyExecutionSeries = async (
  deps: LegacyExecutionSeriesDeps,
  inputs: readonly LegacyAnalyticsInput[]
): Promise<Result<LegacyAnalyticsSeries[], ApiError>> => {
  const results: LegacyAnalyticsSeries[] = [];

  for (const input of inputs) {
    const seriesId = input.seriesId ?? 'default';

    const query = cleanFilter(input.filter);
    if (query.isErr()) return err(query.error);
    const q = query.value;

    // 1. Nominal RON per period (the fact-path aggregate).
    const aggregate = await deps.aggregate.legacyExecutionAggregate(q);
    if (aggregate.isErr()) return err(aggregate.error);
    if (aggregate.value.capped) {
      deps.onCapped?.({ seriesId, cap: LEGACY_ANALYTICS_MAX_POINTS });
    }

    // 2. Reference data the requested normalization needs.
    const plan = resolveNormalizationPlan(input.filter);
    const ctx = await loadContext(deps, plan, resolvePopulationScope(q));
    if (ctx.isErr()) return err(ctx.error);

    // 3. Normalize per point, then growth, then sort by label.
    const nominal: NominalPoint[] = aggregate.value.rows.map((r) => ({
      x: formatPeriodLabel(r.year, r.periodValue, q.frequency),
      year: r.year,
      y: legacyDecimal(r.amount),
    }));
    const normalized = normalizePoints(nominal, plan, ctx.value, q.frequency);

    results.push({
      seriesId,
      xAxis: periodAxis(q.frequency),
      yAxis: resultAxis(plan, normalized.cpiBaseYear),
      data: normalized.points,
    });
  }

  return ok(results);
};
