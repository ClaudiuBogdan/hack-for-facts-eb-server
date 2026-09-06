import { sql } from 'kysely';

import type { MapTerritoryLookup } from '@/common/ports/map-territory-lookup.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

interface SirutaRow {
  siruta_code: string;
}

/** Preserves the legacy map universe until native geometry parity is proven. */
export const makeLegacyMapTerritoryLookup =
  (db: BudgetDbClient): MapTerritoryLookup =>
  async () => {
    const nonCountyCondition = sql<boolean>`NOT (
    u.siruta_code = u.county_code
    OR (u.county_code = 'B' AND u.siruta_code = '179132')
  )`;

    const rows: SirutaRow[] = await db
      .selectFrom('uats as u')
      .select(['u.siruta_code'])
      .where(nonCountyCondition)
      .orderBy('u.siruta_code', 'asc')
      .execute();

    return rows.map((row) => row.siruta_code.trim()).filter((value) => value !== '');
  };
