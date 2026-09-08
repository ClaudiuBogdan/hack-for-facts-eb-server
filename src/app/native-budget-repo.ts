/** Native annual population composition; the budget module never reads INS itself. */
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { makeNativeBudgetFactors } from './native-budget-factors.js';
import { readNativePopulation } from './native-population.js';
import {
  makeBudgetRepo,
  budgetMoneyPlan,
  loadMoneyContext,
  type BudgetMoneyOptions,
  type FactorKind,
  type BudgetRepo,
  type FactorSource,
} from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ApiError, ProdDatabase } from '../modules/shared/index.js';

export function makeNativeBudgetRepo(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission,
  moneyFactors = makeNativeBudgetFactors(db)
): BudgetRepo {
  const base = makeBudgetRepo(db, { moneyFactors });
  const snapshotRepo = (
    context: Parameters<typeof readNativePopulation>[0],
    factors = moneyFactors
  ) =>
    makeBudgetRepo(context.trx, {
      moneyFactors: factors,
      populationRelation: async (selection) => {
        const result = await readNativePopulation(
          context,
          admission,
          selection.territoryIds,
          selection.years,
          sectorAdmission
        );
        return result.map(
          (cells) =>
            sql`select * from jsonb_to_recordset(${JSON.stringify(
              cells.map((cell) => ({
                territory_id: cell.territoryId,
                year: cell.year,
                population: cell.population,
              }))
            )}::jsonb) as population(territory_id bigint, year int, population numeric)`
        );
      },
    });
  // Cold immutable reads must finish before a request reserves a snapshot
  // connection, including when the serving pool has only one connection.
  const prepareMoneyFactors = async (
    normalization: Parameters<BudgetRepo['rankEntities']>[0]['normalization'],
    options: BudgetMoneyOptions = {}
  ): Promise<Result<FactorSource, ApiError>> => {
    const loaded = new Map<FactorKind, ReturnType<FactorSource['yearly']>>();
    const ready = await loadMoneyContext(
      {
        yearly: (kind) => {
          const result = moneyFactors.yearly(kind);
          loaded.set(kind, result);
          return result;
        },
      },
      budgetMoneyPlan(normalization, options)
    );
    if (ready.isErr()) return err(ready.error);
    return ok({
      yearly: (kind) =>
        loaded.get(kind) ??
        Promise.resolve(
          err({ type: 'ServiceUnavailable', message: 'Unexpected monetary factor kind' })
        ),
    });
  };
  return {
    ...base,
    listExecutionLineItems: async (query) => {
      const normalization = query.normalization ?? 'TOTAL';
      if (normalization !== 'PER_CAPITA' && normalization !== 'PER_CAPITA_EURO')
        return base.listExecutionLineItems(query);
      const ready = await prepareMoneyFactors(normalization, query);
      if (ready.isErr()) return err(ready.error);
      return withInsReadSnapshot(db, (context) =>
        snapshotRepo(context, ready.value).listExecutionLineItems(query)
      );
    },
    executionTimeseries: async (query) => {
      if (query.normalization !== 'PER_CAPITA' && query.normalization !== 'PER_CAPITA_EURO')
        return base.executionTimeseries(query);
      const ready = await prepareMoneyFactors(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return withInsReadSnapshot(db, (context) =>
        snapshotRepo(context, ready.value).executionTimeseries(query)
      );
    },
    // Both entrypoints need the snapshot: the base top-N method closes over its
    // own page implementation. TOTAL also returns annual population metadata.
    rankEntities: async (query) => {
      const ready = await prepareMoneyFactors(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return withInsReadSnapshot(db, (context) =>
        snapshotRepo(context, ready.value).rankEntities(query)
      );
    },
    rankEntitiesPage: async (query) => {
      const ready = await prepareMoneyFactors(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return withInsReadSnapshot(db, (context) =>
        snapshotRepo(context, ready.value).rankEntitiesPage(query)
      );
    },
  };
}
