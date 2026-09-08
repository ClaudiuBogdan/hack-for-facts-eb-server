/** Annual grouped financial values over one admitted population/fact snapshot. */
import { err, ok } from 'neverthrow';

import { readNativePopulation } from './native-population.js';
import {
  groupedClassificationAnalytics,
  makeGroupedAnalyticsRepo,
  makeLegacyPopulationRepo,
  readGroupedPopulationAnchors,
  loadMoneyContext,
  resolveNormalizationPlan,
  legacyDecimal,
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
          annualScopePopulation: async (scope, years) => {
            const ids = await readGroupedPopulationAnchors(context.trx, scope);
            if (ids === null)
              return err({
                type: 'ServiceUnavailable',
                message: 'Population anchors are unavailable for the complete selected scope',
              });
            const population = await readNativePopulation(
              context,
              admission,
              ids,
              years,
              sectorAdmission
            );
            if (population.isErr()) return err(population.error);
            const totals = new Map(years.map((year) => [year, legacyDecimal(0)]));
            for (const cell of population.value) {
              if (cell.population === null)
                return err({
                  type: 'ServiceUnavailable',
                  message: 'Annual population is unavailable for the complete selected scope',
                });
              const value = legacyDecimal(cell.population);
              if (!value.isFinite() || value.lt(0))
                return err({ type: 'ServiceUnavailable', message: 'Annual population is invalid' });
              totals.set(cell.year, (totals.get(cell.year) ?? legacyDecimal(0)).plus(value));
            }
            return ok(totals);
          },
        },
        input
      )
    );
  };
}
