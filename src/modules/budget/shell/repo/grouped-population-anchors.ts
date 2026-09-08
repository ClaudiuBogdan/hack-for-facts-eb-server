/** Reuse the grouped denominator membership and ancestor-suppression contract. */
import { sql, type Kysely } from 'kysely';

import {
  entityPopulationSelectionSql,
  legacyEntityTerritorySelectionSql,
  geographicPopulationSelectionSql,
  selectedPopulationAnchorIdsSql,
} from './population-union.js';

import type { PopulationScope } from '../../core/legacy-analytics/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

export async function readGroupedPopulationAnchors(
  db: Kysely<ProdDatabase>,
  scope: PopulationScope
): Promise<readonly number[] | null> {
  if (scope.kind === 'country') {
    const { rows } = await sql<{
      id: number;
    }>`select id from core.territories where level = 'country' and kind = 'country' and nuts_code = 'RO' and territory_key = 'nuts:RO' and parent_id is null and privacy_class = 'public'`.execute(
      db
    );
    return rows.length === 1 ? rows.map((row) => row.id) : null;
  }
  let selection;
  if (scope.kind === 'entityUnion') selection = entityPopulationSelectionSql(scope.selection);
  else if (scope.kind === 'entities') {
    if (scope.cuis.length === 0) return null;
    selection = sql`
      select t.id, t.parent_id, t.level, t.territorial_siruta_code, t.population
      from (select distinct cui from (values ${sql.join(scope.cuis.map((cui) => sql`(${cui}::text)`))}) v(cui)) requested
      left join core.public_entities e on e.cui = requested.cui
      left join core.territories t on t.id = e.territory_id
    `;
  } else if (scope.kind === 'entityTypes' || scope.kind === 'allUats') {
    if (scope.kind === 'entityTypes' && scope.types.includes('admin_county_council')) {
      const { rows } = await sql<{ county_code: string | null }>`
        select distinct t.county_code from core.public_entities e
        left join core.territories t on t.id = e.territory_id
        where e.entity_type = 'admin_county_council'
      `.execute(db);
      if (rows.some((row) => row.county_code === null)) return null;
      selection = geographicPopulationSelectionSql({
        kind: 'countiesUnion',
        codes: rows.flatMap((row) => (row.county_code === null ? [] : [row.county_code])),
      });
    } else {
      if (scope.kind === 'entityTypes' && scope.types.length === 0) return null;
      const where =
        scope.kind === 'allUats'
          ? sql`e.is_uat = true`
          : sql`
        e.entity_type in (${sql.join(scope.types)})
        ${scope.isUat === undefined ? sql`` : sql`and e.is_uat = ${scope.isUat}`}
      `;
      selection = legacyEntityTerritorySelectionSql(where, 'uat-level');
    }
  } else
    selection =
      scope.kind === 'territories' || scope.kind === 'territoriesUnion'
        ? geographicPopulationSelectionSql({ kind: 'territoriesUnion', ids: scope.ids })
        : geographicPopulationSelectionSql({ kind: 'countiesUnion', codes: scope.codes });
  return (await selectedPopulationAnchorIdsSql(selection).execute(db)).rows[0]?.ids ?? null;
}
