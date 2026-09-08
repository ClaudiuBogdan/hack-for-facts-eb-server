/** Annual grouped financial values over one admitted population/fact snapshot. */
import { err, ok } from 'neverthrow';

import { readNativeAnnualScopePopulation } from './native-annual-scope-population.js';
import {
  groupedClassificationAnalytics,
  makeGroupedAnalyticsRepo,
  makeLegacyPopulationRepo,
  loadMoneyContext,
  resolveNormalizationPlan,
  type FactorSource,
  type FactorKind,
  type GroupedInput,
  type GroupedAnalyticsDeps,
  type YearlySeries,
} from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ProdDatabase } from '../modules/shared/index.js';
import type { Kysely } from 'kysely';

export function makeNativeGroupedClassifications(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onClamped?: GroupedAnalyticsDeps['onClamped']
) {
  const base = {
    grouped: makeGroupedAnalyticsRepo(db),
    population: makeLegacyPopulationRepo(db),
    factors,
    fxPolicy: 'cpi-base-year' as const,
    ...(onClamped === undefined ? {} : { onClamped }),
  };
  return async (input: GroupedInput): ReturnType<typeof groupedClassificationAnalytics> => {
    const plan = resolveNormalizationPlan(input.filter);
    if (plan.mode !== 'per_capita') return groupedClassificationAnalytics(base, input);
    // Resolve cold immutable factors before reserving the only connection in a small pool.
    const loaded = new Map<FactorKind, YearlySeries | null>();
    const ready = await loadMoneyContext(
      {
        yearly: async (kind) => {
          const result = await factors.yearly(kind);
          if (result.isOk()) loaded.set(kind, result.value);
          return result;
        },
      },
      plan
    );
    if (ready.isErr()) return err(ready.error);
    return withInsReadSnapshot(db, (context) =>
      groupedClassificationAnalytics(
        {
          ...base,
          grouped: makeGroupedAnalyticsRepo(context.trx),
          factors: {
            yearly: (kind) =>
              Promise.resolve(
                loaded.has(kind)
                  ? ok(loaded.get(kind) ?? null)
                  : err({ type: 'ServiceUnavailable', message: 'Unexpected monetary factor kind' })
              ),
          },
          annualScopePopulation: (scope, years) =>
            readNativeAnnualScopePopulation(context, admission, scope, years, sectorAdmission),
        },
        input
      )
    );
  };
}
