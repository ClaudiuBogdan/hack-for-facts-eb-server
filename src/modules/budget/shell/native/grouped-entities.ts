/** Native annual population for grouped entity analytics over one snapshot (moved from `src/app`, X/F6). */
import { err } from 'neverthrow';

import { populationRelation } from './population-relation.js';
import { preloadFactors } from './preloaded-factors.js';
import {
  groupedEntityAnalytics,
  type GroupedAnalyticsDeps,
} from '../../core/legacy-analytics/grouped-usecase.js';
import { resolveNormalizationPlan } from '../../core/legacy-analytics/normalize.js';
import { makeGroupedAnalyticsRepo } from '../repo/grouped-analytics-repo.js';
import { makeLegacyPopulationRepo } from '../repo/legacy-population-repo.js';

import type { GroupedInput } from '../../core/legacy-analytics/grouped-types.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface NativeGroupedAdapterDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly population: AnnualPopulationPort;
  readonly factors: FactorSource;
  readonly onClamped?: GroupedAnalyticsDeps['onClamped'];
}

export function makeNativeGroupedEntities(deps: NativeGroupedAdapterDeps) {
  return async (input: GroupedInput): ReturnType<typeof groupedEntityAnalytics> => {
    // Resolve cold factors before borrowing the only connection in a small pool.
    const ready = await preloadFactors(deps.factors, [resolveNormalizationPlan(input.filter)]);
    if (ready.isErr()) return err(ready.error);
    return deps.population.withSnapshot((snapshot) =>
      groupedEntityAnalytics(
        {
          factors: ready.value,
          fxPolicy: 'cpi-base-year',
          population: makeLegacyPopulationRepo(snapshot.trx),
          grouped: makeGroupedAnalyticsRepo(snapshot.trx, {
            annualPopulationRelation: (selection) => populationRelation(snapshot, selection, 'p'),
          }),
          ...(deps.onClamped === undefined ? {} : { onClamped: deps.onClamped }),
        },
        input
      )
    );
  };
}
