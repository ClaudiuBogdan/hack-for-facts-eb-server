/**
 * Shared Kernel — Territory repo (foundation §4.2).
 *
 * SIRUTA-keyed territory anchor over `core.territories`. All geographic filters
 * across sources resolve through this hub; source rows carry county/siruta
 * denormalized, canonical metadata (region, population) comes from here.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { foldDiacritics } from './fold.js';
import { databaseError, type ApiError } from '../../core/errors.js';

import type { TerritoryRepo } from '../../core/ports.js';
import type { CountyRef, Siruta, Territory } from '../../core/types.js';
import type { ProdDatabase } from '../db/types.js';

type Db = Kysely<ProdDatabase>;

const TERRITORY_COLUMNS = [
  'id',
  'territorial_siruta_code',
  'siruta_code',
  'county_siruta_code',
  'uat_code',
  'name',
  'county_code',
  'county_name',
  'region',
  'population',
] as const;

const mapTerritory = (row: {
  id: number;
  territorial_siruta_code: string | null;
  siruta_code: string | null;
  county_siruta_code: string | null;
  uat_code: string | null;
  name: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;
}): Territory => ({
  id: row.id,
  territorialSirutaCode: row.territorial_siruta_code,
  sirutaCode: row.siruta_code,
  countySirutaCode: row.county_siruta_code,
  uatCode: row.uat_code,
  name: row.name,
  countyCode: row.county_code,
  countyName: row.county_name,
  region: row.region,
  population: row.population,
});

export const makeTerritoryRepo = (db: Db): TerritoryRepo => ({
  async byTerritorialSiruta(code: Siruta): Promise<Result<Territory | null, ApiError>> {
    try {
      const row = await db
        .selectFrom('core.territories')
        .select([...TERRITORY_COLUMNS])
        .where('territorial_siruta_code', '=', code)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapTerritory(row));
    } catch (error) {
      return err(databaseError('byTerritorialSiruta failed', error));
    }
  },

  async byCounty(countyCode: string): Promise<Result<readonly Territory[], ApiError>> {
    try {
      const rows = await db
        .selectFrom('core.territories')
        .select([...TERRITORY_COLUMNS])
        .where('county_code', '=', countyCode)
        .orderBy('name', 'asc')
        .execute();
      return ok(rows.map(mapTerritory));
    } catch (error) {
      return err(databaseError('byCounty failed', error));
    }
  },

  async searchUat(q: string, limit: number): Promise<Result<readonly Territory[], ApiError>> {
    const folded = foldDiacritics(q);
    if (folded === '') return ok([]);
    const escapedRaw = q.trim().replace(/[%_\\]/gu, '\\$&');
    try {
      // `core.territories.name` is NOT loader-folded, so match the RAW query
      // (a folded needle would miss diacritic rows), bounded, then fold both
      // sides in TS for ranking (§15.7).
      const rows = await db
        .selectFrom('core.territories')
        .select([...TERRITORY_COLUMNS])
        .where(sql<boolean>`name ilike ${'%' + escapedRaw + '%'} escape '\\'`)
        .limit(200)
        .execute();
      const ranked = rows
        .map((r) => ({ row: r, idx: foldDiacritics(r.name).indexOf(folded) }))
        .filter((x) => x.idx >= 0)
        .sort((a, b) => (a.idx !== b.idx ? a.idx - b.idx : a.row.name.length - b.row.name.length))
        .slice(0, Math.min(limit, 100))
        .map((x) => mapTerritory(x.row));
      return ok(ranked);
    } catch (error) {
      return err(databaseError('searchUat failed', error));
    }
  },

  async listCounties(): Promise<Result<readonly CountyRef[], ApiError>> {
    try {
      const rows = await db
        .selectFrom('core.territories')
        .select(['county_code', 'county_name'])
        .where('county_code', 'is not', null)
        .where('county_name', 'is not', null)
        .distinct()
        .orderBy('county_name', 'asc')
        .execute();
      return ok(
        rows
          .filter(
            (r): r is { county_code: string; county_name: string } =>
              r.county_code !== null && r.county_name !== null
          )
          .map((r) => ({ countyCode: r.county_code, countyName: r.county_name }))
      );
    } catch (error) {
      return err(databaseError('listCounties failed', error));
    }
  },

  async listRegions(): Promise<Result<readonly string[], ApiError>> {
    try {
      const rows = await db
        .selectFrom('core.territories')
        .select(['region'])
        .where('region', 'is not', null)
        .distinct()
        .orderBy('region', 'asc')
        .execute();
      return ok(rows.map((r) => r.region).filter((r): r is string => r !== null));
    } catch (error) {
      return err(databaseError('listRegions failed', error));
    }
  },
});
