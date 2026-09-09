/** Batch factors before the snapshot; reuse population only within this request (moved from `src/app`, X/F6). */
import { err, ok } from 'neverthrow';

import { readNativeAnnualScopePopulation } from './annual-scope-population.js';
import { preloadFactors } from './preloaded-factors.js';
import {
  nativeExecutionSeries,
  type NativeExecutionSeriesDeps,
} from '../../core/legacy-analytics/native-usecase.js';
import { resolveNormalizationPlan } from '../../core/legacy-analytics/normalize.js';
import { makeLegacyAnalyticsRepo } from '../repo/legacy-analytics-repo.js';

import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { LegacyAnalyticsInput } from '../../core/legacy-analytics/types.js';
import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface NativeExecutionSeriesAdapterDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly population: AnnualPopulationPort;
  readonly factors: FactorSource;
  readonly onCapped?: NativeExecutionSeriesDeps['onCapped'];
}

export function makeNativeExecutionSeries(deps: NativeExecutionSeriesAdapterDeps) {
  return async (
    inputs: readonly LegacyAnalyticsInput[]
  ): ReturnType<typeof nativeExecutionSeries> => {
    const plans = inputs.map((input) => resolveNormalizationPlan(input.filter));
    const ready = await preloadFactors(deps.factors, plans);
    if (ready.isErr()) return err(ready.error);
    const base = {
      factors: ready.value,
      ...(deps.onCapped === undefined ? {} : { onCapped: deps.onCapped }),
    };
    if (!plans.some((plan) => plan.mode === 'per_capita'))
      return nativeExecutionSeries(
        {
          ...base,
          aggregate: makeLegacyAnalyticsRepo(deps.db),
          annualPopulation: () => Promise.resolve(ok(new Map())),
        },
        inputs
      );
    return deps.population.withSnapshot((snapshot) => {
      const population = new Map<string, ReturnType<typeof readNativeAnnualScopePopulation>>();
      return nativeExecutionSeries(
        {
          ...base,
          aggregate: makeLegacyAnalyticsRepo(snapshot.trx),
          annualPopulation: (scope, years) => {
            const key = JSON.stringify([scope, years]);
            let value = population.get(key);
            if (value === undefined) {
              value = readNativeAnnualScopePopulation(snapshot, scope, years);
              population.set(key, value);
            }
            return value;
          },
        },
        inputs
      );
    });
  };
}
