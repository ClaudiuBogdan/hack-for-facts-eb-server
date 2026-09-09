/** Annual grouped financial values over one admitted population/fact snapshot (moved from `src/app`, X/F6). */
import { err } from 'neverthrow';

import { readNativeAnnualScopePopulation } from './annual-scope-population.js';
import { preloadFactors } from './preloaded-factors.js';
import {
  groupedClassificationAnalytics,
  type GroupedAnalyticsDeps,
} from '../../core/legacy-analytics/grouped-usecase.js';
import { resolveNormalizationPlan } from '../../core/legacy-analytics/normalize.js';
import { makeGroupedAnalyticsRepo } from '../repo/grouped-analytics-repo.js';
import { makeLegacyPopulationRepo } from '../repo/legacy-population-repo.js';

import type { GroupedInput } from '../../core/legacy-analytics/grouped-types.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface NativeGroupedClassificationsDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly population: AnnualPopulationPort;
  readonly factors: FactorSource;
  readonly onClamped?: GroupedAnalyticsDeps['onClamped'];
}

export function makeNativeGroupedClassifications(deps: NativeGroupedClassificationsDeps) {
  const base = {
    grouped: makeGroupedAnalyticsRepo(deps.db),
    population: makeLegacyPopulationRepo(deps.db),
    factors: deps.factors,
    fxPolicy: 'cpi-base-year' as const,
    ...(deps.onClamped === undefined ? {} : { onClamped: deps.onClamped }),
  };
  return async (input: GroupedInput): ReturnType<typeof groupedClassificationAnalytics> => {
    const plan = resolveNormalizationPlan(input.filter);
    if (plan.mode !== 'per_capita') return groupedClassificationAnalytics(base, input);
    // Resolve cold immutable factors before reserving the only connection in a small pool.
    const ready = await preloadFactors(deps.factors, [plan]);
    if (ready.isErr()) return err(ready.error);
    return deps.population.withSnapshot((snapshot) =>
      groupedClassificationAnalytics(
        {
          ...base,
          grouped: makeGroupedAnalyticsRepo(snapshot.trx),
          factors: ready.value,
          annualScopePopulation: (scope, years) =>
            readNativeAnnualScopePopulation(snapshot, scope, years),
        },
        input
      )
    );
  };
}
