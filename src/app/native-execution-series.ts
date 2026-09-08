/** Batch factors before the snapshot; reuse population only within this request. */
import { err, ok } from 'neverthrow';

import { readNativeAnnualScopePopulation } from './native-annual-scope-population.js';
import {
  loadMoneyContext,
  makeLegacyAnalyticsRepo,
  nativeExecutionSeries,
  resolveNormalizationPlan,
  type FactorKind,
  type FactorSource,
  type LegacyAnalyticsInput,
  type NativeExecutionSeriesDeps,
} from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ProdDatabase } from '../modules/shared/index.js';
import type { Kysely } from 'kysely';

export function makeNativeExecutionSeries(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onCapped?: NativeExecutionSeriesDeps['onCapped']
) {
  return async (
    inputs: readonly LegacyAnalyticsInput[]
  ): ReturnType<typeof nativeExecutionSeries> => {
    const loaded = new Map<FactorKind, ReturnType<FactorSource['yearly']>>();
    const preloaded: FactorSource = {
      yearly: (kind) => {
        let value = loaded.get(kind);
        if (value === undefined) {
          value = factors.yearly(kind);
          loaded.set(kind, value);
        }
        return value;
      },
    };
    for (const input of inputs) {
      const ready = await loadMoneyContext(preloaded, resolveNormalizationPlan(input.filter));
      if (ready.isErr()) return err(ready.error);
    }
    const base = {
      factors: {
        yearly: (kind: FactorKind) =>
          loaded.get(kind) ??
          Promise.resolve(
            err({
              type: 'ServiceUnavailable' as const,
              message: 'Unexpected monetary factor kind',
            })
          ),
      },
      ...(onCapped === undefined ? {} : { onCapped }),
    };
    if (!inputs.some((input) => resolveNormalizationPlan(input.filter).mode === 'per_capita'))
      return nativeExecutionSeries(
        {
          ...base,
          aggregate: makeLegacyAnalyticsRepo(db),
          annualPopulation: () => Promise.resolve(ok(new Map())),
        },
        inputs
      );
    return withInsReadSnapshot(db, (context) => {
      const population = new Map<string, ReturnType<typeof readNativeAnnualScopePopulation>>();
      return nativeExecutionSeries(
        {
          ...base,
          aggregate: makeLegacyAnalyticsRepo(context.trx),
          annualPopulation: (scope, years) => {
            const key = JSON.stringify([scope, years]);
            let value = population.get(key);
            if (value === undefined) {
              value = readNativeAnnualScopePopulation(
                context,
                admission,
                scope,
                years,
                sectorAdmission
              );
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
