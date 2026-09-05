/**
 * Filter-wide per-capita population over canonical entity/territory anchors.
 * Requests with the executive field use the administrative union in
 * population-union.ts, except explicit geographic scopes keep legacy priority.
 *
 * Without that field, preserve the carried scope contract: explicit CUIs and
 * territory IDs deduplicate by ID but retain ancestor/child overlap. Entity-type
 * and all-UAT scopes use native UAT/sector nodes, suppressing PMB when selected
 * sectors have it as their parent. County scopes select native counties, with
 * PMB compatibility only while Bucharest county is absent. County-council type
 * selection retains its legacy county-only shortcut.
 *
 * Database errors and missing/invalid population remain unavailable; the
 * usecase must never return nominal amounts under a per-capita label. Legacy
 * country population still comes from the reference factor port. Annual INS
 * population is a separate migration prerequisite.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  isCountyTerritory,
  isUatPresentationTerritory,
  databaseError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { entityPopulationUnionSql, geographicPopulationUnionSql } from './population-union.js';
import { BUCHAREST_SIRUTA_CODE } from '../../core/constants.js';
import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';

import type { PopulationSource } from '../../core/legacy-analytics/ports.js';
import type { PopulationScope } from '../../core/legacy-analytics/types.js';
import type { Decimal } from 'decimal.js';

type Db = Kysely<ProdDatabase>;

const ENTITY_COUNTY_COUNCIL_TYPE = 'admin_county_council';

interface TotalRow {
  total: string | null;
}

interface CountyRow {
  county_code: string;
}

/** The county-level territory row predicate (legacy `getCountryPopulation`). */
const countyLevelRow = isCountyTerritory('t');

/**
 * Carried old-field-only denominator: native UAT/sector presentation nodes,
 * excluding PMB when its selected sector children are present. This preserves
 * the old compatibility boundary; new executive-field requests use the maximal
 * ancestor union in population-union.ts instead (including all e/t predicates).
 */
const uatLevelUniverse = sql`(
  ${isUatPresentationTerritory('d')}
  and not (
    ${sql.ref('d.territorial_siruta_code')} = ${BUCHAREST_SIRUTA_CODE}
    and exists (
      select 1 from d as s
      where s.level = 'locality' and s.kind = 'sector'
        and s.parent_id = d.id
    )
  )
)`;

const toDecimal = (rows: readonly TotalRow[]): Decimal | null => {
  const total = rows[0]?.total;
  if (total === undefined || total === null) return null;
  return legacyDecimal(total);
};

export const makeLegacyPopulationRepo = (db: Db): PopulationSource => {
  const byCounties = async (codes: readonly string[]): Promise<Decimal | null> => {
    if (codes.length === 0) return null;
    const uniqueCodes = [...new Set(codes)];
    const res = await sql<TotalRow>`
      select case when count(*) = ${uniqueCodes.length}
        and count(distinct t.county_code) = ${uniqueCodes.length}
        and count(t.population) = count(*)
        then sum(t.population)::text else null end as total
      from core.territories as t
      where ${sql.ref('t.county_code')} in (${sql.join(uniqueCodes)})
        and ${countyLevelRow}
    `.execute(db);
    return toDecimal(res.rows);
  };

  /**
   * Sum over DISTINCT territories (by id) of the entities matching `entityWhere`,
   * optionally restricted to the UAT-level universe (see `uatLevelUniverse`).
   */
  const byEntityTerritories = async (
    entityWhere: ReturnType<typeof sql>,
    universe: 'all' | 'uat-level'
  ): Promise<Decimal | null> => {
    const restriction = universe === 'uat-level' ? sql`where ${uatLevelUniverse}` : sql``;
    const res = await sql<TotalRow>`
      with d as (
        select distinct
          ${sql.ref('t.id')} as id,
          ${sql.ref('t.population')} as population,
          t.territorial_siruta_code, t.level, t.kind, t.parent_id
        from core.public_entities as e
        join core.territories as t on t.id = e.territory_id
        where ${entityWhere}
      )
      select sum(d.population)::text as total
      from d
      ${restriction}
    `.execute(db);
    return toDecimal(res.rows);
  };

  const scopedPopulation = async (
    scope: PopulationScope
  ): Promise<Result<Decimal | null, ApiError>> => {
    try {
      switch (scope.kind) {
        case 'territoriesUnion':
        case 'countiesUnion':
          return ok(toDecimal((await geographicPopulationUnionSql(scope).execute(db)).rows));
        case 'entityUnion':
          return ok(toDecimal((await entityPopulationUnionSql(scope.selection).execute(db)).rows));
        case 'country':
          // Served by the usecase from the reference-data port; never queried here.
          return ok(null);
        case 'entities':
          // The caller named the entities: their territories as they are
          // (a county council → its county row). Not level-restricted.
          return ok(
            await byEntityTerritories(sql`${sql.ref('e.cui')} in (${sql.join(scope.cuis)})`, 'all')
          );
        case 'territories': {
          // The caller named the territory ids: summed as they are (legacy).
          // A list mixing a county row / 179132 with its parts double-counts.
          const res = await sql<TotalRow>`
            select sum(${sql.ref('t.population')})::text as total
            from core.territories as t
            where ${sql.ref('t.id')} in (${sql.join(scope.ids)})
          `.execute(db);
          return ok(toDecimal(res.rows));
        }
        case 'counties':
          return ok(await byCounties(scope.codes));
        case 'entityTypes': {
          if (scope.types.includes(ENTITY_COUNTY_COUNCIL_TYPE)) {
            const counties = await sql<CountyRow>`
              select distinct ${sql.ref('t.county_code')} as county_code
              from core.public_entities as e
              join core.territories as t on t.id = e.territory_id
              where ${sql.ref('e.entity_type')} = ${ENTITY_COUNTY_COUNCIL_TYPE}
            `.execute(db);
            return ok(await byCounties(counties.rows.map((r) => r.county_code)));
          }
          const typeIn = sql`${sql.ref('e.entity_type')} in (${sql.join(scope.types)})`;
          const where =
            scope.isUat === undefined
              ? typeIn
              : sql`${typeIn} and ${sql.ref('e.is_uat')} = ${scope.isUat}`;
          return ok(await byEntityTerritories(where, 'uat-level'));
        }
        case 'allUats':
          return ok(await byEntityTerritories(sql`${sql.ref('e.is_uat')} = true`, 'uat-level'));
      }
    } catch (error) {
      return err(
        databaseError(
          `Failed to fetch filtered population: ${error instanceof Error ? error.message : String(error)}`,
          error
        )
      );
    }
  };

  return { scopedPopulation };
};
