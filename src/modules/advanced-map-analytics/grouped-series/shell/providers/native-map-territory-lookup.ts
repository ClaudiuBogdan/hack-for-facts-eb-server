import { sql, type Kysely } from 'kysely';

import {
  isCountyTerritory,
  isUatPresentationTerritory,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { MapTerritoryLookup } from '@/common/ports/map-territory-lookup.js';

/** Public presentation keys, independent of budget selection or population coverage. */
export const makeNativeMapTerritoryLookup =
  (db: Kysely<ProdDatabase>, granularity: 'UAT' | 'County' = 'UAT'): MapTerritoryLookup =>
  async () => {
    const county = granularity === 'County';
    const key = county ? sql.ref('t.county_code') : sql.ref('t.territorial_siruta_code');
    const eligible = county
      ? isCountyTerritory('t')
      : sql<boolean>`${isUatPresentationTerritory('t')}
        and (t.county_code = 'B' and t.territorial_siruta_code = '179132') is not true`;
    const rows = (
      await sql<{ code: string | null; matches: string }>`
    select ${key} as code, count(*)::text as matches from core.territories t
    where ${eligible}
    group by ${key}
    having count(*) filter (where t.privacy_class = 'public') > 0
    order by code
  `.execute(db)
    ).rows;
    const keys: string[] = [];
    const format = county ? /^[A-Z]{1,2}$/u : /^\d+$/u;
    for (const { code, matches } of rows) {
      if (matches !== '1' || code === null || !format.test(code)) {
        throw new Error('Native map territory identities are incomplete or ambiguous');
      }
      keys.push(code);
    }
    if (keys.length === 0) throw new Error('Native map territory universe is unavailable');
    return keys;
  };
