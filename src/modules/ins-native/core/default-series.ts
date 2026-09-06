/** Pure default preparation. Geographic identity is decided by observed source tuples. */
import { err, ok, type Result } from 'neverthrow';

import type { InsDefaultPin } from './ports.js';
import type {
  InsDatasetView,
  InsDefaultSeriesRequest,
  InsDimensionView,
  InsMemberView,
  InsTerritoryNode,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS dataset publication is unavailable',
});
const invalidPreference = (message: string): ApiError => ({
  type: 'InvalidInput',
  field: 'preferredClassificationCodes',
  message,
});

export interface InsDefaultSelection {
  readonly request: InsDefaultSeriesRequest;
  readonly strategy: 'PREFERRED_CLASSIFICATION' | 'TOTAL_FALLBACK';
}

export interface InsExplicitSelection {
  readonly pinsByDimension: ReadonlyMap<number, number>;
  readonly unitNomItemId?: number;
}

export interface InsResolvedSelection {
  readonly nonGeographicPins: ReadonlyMap<number, number>;
  readonly unitNomItemId: number;
  readonly hasGeography: boolean;
}

export const buildInsSelection = (
  dataset: InsDatasetView,
  dimensions: readonly InsDimensionView[],
  defaults: readonly InsDefaultPin[],
  members: readonly InsMemberView[],
  explicit: InsExplicitSelection
): Result<InsResolvedSelection | null, ApiError> => {
  if (dataset.publicationStatus === 'NOT_LOADED') return ok(null);
  if (dataset.dataStatus !== 'AVAILABLE') return err(unavailable());
  const dims = dimensions.filter((dimension) => dimension.datasetCode === dataset.code);
  const classification = dims.filter((dimension) => dimension.role === 'classification');
  const units = dims.filter((dimension) => dimension.role === 'unit');
  const times = dims.filter((dimension) => dimension.role === 'time');
  const unit = units[0];
  if (
    dims.length !== dataset.dimensionCount ||
    classification.length !== dataset.classificationDimCount ||
    units.length !== 1 ||
    times.length !== 1 ||
    unit?.dimIndex !== dataset.unitDimIndex ||
    times[0]?.dimIndex !== dataset.timeDimIndex ||
    new Set(dims.map((dimension) => dimension.dimIndex)).size !== dims.length ||
    classification.some(
      (dimension) =>
        dimension.slotIndex === null || dimension.slotIndex < 1 || dimension.slotIndex > 7
    ) ||
    new Set(classification.map((dimension) => dimension.slotIndex)).size !== classification.length
  ) {
    return err(unavailable());
  }
  const byDim = new Map(dims.map((dimension) => [dimension.dimIndex, dimension]));
  const geo = classification.filter((dimension) => dimension.isTerritorial);
  const byMember = new Map(
    members
      .filter((member) => member.datasetCode === dataset.code)
      .map((member) => [JSON.stringify([member.dimIndex, member.nomItemId]), member])
  );
  for (const [dimIndex, id] of explicit.pinsByDimension) {
    const dimension = byDim.get(dimIndex);
    if (
      dimension?.role !== 'classification' ||
      dimension.isTerritorial ||
      !byMember.has(JSON.stringify([dimIndex, id]))
    )
      return err(invalidPreference('Choose one source member in each non-geographic dimension'));
  }
  if (
    explicit.unitNomItemId !== undefined &&
    !byMember.has(JSON.stringify([unit.dimIndex, explicit.unitNomItemId]))
  )
    return err(invalidPreference('Choose a source unit belonging to this dataset'));
  const defaultsByDim = new Map<number, number>();
  for (const pin of defaults) {
    if (pin.datasetCode !== dataset.code) continue;
    const dimension = byDim.get(pin.dimIndex);
    // Existing geographic TOTAL defaults have no authority over source tuples.
    if (dimension?.isTerritorial === true) continue;
    const member = byMember.get(JSON.stringify([pin.dimIndex, pin.nomItemId]));
    if (
      dimension === undefined ||
      member === undefined ||
      dimension.role === 'time' ||
      defaultsByDim.has(pin.dimIndex) ||
      (dimension.role === 'unit'
        ? !(
            pin.policy === 'MANIFEST' ||
            (pin.policy === 'SINGLE_UNIT' && dimension.optionCount === 1)
          )
        : !(
            pin.policy === 'MANIFEST' ||
            (pin.policy === 'TOTAL_MEMBER' && member.memberRole === 'TOTAL')
          ))
    ) {
      return err(unavailable());
    }
    defaultsByDim.set(pin.dimIndex, pin.nomItemId);
  }
  const unitId = explicit.unitNomItemId ?? defaultsByDim.get(unit.dimIndex);
  const pins = new Map<number, number>();
  for (const dimension of classification) {
    if (dimension.isTerritorial) continue;
    const id =
      explicit.pinsByDimension.get(dimension.dimIndex) ?? defaultsByDim.get(dimension.dimIndex);
    if (id === undefined) return ok(null);
    if (dimension.slotIndex === null) return err(unavailable());
    pins.set(dimension.slotIndex, id);
  }
  if (unitId === undefined) return ok(null);
  return ok({ nonGeographicPins: pins, unitNomItemId: unitId, hasGeography: geo.length > 0 });
};

/** Preserve the legacy preference API; exact map pairs never use global IDs. */
export const buildDefaultSeries = (
  dataset: InsDatasetView,
  dimensions: readonly InsDimensionView[],
  defaults: readonly InsDefaultPin[],
  members: readonly InsMemberView[],
  preferredIds: readonly number[],
  node: InsTerritoryNode
): Result<InsDefaultSelection | null, ApiError> => {
  if (dataset.publicationStatus === 'NOT_LOADED') return ok(null);
  if (dataset.dataStatus !== 'AVAILABLE') return err(unavailable());
  const byDim = new Map(
    dimensions.filter((d) => d.datasetCode === dataset.code).map((d) => [d.dimIndex, d])
  );
  const preferred = new Map<number, number>();
  for (const member of members) {
    if (member.datasetCode !== dataset.code || !preferredIds.includes(member.nomItemId)) continue;
    const dimension = byDim.get(member.dimIndex);
    if (dimension?.isTerritorial === true)
      return err(
        invalidPreference(
          'Preferred classification members cannot select geography; use a territory selector or explicit source observations'
        )
      );
    if (dimension?.role !== 'classification') continue;
    const prior = preferred.get(member.dimIndex);
    if (prior !== undefined && prior !== member.nomItemId)
      return err(invalidPreference('Choose one preferred member per classification dimension'));
    preferred.set(member.dimIndex, member.nomItemId);
  }
  const selected = buildInsSelection(dataset, dimensions, defaults, members, {
    pinsByDimension: preferred,
  });
  if (selected.isErr()) return err(selected.error);
  if (selected.value === null || (!selected.value.hasGeography && node.level !== 'NATIONAL'))
    return ok(null);
  return ok({
    request: {
      key: JSON.stringify([dataset.code, node.territoryId]),
      datasetCode: dataset.code,
      nonGeographicPins: selected.value.nonGeographicPins,
      unitNomItemId: selected.value.unitNomItemId,
      geoScope: selected.value.hasGeography
        ? { kind: 'modern', territoryIds: [node.territoryId] }
        : { kind: 'nonGeographic' },
    },
    strategy: preferred.size === 0 ? 'TOTAL_FALLBACK' : 'PREFERRED_CLASSIFICATION',
  });
};
