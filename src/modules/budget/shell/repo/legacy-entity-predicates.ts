/** Shared entity/geography predicates for fact numerators and anchor-union population.
 * Fact-only period, report, creditor, classification and money filters stay outside.
 */
import { sql, type RawBuilder } from 'kysely';

import { escapeLike } from '@/modules/shared/index.js';

import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

type Cond = RawBuilder<unknown>;
const inList = (col: Cond, values: readonly (string | number)[]): Cond =>
  values.length === 0 ? sql`false` : sql`${col} in (${sql.join(values)})`;
const notInNullSafe = (col: Cond, values: readonly (string | number)[]): Cond =>
  values.length === 0 ? sql`true` : sql`(${col} is null or ${col} not in (${sql.join(values)}))`;
const tagContains = (tag: string): Cond =>
  sql`${sql.ref('e.tags')} @> ${JSON.stringify([{ tag }])}::jsonb`;

export const legacyEntityConditions = (
  q: LegacyAggregateQuery,
  cuiColumn: 'eli.entity_cui' | 'e.cui'
): Cond[] => {
  const conds: Cond[] = [];
  if (q.entityCuis !== undefined) conds.push(inList(sql.ref(cuiColumn), q.entityCuis));
  // ── entity scope (legacy buildEntityConditions; `e` = core.public_entities) ──
  if (q.entityTypes !== undefined) conds.push(inList(sql.ref('e.entity_type'), q.entityTypes));
  if (q.isUat !== undefined) conds.push(sql`${sql.ref('e.is_uat')} = ${q.isUat}`);
  if (q.isTerritorialExecutive !== undefined) {
    conds.push(sql`${sql.ref('e.is_territorial_executive')} = ${q.isTerritorialExecutive}`);
  }
  if (q.uatIds !== undefined) conds.push(inList(sql.ref('t.id'), q.uatIds));
  if (q.search !== undefined) {
    conds.push(sql`${sql.ref('e.name')} ilike ${'%' + escapeLike(q.search) + '%'}`);
  }
  if (q.tagFacets !== undefined) {
    for (const facet of q.tagFacets) {
      const ors = facet.map(tagContains);
      conds.push(
        ors.length === 1 && ors[0] !== undefined ? ors[0] : sql`(${sql.join(ors, sql` or `)})`
      );
    }
  }

  // ── territory scope (legacy buildUatConditions; `t` = core.territories) ──
  if (q.countyCodes !== undefined) conds.push(inList(sql.ref('t.county_code'), q.countyCodes));
  if (q.regions !== undefined) conds.push(inList(sql.ref('t.region'), q.regions));
  if (q.minPopulation !== undefined) {
    conds.push(sql`${sql.ref('t.population')} >= ${q.minPopulation}`);
  }
  if (q.maxPopulation !== undefined) {
    conds.push(sql`${sql.ref('t.population')} <= ${q.maxPopulation}`);
  }

  const ex = q.exclude;
  if (ex !== undefined) {
    if (ex.entityCuis !== undefined) conds.push(notInNullSafe(sql.ref(cuiColumn), ex.entityCuis));
    if (ex.entityTypes !== undefined) {
      conds.push(notInNullSafe(sql.ref('e.entity_type'), ex.entityTypes));
    }
    if (ex.uatIds !== undefined) conds.push(notInNullSafe(sql.ref('t.id'), ex.uatIds));
    if (ex.tags !== undefined) {
      const tags = sql.ref('e.tags');
      conds.push(sql`(${tags} is null or not (${sql.join(ex.tags.map(tagContains), sql` or `)}))`);
    }
    if (ex.countyCodes !== undefined) {
      conds.push(notInNullSafe(sql.ref('t.county_code'), ex.countyCodes));
    }
    if (ex.regions !== undefined) conds.push(notInNullSafe(sql.ref('t.region'), ex.regions));
  }
  return conds;
};
