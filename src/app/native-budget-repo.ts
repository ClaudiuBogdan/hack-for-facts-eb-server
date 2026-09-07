/** Native annual population composition; the budget module never reads INS itself. */
import { sql, type Kysely } from 'kysely';

import { readNativePopulation } from './native-population.js';
import { makeBudgetRepo, type BudgetRepo } from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ProdDatabase } from '../modules/shared/index.js';

export function makeNativeBudgetRepo(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission
): BudgetRepo {
  const base = makeBudgetRepo(db);
  return {
    ...base,
    executionTimeseries: (query) => {
      if (query.normalization !== 'PER_CAPITA' && query.normalization !== 'PER_CAPITA_EURO')
        return base.executionTimeseries(query);
      return withInsReadSnapshot(db, (context) =>
        makeBudgetRepo(context.trx, {
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
        }).executionTimeseries(query)
      );
    },
  };
}
