/** Exact annual entity divisors and a separate latest-selected-year display population. */
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import { readNativePopulation } from './native-population.js';
import {
  groupedEntityAnalytics,
  loadMoneyContext,
  makeGroupedAnalyticsRepo,
  makeLegacyPopulationRepo,
  resolveNormalizationPlan,
  type FactorKind,
  type FactorSource,
  type GroupedAnalyticsDeps,
  type GroupedInput,
} from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ProdDatabase } from '../modules/shared/index.js';

export function makeNativeGroupedEntities(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onClamped?: GroupedAnalyticsDeps['onClamped']
) {
  return async (input: GroupedInput): ReturnType<typeof groupedEntityAnalytics> => {
    // Resolve cold factors before borrowing the only connection in a small pool.
    const loaded = new Map<FactorKind, ReturnType<FactorSource['yearly']>>();
    const ready = await loadMoneyContext(
      {
        yearly: (kind) => {
          const result = factors.yearly(kind);
          loaded.set(kind, result);
          return result;
        },
      },
      resolveNormalizationPlan(input.filter)
    );
    if (ready.isErr()) return err(ready.error);
    return withInsReadSnapshot(db, (context) =>
      groupedEntityAnalytics(
        {
          factors: {
            yearly: (kind) =>
              loaded.get(kind) ??
              Promise.resolve(
                err({
                  type: 'ServiceUnavailable',
                  message: 'Unexpected monetary factor kind',
                })
              ),
          },
          fxPolicy: 'cpi-base-year',
          population: makeLegacyPopulationRepo(context.trx),
          grouped: makeGroupedAnalyticsRepo(context.trx, {
            annualPopulationRelation: async ({ territoryIds, years }) => {
              const result = await readNativePopulation(
                context,
                admission,
                territoryIds,
                years,
                sectorAdmission
              );
              if (result.isErr()) return err(result.error);
              return ok(
                sql`select * from jsonb_to_recordset(${JSON.stringify(
                  result.value.map((cell) => ({
                    territory_id: cell.territoryId,
                    year: cell.year,
                    population: cell.population,
                  }))
                )}::jsonb) as p(territory_id bigint, year int, population numeric)`
              );
            },
          }),
          ...(onClamped === undefined ? {} : { onClamped }),
        },
        input
      )
    );
  };
}
