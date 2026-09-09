/**
 * ONE population relation for every native adapter (review X/F6): the port's
 * cells become a `jsonb_to_recordset` relation the repos join on
 * `(territory_id, year)`. Replaces the fragment that was copied into the
 * budget repo and grouped-entities adapters under `src/app/`.
 */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import type { AnnualPopulationSnapshot, ApiError } from '@/modules/shared/index.js';

export const populationRelation = async (
  snapshot: AnnualPopulationSnapshot,
  selection: { readonly territoryIds: readonly number[]; readonly years: readonly number[] },
  alias = 'population'
): Promise<Result<RawBuilder<unknown>, ApiError>> => {
  const cells = await snapshot.cells(selection.territoryIds, selection.years);
  if (cells.isErr()) return err(cells.error);
  return ok(
    sql`select * from jsonb_to_recordset(${JSON.stringify(
      cells.value.map((cell) => ({
        territory_id: cell.territoryId,
        year: cell.year,
        population: cell.population,
      }))
    )}::jsonb) as ${sql.ref(alias)}(territory_id bigint, year int, population numeric)`
  );
};
