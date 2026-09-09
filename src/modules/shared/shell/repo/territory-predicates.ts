import { sql, type RawBuilder } from 'kysely';

import {
  BUCHAREST_COUNTY_CODE,
  BUCHAREST_MUNICIPALITY_SIRUTA,
} from '../../core/territory-constants.js';

/** Geography suitable for the UAT presentation layer, including sector halls. */
export const isUatPresentationTerritory = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${sql.ref(`${alias}.level`)} = 'uat'
    or (${sql.ref(`${alias}.level`)} = 'locality' and ${sql.ref(`${alias}.kind`)} = 'sector'))`;

/**
 * One geographic county row. Before L2, Bucharest has only its municipality;
 * that compatibility row is admitted only while the county node is absent.
 * A present county with unknown population must remain unknown.
 */
export const isCountyTerritory = (alias: string): RawBuilder<boolean> =>
  sql<boolean>`(${sql.ref(`${alias}.level`)} = 'county'
    or (${sql.ref(`${alias}.county_code`)} = ${sql.lit(BUCHAREST_COUNTY_CODE)}
      and ${sql.ref(`${alias}.level`)} = 'uat'
      and ${sql.ref(`${alias}.siruta_code`)} = ${sql.lit(BUCHAREST_MUNICIPALITY_SIRUTA)}
      and not exists (
        select 1 from core.territories as county_node
        where county_node.level = 'county' and county_node.county_code = ${sql.lit(BUCHAREST_COUNTY_CODE)}
      )))`;
