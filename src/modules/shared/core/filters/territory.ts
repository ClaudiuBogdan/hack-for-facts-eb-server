/**
 * Shared Kernel — cui→territory filter builder (foundation §4.2, §15.3).
 *
 * Compiles geographic filter VALUES (region / countyCode / siruta / isUat /
 * population range) into a single PARAMETERIZED SQL predicate over a caller-
 * supplied CUI column, via the canonical identity→territory join:
 *
 *     core.public_entities pe (cui)
 *       → pe.territorial_siruta_code = t.territorial_siruta_code
 *       → core.territories t
 *
 * The predicate is an `IN (SELECT pe.cui FROM core.public_entities pe …)`
 * semijoin (Postgres plans it as a Nested Loop Semi Join: index seek on
 * `public_entities_pkey` then `territories_territorial_siruta_code_key`), so a
 * source module can geo-filter its OWN rows WITHOUT joining `core.*` itself
 * (§3 keeps core private to the kernel).
 *
 * SECURITY: every value is parameterized via Kysely `sql``` (never concatenated);
 * the only identifier this module emits is the caller's CUI column reference,
 * validated by `safeColumnRef`. `territoriesJoined` is false when only `isUat`
 * is requested (it lives on `public_entities`), so we skip the `territories`
 * join — a measured prune, not a correctness shortcut.
 */

import { sql } from 'kysely';

import { andConditions, safeColumnRef } from './composer.js';

import type { FilterColumn, SqlCondition } from './types.js';

/**
 * Geographic filter values, already coerced/validated by the caller. Every
 * field is optional; an absent field contributes no predicate. Arrays mean
 * "membership" (compiled as `IN (…)`); `excludeRegion`/`excludeSiruta`/etc.
 * negate the matching dimension. Population is an inclusive numeric range.
 *
 * The shape is intentionally flat (not a generic op-map): the territory hub
 * exposes a FIXED, small set of geographic dimensions, so a declarative struct
 * is clearer and safer than re-deriving op semantics here.
 */
export interface TerritoryFilterValues {
  readonly region?: readonly string[];
  readonly excludeRegion?: readonly string[];
  readonly countyCode?: readonly string[];
  readonly excludeCountyCode?: readonly string[];
  /** Matched against `core.territories.territorial_siruta_code` (the canonical join key). */
  readonly siruta?: readonly string[];
  readonly excludeSiruta?: readonly string[];
  /** `core.public_entities.is_uat` (does NOT need the territories join). */
  readonly isUat?: boolean;
  readonly populationMin?: number;
  readonly populationMax?: number;
}

/** True when any geographic dimension is actually set (so callers can skip the join entirely). */
export const hasTerritoryFilter = (v: TerritoryFilterValues): boolean =>
  (v.region !== undefined && v.region.length > 0) ||
  (v.excludeRegion !== undefined && v.excludeRegion.length > 0) ||
  (v.countyCode !== undefined && v.countyCode.length > 0) ||
  (v.excludeCountyCode !== undefined && v.excludeCountyCode.length > 0) ||
  (v.siruta !== undefined && v.siruta.length > 0) ||
  (v.excludeSiruta !== undefined && v.excludeSiruta.length > 0) ||
  v.isUat !== undefined ||
  v.populationMin !== undefined ||
  v.populationMax !== undefined;

/** True when any requested dimension lives on `core.territories` (so the join is required). */
const needsTerritoriesJoin = (v: TerritoryFilterValues): boolean =>
  (v.region !== undefined && v.region.length > 0) ||
  (v.excludeRegion !== undefined && v.excludeRegion.length > 0) ||
  (v.countyCode !== undefined && v.countyCode.length > 0) ||
  (v.excludeCountyCode !== undefined && v.excludeCountyCode.length > 0) ||
  (v.siruta !== undefined && v.siruta.length > 0) ||
  (v.excludeSiruta !== undefined && v.excludeSiruta.length > 0) ||
  v.populationMin !== undefined ||
  v.populationMax !== undefined;

/** `col IN (v1, v2, …)` — values parameterized; empty arrays are handled by the caller. */
const inList = (col: SqlCondition, values: readonly string[]): SqlCondition =>
  sql`${col} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

/**
 * Build the inner-`SELECT` conditions over the `pe`/`t` aliases. Inclusion
 * dimensions AND together; exclusion dimensions negate their own membership.
 * An empty include array means "match nothing" → FALSE (mirrors the kernel
 * composer's empty-`in` rule), so a deliberately-empty filter never widens to
 * all rows.
 */
const innerConditions = (v: TerritoryFilterValues): SqlCondition[] => {
  const conds: SqlCondition[] = [];
  const region = sql`t.region`;
  const county = sql`t.county_code`;
  const siruta = sql`t.territorial_siruta_code`;
  const population = sql`t.population`;
  const isUat = sql`pe.is_uat`;

  const includeMembership = (col: SqlCondition, values: readonly string[] | undefined): void => {
    if (values === undefined) return;
    if (values.length === 0) conds.push(sql`false`);
    else conds.push(inList(col, values));
  };
  const excludeMembership = (col: SqlCondition, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) return;
    conds.push(sql`not (${inList(col, values)})`);
  };

  includeMembership(region, v.region);
  excludeMembership(region, v.excludeRegion);
  includeMembership(county, v.countyCode);
  excludeMembership(county, v.excludeCountyCode);
  includeMembership(siruta, v.siruta);
  excludeMembership(siruta, v.excludeSiruta);

  if (v.isUat !== undefined) conds.push(sql`${isUat} = ${v.isUat}`);
  if (v.populationMin !== undefined) conds.push(sql`${population} >= ${v.populationMin}`);
  if (v.populationMax !== undefined) conds.push(sql`${population} <= ${v.populationMax}`);

  return conds;
};

/**
 * Compile a `<cuiColumn> IN (SELECT pe.cui FROM core.public_entities pe [JOIN
 * core.territories t …] WHERE …)` predicate, or `undefined` when no geographic
 * dimension is set (the caller then omits the predicate entirely).
 *
 * @param cuiColumn the source's CUI column to constrain (e.g. `{ alias: 'ces',
 *        column: 'cui' }`). Validated by `safeColumnRef` — a malformed identifier
 *        is a programming error and throws, exactly as the rest of the composer.
 */
export const buildTerritoryCuiPredicate = (
  cuiColumn: FilterColumn,
  values: TerritoryFilterValues
): SqlCondition | undefined => {
  if (!hasTerritoryFilter(values)) return undefined;
  const cuiRef = safeColumnRef(cuiColumn);
  const where = andConditions(innerConditions(values));
  const from = needsTerritoriesJoin(values)
    ? sql`core.public_entities pe
        join core.territories t on t.territorial_siruta_code = pe.territorial_siruta_code`
    : sql`core.public_entities pe`;
  return sql`${cuiRef} in (select pe.cui from ${from} where ${where})`;
};
