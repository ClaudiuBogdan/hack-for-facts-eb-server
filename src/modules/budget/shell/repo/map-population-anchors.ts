/** Canonical ancestor pruning per exact scope, batched in one statement. */
import { sql, type Kysely } from 'kysely';

import { selectedPopulationAnchorIdsSql } from './population-union.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

export async function readMapPopulationAnchorSets(
  db: Kysely<ProdDatabase>,
  sets: readonly (readonly number[])[]
): Promise<readonly (readonly number[] | null)[]> {
  if (sets.length === 0) return [];
  const union = selectedPopulationAnchorIdsSql(sql`
    select t.id, t.parent_id, t.level, t.territorial_siruta_code, t.population
    from jsonb_array_elements_text(scopes.ids) requested(id)
    left join core.territories t on t.id = requested.id::int and t.privacy_class = 'public'
  `);
  const result = await sql<{ ids: number[] | null }>`
    select retained.ids
    from jsonb_array_elements(${JSON.stringify(sets)}::jsonb) with ordinality scopes(ids, position)
    cross join lateral (${union}) retained
    order by scopes.position
  `.execute(db);
  return result.rows.map((row) => row.ids);
}
