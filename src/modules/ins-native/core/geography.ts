/** Resolve geographic intent without inferring identity from individual members. */
import { err, ok, type Result } from 'neverthrow';

import type { InsDimensionView, InsGeoScope, InsTerritorySelection } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export const observationGeoScope = (
  dimensions: readonly InsDimensionView[],
  selected: InsTerritorySelection,
  explicitPins: ReadonlyMap<number, readonly number[]>
): Result<InsGeoScope | null, ApiError> => {
  const geo = dimensions.filter((d) => d.isTerritorial).sort((a, b) => a.dimIndex - b.dimIndex);
  if (geo.some((d) => d.role !== 'classification' || d.slotIndex === null)) {
    return err({ type: 'ServiceUnavailable', message: 'INS dataset publication is unavailable' });
  }
  if (geo.length === 0) {
    const national =
      selected === null ||
      ('levels' in selected
        ? selected.levels.includes('NATIONAL')
        : selected.some((node) => node.level === 'NATIONAL'));
    return ok(national ? { kind: 'nonGeographic' } : null);
  }
  if (selected !== null) {
    if ('levels' in selected) return ok({ kind: 'modern', levels: selected.levels });
    return ok(
      selected.length === 0
        ? null
        : {
            kind: 'modern',
            territoryIds: [...new Set(selected.map((node) => node.territoryId))],
          }
    );
  }
  const pairs: [number, number][] = [];
  for (const dim of geo) {
    const ids = dim.slotIndex === null ? [] : [...new Set(explicitPins.get(dim.slotIndex) ?? [])];
    if (ids.length !== 1 || ids[0] === undefined) {
      return err({
        type: 'InvalidInput',
        field: 'filter',
        message:
          'Specify a territory or level, or explicitly pin every geographic dimension to one source member; implicit TOTAL does not select source geography',
      });
    }
    pairs.push([dim.dimIndex, ids[0]]);
  }
  return ok({ kind: 'explicitSource', pairs: [pairs] });
};
