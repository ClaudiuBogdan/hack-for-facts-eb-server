/** Source-preserving population reads. The caller owns admission and snapshot lifetime. */
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '../../core/errors.js';
import {
  BUCHAREST_COUNTY_CODE,
  BUCHAREST_MUNICIPALITY_SIRUTA,
} from '../../core/territory-constants.js';

import type { ProdDatabase } from '../db/types.js';

export interface TerritoryPopulationRow {
  readonly territoryId: number;
  readonly siruta: string;
  readonly year: number;
  readonly population: number;
  readonly source: string;
  readonly sourceUrl: string;
  readonly canonicalSector: boolean;
}

/** Read the complete admitted source keysets, including unexpected rows for rejection. */
export async function readTerritoryPopulationSources(
  db: Kysely<ProdDatabase>,
  sources: readonly string[]
): Promise<Result<readonly TerritoryPopulationRow[], ApiError>> {
  if (sources.length === 0) return ok([]);
  try {
    const result = await sql<TerritoryPopulationRow>`select
      p.territory_id as "territoryId", t.territorial_siruta_code as siruta,
      p.year, p.population, p.source, p.source_url as "sourceUrl",
      (t.level='locality' and t.kind='sector' and t.county_code=${sql.lit(BUCHAREST_COUNTY_CODE)}
       and t.territory_key='siruta:'||t.territorial_siruta_code
       and (t.siruta_code is null or t.siruta_code=t.territorial_siruta_code)
       and t.privacy_class='public' and parent.privacy_class='public'
       and parent.territory_key=${sql.lit(`siruta:${BUCHAREST_MUNICIPALITY_SIRUTA}`)} and parent.level='uat'
       and parent.kind='municipality'
       and exists(select 1 from core.territory_identifiers i where i.territory_id=t.id
         and i.scheme='siruta' and i.value=t.territorial_siruta_code)) is true as "canonicalSector"
      from core.territory_population p
      left join core.territories t on t.id=p.territory_id
      left join core.territories parent on parent.id=t.parent_id
      where p.source in (select value from jsonb_array_elements_text(${JSON.stringify(sources)}::jsonb))`.execute(
      db
    );
    return ok(result.rows);
  } catch (cause) {
    return err(databaseError('readTerritoryPopulationSources failed', cause));
  }
}
