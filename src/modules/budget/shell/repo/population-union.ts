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

import { andConditions } from '@/modules/shared/index.js';

import { legacyEntityConditions } from './legacy-entity-predicates.js';

import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

export const entityPopulationUnionSql = (
  q: LegacyAggregateQuery
): RawBuilder<{ total: string | null }> => sql`
  with recursive matched as materialized (
    select e.cui, t.id, t.parent_id, t.level, t.territorial_siruta_code, t.population
    from core.public_entities e
    left join core.territories t on t.id = e.territory_id
    where ${andConditions(legacyEntityConditions(q, 'e.cui'))}
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
  select case
    when not exists (select 1 from invalid)
      and count(*) > 0
      and count(population) = count(*)
      and min(population) > 0
    then sum(population)::text else null
  end as total
  from retained
`;
