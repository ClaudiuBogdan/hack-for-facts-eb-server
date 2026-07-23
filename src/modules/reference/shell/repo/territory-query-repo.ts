/**
 * Reference module — TerritoryQueryRepo over `core.territories` (plan §2.2/§3.3).
 *
 * Adds ONLY the queries the kernel `TerritoryRepo` lacks: a surrogate-id lookup, a
 * filtered cursor browse, and the rich county/region rollups (uatCount/population).
 * Everything the kernel repo already provides (byTerritorialSiruta, byCounty,
 * searchUat) is reused from the kernel — not re-implemented here (§0). Cursor lists
 * order by `(sortValue, id)` (the unique PK tiebreak). The `isUat` and `isCounty`
 * filters are VIRTUAL and intercepted (the kernel composer never sees them).
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type FilterInput,
  type ProdDatabase,
  type Territory,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { boolEq, fieldOf, omitVirtualFields } from './filter-helpers.js';
import {
  REFERENCE_TERRITORY_VIRTUAL_FIELDS,
  referenceTerritoryFilterSpec,
} from '../../core/filters.js';

import type { CountedCursorPage, CursorPageRequest, TerritoryQueryRepo } from '../../core/ports.js';
import type { ReferenceCounty, ReferenceRegion } from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);

const TERRITORY_COLUMNS = [
  't.id',
  't.territorial_siruta_code',
  't.siruta_code',
  't.county_siruta_code',
  't.uat_code',
  't.name',
  't.county_code',
  't.county_name',
  't.region',
  't.population',
] as const;

interface TerritoryRow {
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
}

const mapTerritory = (r: TerritoryRow): Territory => ({
  id: r.id,
  territorialSirutaCode: r.territorial_siruta_code,
  sirutaCode: r.siruta_code,
  countySirutaCode: r.county_siruta_code,
  uatCode: r.uat_code,
  name: r.name,
  countyCode: r.county_code,
  countyName: r.county_name,
  region: r.region,
  population: r.population,
});

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const SORT_COLUMN: Record<string, { col: string; dir: 'asc' | 'desc' }> = {
  name: { col: 't.name', dir: 'asc' },
  population: { col: 't.population', dir: 'desc' },
  county_code: { col: 't.county_code', dir: 'asc' },
};
const DEFAULT_TERR_SORT = { col: 't.name', dir: 'asc' } as const;

/**
 * The cursor direction for a territory sort field — the SINGLE source of truth the
 * GraphQL resolver reuses when re-encoding edge cursors (see public-entity-repo).
 */
export const territorySortDir = (field: string): 'asc' | 'desc' =>
  (SORT_COLUMN[field] ?? DEFAULT_TERR_SORT).dir;

/** A literal `<col> asc|desc nulls last` order expression (no sql.raw — dir is a controlled value). */
const orderByExpr = (col: string, dir: 'asc' | 'desc'): RawBuilder<unknown> => {
  const ref = sql.ref(col);
  return dir === 'asc' ? sql`${ref} asc nulls last` : sql`${ref} desc nulls last`;
};

export const makeTerritoryQueryRepo = (db: Db): TerritoryQueryRepo => {
  const isUatCondition = (input: FilterInput): RawBuilder<unknown> | undefined => {
    const v = boolEq(fieldOf(input, 'isUat'));
    if (v === true) return sql`t.uat_code is not null`;
    if (v === false) return sql`t.uat_code is null`;
    return undefined;
  };

  const isCountyCondition = (input: FilterInput): RawBuilder<unknown> | undefined => {
    const v = boolEq(fieldOf(input, 'isCounty'));
    const county = sql`(
      t.siruta_code = t.county_code
      or (t.county_code = 'B' and t.siruta_code = '179132')
    )`;
    if (v === true) return county;
    if (v === false) return sql`not ${county}`;
    return undefined;
  };

  const byId = async (id: number): Promise<Result<Territory | null, ApiError>> => {
    if (!Number.isInteger(id)) return ok(null);
    try {
      const row = await db
        .selectFrom('core.territories as t')
        .select([...TERRITORY_COLUMNS])
        .where('t.id', '=', id)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapTerritory(row));
    } catch (error) {
      return err(databaseError('byId failed', error));
    }
  };

  const list = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<Territory>, ApiError>> => {
    const sortField =
      page.sort !== undefined && page.sort in SORT_COLUMN
        ? page.sort
        : referenceTerritoryFilterSpec.sort.default;
    const def = SORT_COLUMN[sortField] ?? DEFAULT_TERR_SORT;
    const sortCol = def.col;
    const dir = def.dir;
    const limit = clampFirst(page.first);
    const fhash = fhashFor(referenceTerritoryFilterSpec, f);

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortField, dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const physical = omitVirtualFields(f, [...REFERENCE_TERRITORY_VIRTUAL_FIELDS]);
    const kernel = toConditionBuilders(referenceTerritoryFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    // `baseConds` (filters + virtual geography predicates) → COUNT(*) denominator;
    // `pageConds` adds the
    // keyset predicate for the page slice only (so totalCount is the filtered total,
    // not "rows remaining after the cursor" — review BLOCKER).
    const baseConds = [...kernel.value];
    const isUat = isUatCondition(f);
    if (isUat !== undefined) baseConds.push(isUat);
    const isCounty = isCountyCondition(f);
    if (isCounty !== undefined) baseConds.push(isCounty);
    const pageConds = [...baseConds];
    if (cursorKeys?.length === 2) {
      pageConds.push(keysetPredicate(sortCol, dir, cursorKeys[0] ?? '', cursorKeys[1] ?? ''));
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('core.territories as t')
          .select([...TERRITORY_COLUMNS])
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(sortCol, dir))
          .orderBy('t.id', dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('core.territories as t')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(baseConds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapTerritory(r));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1] as TerritoryRow | undefined;
        if (last !== undefined) {
          const sv = sortColumnValue(sortField, last);
          next = buildNextCursor({ sort: sortField, dir, fhash, lastKeys: [sv, String(last.id)] });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('list failed', error));
    }
  };

  const listCountyRollups = async (): Promise<Result<readonly ReferenceCounty[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('core.territories as t')
        .select([
          't.county_code',
          sql<string | null>`max(t.county_name)`.as('county_name'),
          sql<string | null>`max(t.region)`.as('region'),
          sql<string>`count(*) filter (where t.uat_code is not null)`.as('uat_count'),
          sql<string | null>`sum(t.population)`.as('population'),
        ])
        .where('t.county_code', 'is not', null)
        .groupBy('t.county_code')
        .orderBy(sql`max(t.county_name) asc`)
        .execute();
      return ok(
        rows
          .filter((r): r is typeof r & { county_code: string } => r.county_code !== null)
          .map((r) => ({
            countyCode: r.county_code,
            countyName: r.county_name ?? r.county_code,
            region: r.region,
            uatCount: Number(r.uat_count),
            population: r.population === null ? null : Number(r.population),
          }))
      );
    } catch (error) {
      return err(databaseError('listCountyRollups failed', error));
    }
  };

  const listRegionRollups = async (): Promise<Result<readonly ReferenceRegion[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('core.territories as t')
        .select([
          't.region',
          sql<string>`count(distinct t.county_code)`.as('county_count'),
          sql<string>`count(*) filter (where t.uat_code is not null)`.as('uat_count'),
        ])
        .where('t.region', 'is not', null)
        .groupBy('t.region')
        .orderBy('t.region', 'asc')
        .execute();
      return ok(
        rows
          .filter((r): r is typeof r & { region: string } => r.region !== null)
          .map((r) => ({
            region: r.region,
            countyCount: Number(r.county_count),
            uatCount: Number(r.uat_count),
          }))
      );
    } catch (error) {
      return err(databaseError('listRegionRollups failed', error));
    }
  };

  return { byId, list, listCountyRollups, listRegionRollups };
};

// ── helpers ─────────────────────────────────────────────────────────────────

const sortColumnValue = (sortField: string, row: TerritoryRow): string => {
  if (sortField === 'population') return row.population === null ? '' : String(row.population);
  if (sortField === 'county_code') return row.county_code ?? '';
  return row.name;
};

const keysetPredicate = (
  sortCol: string,
  dir: 'asc' | 'desc',
  cVal: string,
  cKey: string
): RawBuilder<unknown> => {
  const col = sql.ref(sortCol);
  const cmp = dir === 'asc' ? sql`>` : sql`<`;
  if (cVal === '') {
    return sql`(${col} is null and t.id ${cmp} ${Number(cKey)})`;
  }
  return sql`(${col} ${cmp} ${cVal} or ${col} is null or (${col} = ${cVal} and t.id ${cmp} ${Number(cKey)}))`;
};
