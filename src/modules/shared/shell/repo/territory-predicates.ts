import { sql, type RawBuilder } from 'kysely';

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
    or (${sql.ref(`${alias}.county_code`)} = 'B'
      and ${sql.ref(`${alias}.level`)} = 'uat'
      and ${sql.ref(`${alias}.siruta_code`)} = '179132'
      and not exists (
        select 1 from core.territories as county_node
        where county_node.level = 'county' and county_node.county_code = 'B'
      )))`;
