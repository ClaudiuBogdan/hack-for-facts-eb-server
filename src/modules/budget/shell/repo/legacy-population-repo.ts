/**
 * Filter-wide per-capita population over the kernel hubs — the port of the
 * legacy `KyselyPopulationRepo` (normalization/shell/repo/population-repo.ts)
 * onto `core.public_entities` (`e`) + `core.territories` (`t`), joined through
 * `e.territorial_siruta_code = t.territorial_siruta_code` (uats.id ≡ t.id).
 *
 * Rules kept verbatim: entity CUIs → their territories' population
 * (:169-178); uat ids → direct (:183-196); county codes → the county-level
 * territory rows (:202-218: `siruta_code = county_code`, Bucharest via SIRUTA
 * 179132 — verified live 2026-09-02: 41 county rows + 1 Bucharest row =
 * 19,053,815); entity types with `admin_county_council` → the counties those
 * councils sit in (:226-249; INERT on Chronos: 0 entities carry that type
 * today); other entity types → their territories (:252-271); `is_uat` alone →
 * every UAT entity's territory (:277-286).
 *
 * Intentional deltas (documented in docs/server-redesign/13 §7):
 *
 *  - PER-CAPITA DENOMINATOR (codex 2026-09-02 finding 1, program §1.17).
 *    Legacy summed `SUM(DISTINCT u.population)` (:173, :256, :267, :281) —
 *    deduplicating by VALUE — over a hierarchy that mixes levels: the 41 county
 *    rows and Bucharest municipality (179132) sit in the same set as the UATs and
 *    sectors they contain. Measured on Chronos 2026-09-02 for `is_uat = true`:
 *      · legacy `SUM(DISTINCT population)`  = 36,237,856 over 3,228 territories
 *        (each person counted ≈1.9×; equal populations collapsed);
 *      · deduplicated by `t.id`              = 38,107,630 over 3,228 (still 2×);
 *      · `UAT_LEVEL_UNIVERSE` below          = 19,053,815 over 3,186 rows
 *        = the county-row national total (YAML `population_ro` 2023: 19,050,000).
 *    So `byEntityTerritories` deduplicates by `t.id` and, for the `allUats` and
 *    `entityTypes` scopes, restricts the set to the UAT-level universe: EXCLUDE
 *    county rows (`t.siruta_code = t.county_code`, 41 rows = 17,336,832) and
 *    EXCLUDE Bucharest municipality 179132 (1,716,983) when any of its six
 *    sectors is in the same set (the sectors sum to exactly the municipality).
 *    Per-capita values on these scopes roughly DOUBLE vs Phoenix. Numerators are
 *    untouched (the `is_uat` / `entity_types` filters are filter semantics, not
 *    a bug — program §1.17 notes L2's `is_uat` redefinition moves them later).
 *    `entities` (entity_cuis) and `territories` (uat_ids) scopes are NOT
 *    restricted: the caller named the rows, and a county-council CUI or a
 *    county `uat_id` legitimately means that county's population — a list that
 *    mixes a container with its parts double-counts, as it did in legacy (risk
 *    documented, not fixed here). The county-council path keeps the county
 *    populations as is.
 *  - a database error is returned (the caller aborts) instead of silently
 *    disabling per-capita and serving nominal values under a "/capita" label
 *    (legacy `normalization/core/population.ts:37-51`).
 *  - the COUNTRY denominator is served by the usecase from the reference-data
 *    port (`population_ro`), not from the county-row sum (:63-83) — program D2:
 *    19,050,000 (YAML 2023) vs 19,053,815 (county rows), a ×1.0002 shift.
 */

import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { BUCHAREST_COUNTY_CODE, BUCHAREST_SIRUTA_CODE } from '../../core/constants.js';
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
const countyLevelRow = sql`(
  (${sql.ref('t.county_code')} = ${BUCHAREST_COUNTY_CODE} and ${sql.ref('t.siruta_code')} = ${BUCHAREST_SIRUTA_CODE})
  or (${sql.ref('t.county_code')} <> ${BUCHAREST_COUNTY_CODE} and ${sql.ref('t.siruta_code')} = ${sql.ref('t.county_code')})
)`;

/**
 * UAT_LEVEL_UNIVERSE — the level-safe population universe over a deduplicated
 * territory set `d(id, population, siruta_code, county_code)`:
 *   · not a county row (`siruta_code = county_code`);
 *   · not Bucharest municipality 179132 when any of its sectors (county 'B',
 *     `siruta_code <> 179132`) is in the SAME set `d`.
 * Measured on Chronos 2026-09-02 over the `is_uat = true` entities: 3,186 rows,
 * 19,053,815 persons (= the national county-row total).
 *
 * PRE-D1 PROXY — replace by `territories.level = 'uat'` once program D1 lands
 * the territory hierarchy (`core.territories.level`); the numbers above are the
 * acceptance check for that swap.
 */
const uatLevelUniverse = sql`(
  ${sql.ref('d.siruta_code')} <> ${sql.ref('d.county_code')}
  and not (
    ${sql.ref('d.siruta_code')} = ${BUCHAREST_SIRUTA_CODE}
    and exists (
      select 1 from d as s
      where ${sql.ref('s.county_code')} = ${BUCHAREST_COUNTY_CODE}
        and ${sql.ref('s.siruta_code')} <> ${BUCHAREST_SIRUTA_CODE}
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
    const res = await sql<TotalRow>`
      select sum(${sql.ref('t.population')})::text as total
      from core.territories as t
      where ${sql.ref('t.county_code')} in (${sql.join(codes)})
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
          ${sql.ref('t.siruta_code')} as siruta_code,
          ${sql.ref('t.county_code')} as county_code
        from core.public_entities as e
        join core.territories as t on t.territorial_siruta_code = e.territorial_siruta_code
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
              join core.territories as t on t.territorial_siruta_code = e.territorial_siruta_code
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
