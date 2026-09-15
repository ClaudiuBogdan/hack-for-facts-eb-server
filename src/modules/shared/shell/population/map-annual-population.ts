import { sql } from 'kysely';
import { err } from 'neverthrow';

import { invalidInput, serviceUnavailable } from '../../core/errors.js';
import {
  BUCHAREST_COUNTY_CODE,
  BUCHAREST_MUNICIPALITY_SIRUTA,
} from '../../core/territory-constants.js';
import { isCountyTerritory, isUatPresentationTerritory } from '../repo/territory-predicates.js';

import type { AnnualPopulationPort } from './annual-population-port.js';

/** One complete map level and year, with identity and values in the same snapshot. */
export const readMapAnnualPopulation = (
  population: AnnualPopulationPort,
  year: number,
  granularity: 'UAT' | 'County'
) => {
  if (!Number.isInteger(year) || year < 1 || year > 9999)
    return Promise.resolve(err(invalidInput('Invalid population year', 'year')));
  return population.withSnapshot(async (snapshot) => {
    const county = granularity === 'County';
    const key = county ? sql.ref('t.county_code') : sql.ref('t.territorial_siruta_code');
    const eligible = county
      ? isCountyTerritory('t')
      : sql<boolean>`
      ${isUatPresentationTerritory('t')} and
      (t.county_code=${sql.lit(BUCHAREST_COUNTY_CODE)} and t.territorial_siruta_code=${sql.lit(BUCHAREST_MUNICIPALITY_SIRUTA)}) is not true`;
    const { rows } = await sql<{
      id: number;
      code: string | null;
      matches: string;
      privacy_class: string;
    }>`
      select t.id, ${key} as code, t.privacy_class,
        count(*) over (partition by ${key})::text as matches
      from core.territories t where ${eligible} order by ${key}, t.id
    `.execute(snapshot.trx);
    const publicRows = rows.filter((row) => row.privacy_class === 'public');
    const format = county ? /^[A-Z]{1,2}$/u : /^\d+$/u;
    if (
      publicRows.length === 0 ||
      publicRows.some((row) => row.matches !== '1' || row.code === null || !format.test(row.code))
    )
      return err(serviceUnavailable('Map population territory identities are unavailable'));
    const cells = await snapshot.cells(
      publicRows.map((row) => row.id),
      [year]
    );
    const codes = new Map(publicRows.map((row) => [row.id, row.code]));
    return cells.map((values) =>
      values.map((cell) => {
        const territoryCode = codes.get(cell.territoryId);
        if (territoryCode === undefined || territoryCode === null) {
          throw new Error('Population cell has an unknown map territory');
        }
        return { ...cell, territoryCode };
      })
    );
  });
};
