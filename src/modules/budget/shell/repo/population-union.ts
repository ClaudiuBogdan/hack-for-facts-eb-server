/**
 * Population of selected administrative anchors, not institutions' service areas.
 * New executive-field requests opt in; old saved requests retain their contract.
 * Parent traversal and coverage checks share one statement/snapshot. The derived
 * closure is not used, because missing closure edges could inflate the sum.
 * Territory predicates intentionally exclude unmatched anchors just as they do
 * in the numerator. Without such predicates the left join preserves missing
 * anchors, so the invalid guard rejects incomplete coverage.
 */
import { sql, type RawBuilder } from 'kysely';

import {
  andConditions,
  isCountyTerritory,
  isUatPresentationTerritory,
} from '@/modules/shared/index.js';

import { legacyEntityConditions } from './legacy-entity-predicates.js';
import { BUCHAREST_SIRUTA_CODE } from '../../core/constants.js';

import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

/** One union kernel; selection must retain missing requested anchors as NULL IDs. */
const populationUnionCtes = (selection: RawBuilder<unknown>): RawBuilder<unknown> => sql`
  with recursive matched as materialized (${selection}
  ), selected as (
    select distinct id, parent_id, level, territorial_siruta_code, population
    from matched where id is not null
  ), walk (origin_id, id, parent_id, level, territorial_siruta_code) as (
    select id, id, parent_id, level, territorial_siruta_code from selected
    union all
    select w.origin_id, p.id, p.parent_id, p.level, p.territorial_siruta_code
    from walk w
    left join core.territories p on p.id = w.parent_id
    where w.parent_id is not null
  ) cycle id set is_cycle using visited_path,
  retained as (
    select d.* from selected d
    where not exists (
      select 1 from walk w join selected ancestor on ancestor.id = w.id
      where w.origin_id = d.id and w.id <> d.id
    )
  ), invalid as (
    select 1 from matched where id is null
    union all
    select 1 from walk w
    where w.is_cycle or w.id is null or w.level is null
      or (w.parent_id is null and not coalesce((
        w.level = 'country'
        or (w.level = 'county' and not exists (
          select 1 from core.territories root where root.level = 'country'
        ))
        or (w.level = 'uat' and w.territorial_siruta_code = '179132'
          and not exists (
            select 1 from core.territories root where root.level = 'country'
          )
          and not exists (
            select 1 from core.territories county
            where county.level = 'county' and county.county_code = 'B'
          ))
      ), false))
  )
`;

export const selectedPopulationUnionSql = (
  selection: RawBuilder<unknown>
): RawBuilder<{ total: string | null }> => sql`
  ${populationUnionCtes(selection)}
  select case
    when not exists (select 1 from invalid)
      and count(*) > 0
      and count(population) = count(*)
      and min(population) > 0
    then sum(population)::text else null
  end as total
  from retained
`;

/** The same containment proof, without using snapshot population as a denominator. */
export const selectedPopulationAnchorIdsSql = (
  selection: RawBuilder<unknown>
): RawBuilder<{ ids: number[] | null }> => sql`
  ${populationUnionCtes(selection)}
  select case when not exists (select 1 from invalid) and count(*) > 0
    then array_agg(id order by id) else null end as ids
  from retained
`;

export const entityPopulationSelectionSql = (q: LegacyAggregateQuery): RawBuilder<unknown> => sql`
    select t.id, t.parent_id, t.level, t.territorial_siruta_code, t.population
    from core.public_entities e
    ${q.search === undefined ? sql`` : sql`left join core.organizations o on o.cui = e.cui`}
    left join core.territories t on t.id = e.territory_id
    where ${andConditions(legacyEntityConditions(q, 'e.cui'))}
`;

export const entityPopulationUnionSql = (
  q: LegacyAggregateQuery
): RawBuilder<{ total: string | null }> =>
  selectedPopulationUnionSql(entityPopulationSelectionSql(q));

export const geographicPopulationSelectionSql = (
  scope:
    | { readonly kind: 'territoriesUnion'; readonly ids: readonly number[] }
    | { readonly kind: 'countiesUnion'; readonly codes: readonly string[] }
): RawBuilder<unknown> => {
  const values = scope.kind === 'territoriesUnion' ? scope.ids : scope.codes;
  if (values.length === 0)
    return sql`select null::int as id, null::int as parent_id, null::text as level, null::text as territorial_siruta_code, null::numeric as population`;
  const keys = values.map((value) =>
    scope.kind === 'territoriesUnion' ? sql`(${value}::int)` : sql`(${value}::text)`
  );
  const match =
    scope.kind === 'territoriesUnion'
      ? sql`t.id = requested.key`
      : sql`t.county_code = requested.key and ${isCountyTerritory('t')}`;
  return sql`
    select case when count(*) over (partition by requested.key) = 1 then t.id else null end as id,
      t.parent_id, t.level, t.territorial_siruta_code, t.population
    from (select distinct key from (values ${sql.join(keys)}) input(key)) requested
    left join core.territories t on ${match}
  `;
};

export const geographicPopulationUnionSql = (
  scope: Parameters<typeof geographicPopulationSelectionSql>[0]
): RawBuilder<{ total: string | null }> =>
  selectedPopulationUnionSql(geographicPopulationSelectionSql(scope));

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

/** Retain the carried entity-type/all-UAT universe before native ancestor suppression. */
export const legacyEntityTerritorySelectionSql = (
  entityWhere: RawBuilder<unknown>,
  universe: 'all' | 'uat-level'
): RawBuilder<unknown> => sql`
  with d as (
    select distinct t.id, t.population, t.territorial_siruta_code, t.level, t.kind, t.parent_id
    from core.public_entities e
    left join core.territories t on t.id = e.territory_id
    where ${entityWhere}
  )
  select id, population, territorial_siruta_code, level, parent_id from d
  ${universe === 'uat-level' ? sql`where id is null or ${uatLevelUniverse}` : sql``}
`;
