/** Reuse the grouped denominator membership and ancestor-suppression contract. */
import { sql, type Kysely } from 'kysely';

import {
  entityPopulationSelectionSql,
  geographicPopulationSelectionSql,
  selectedPopulationAnchorIdsSql,
} from './population-union.js';

import type { GroupedPopulationScope } from '../../core/legacy-analytics/population.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

export async function readGroupedPopulationAnchors(
  db: Kysely<ProdDatabase>,
  scope: GroupedPopulationScope
): Promise<readonly number[] | null> {
  if (scope.kind === 'country') {
    const { rows } = await sql<{
      id: number;
    }>`select id from core.territories where level = 'country' and kind = 'country' and nuts_code = 'RO' and territory_key = 'nuts:RO' and parent_id is null and privacy_class = 'public'`.execute(
      db
    );
    return rows.length === 1 ? rows.map((row) => row.id) : null;
  }
  const selection =
    scope.kind === 'entityUnion'
      ? entityPopulationSelectionSql(scope.selection)
      : geographicPopulationSelectionSql(scope);
  return (await selectedPopulationAnchorIdsSql(selection).execute(db)).rows[0]?.ids ?? null;
}
