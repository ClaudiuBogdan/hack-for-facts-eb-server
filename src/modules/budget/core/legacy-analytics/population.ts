/**
 * The per-capita denominator scope (legacy `getDenominatorPopulation` +
 * `computeFilteredPopulation` priority), decided in core; the shell executes
 * the matching read over `core.public_entities` / `core.territories`.
 */

import type { LegacyAggregateQuery, PopulationScope } from './types.js';

export const resolvePopulationScope = (q: LegacyAggregateQuery): PopulationScope => {
  // Legacy `hasEntityFilter`: entity_cuis | uat_ids | county_codes | is_uat | entity_types.
  const hasEntityFilter =
    q.entityCuis !== undefined ||
    q.uatIds !== undefined ||
    q.countyCodes !== undefined ||
    q.isUat !== undefined ||
    q.entityTypes !== undefined;
  if (!hasEntityFilter) return { kind: 'country' };

  // Legacy `computeFilteredPopulation` priority order.
  if (q.entityCuis !== undefined) return { kind: 'entities', cuis: q.entityCuis };
  if (q.uatIds !== undefined) return { kind: 'territories', ids: q.uatIds };
  if (q.countyCodes !== undefined) return { kind: 'counties', codes: q.countyCodes };
  if (q.entityTypes !== undefined) {
    return {
      kind: 'entityTypes',
      types: q.entityTypes,
      ...(q.isUat !== undefined && { isUat: q.isUat }),
    };
  }
  if (q.isUat === true) return { kind: 'allUats' };
  // `is_uat: false` alone: legacy fell back to the country population.
  return { kind: 'country' };
};
