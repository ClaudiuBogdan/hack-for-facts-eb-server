import { sql, type RawBuilder } from 'kysely';

import { publishedAnnualPopulation } from '@/modules/shared/index.js';

import { groupedYears } from '../../core/legacy-analytics/grouped-usecase.js';

import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

/** Preserve institution-territory filtering, using the latest selected year's population. */
export function mapPopulationFilter(query: LegacyAggregateQuery) {
  const { minPopulation, maxPopulation, ...filter } = query;
  const conditions: RawBuilder<boolean>[] = [];
  if (minPopulation !== undefined || maxPopulation !== undefined) {
    const year = Math.max(...groupedYears(query.period));
    if (!Number.isFinite(year)) conditions.push(sql<boolean>`false`);
    else
      conditions.push(sql<boolean>`exists (
      select 1 from ${publishedAnnualPopulation} p
      where p.territory_id=e.territory_id and p.applied_year=${year}
        and t.privacy_class='public'
        ${minPopulation === undefined ? sql`` : sql`and p.population>=${minPopulation}`}
        ${maxPopulation === undefined ? sql`` : sql`and p.population<=${maxPopulation}`}
    )`);
  }
  return { filter, conditions };
}
