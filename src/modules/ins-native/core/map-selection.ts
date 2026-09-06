/** Resolve map selections through source identities and certified defaults. */
import { err, ok, type Result } from 'neverthrow';

import { buildInsSelection } from './default-series.js';
import { parseMemberCode } from './identity.js';
import { sourcePinsToSlots } from './source-pins.js';

import type { InsLatestMapRequest } from './map-series.js';
import type { InsRepo } from './ports.js';
import type { InsDatasetView, InsPeriodicity, InsSourcePin, InsUnitView } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface InsMapSelectionInput {
  readonly datasetCode: string;
  readonly granularity: 'UAT' | 'County';
  /** Complete presentation keys; unresolved nodes must remain gaps in the caller. */
  readonly territoryCodes: readonly string[];
  readonly sourcePins?: readonly InsSourcePin[];
  readonly unitCode?: string;
  readonly periodicity?: InsPeriodicity;
}

export interface InsMapSelection {
  readonly dataset: InsDatasetView;
  readonly unit: InsUnitView;
  readonly request: InsLatestMapRequest;
  readonly unresolvedTerritoryCodes: readonly string[];
}

const invalid = (field: string, message: string): ApiError => ({
  type: 'InvalidInput',
  field,
  message,
});
const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS map selection publication is inconsistent',
});

/** Call with the operation read-session repo; subsequent fact reads use it too. */
export const prepareInsMapSelection = (
  outer: InsRepo,
  input: InsMapSelectionInput
): Promise<Result<InsMapSelection, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    const codes = new Set(input.territoryCodes);
    const codePattern = input.granularity === 'County' ? /^[A-Z]{1,2}$/u : /^\d+$/u;
    if (
      codes.size !== input.territoryCodes.length ||
      [...codes].some((code) => !codePattern.test(code))
    )
      return err(invalid('territories', 'Map territory codes must be canonical and unique'));
    const dataset = await repo.getDataset(input.datasetCode);
    if (dataset.isErr()) return err(dataset.error);
    if (dataset.value === null || dataset.value.publicationStatus === 'NOT_LOADED')
      return err(invalid('datasetCode', 'Choose a published INS map dataset'));
    if (dataset.value.publicationStatus !== 'READY' || dataset.value.dataStatus !== 'AVAILABLE')
      return err(unavailable());
    const periodicity =
      input.periodicity ??
      (dataset.value.periodicities.length === 1 ? dataset.value.periodicities[0] : undefined);
    if (periodicity === undefined || !dataset.value.periodicities.includes(periodicity))
      return err(invalid('periodicity', 'Choose one published INS frequency'));
    const dimensions = await repo.listDimensions(input.datasetCode);
    if (dimensions.isErr()) return err(dimensions.error);
    const sourcePins = input.sourcePins ?? [];
    const byDimension = new Map(
      dimensions.value.map((dimension) => [dimension.dimIndex, dimension])
    );
    if (sourcePins.some((pin) => byDimension.get(pin.dimensionIndex)?.isTerritorial === true))
      return err(
        invalid(
          'sourcePins',
          'Map geography comes from territory boundaries; remove source geographic pins'
        )
      );
    const resolvedPins = await sourcePinsToSlots(
      repo,
      input.datasetCode,
      dimensions.value,
      sourcePins
    );
    if (resolvedPins.isErr()) return err(resolvedPins.error);
    const pinsByDimension = new Map<number, number>();
    for (const pin of sourcePins) {
      const slot = byDimension.get(pin.dimensionIndex)?.slotIndex;
      const id =
        slot === null || slot === undefined ? undefined : resolvedPins.value.get(slot)?.[0];
      if (id === undefined) return err(unavailable());
      pinsByDimension.set(pin.dimensionIndex, id);
    }
    const unitId = input.unitCode === undefined ? undefined : parseMemberCode(input.unitCode);
    if (unitId === null || (unitId !== undefined && String(unitId) !== input.unitCode))
      return err(invalid('unitCode', 'Choose a canonical source unit code'));
    const defaults = await repo.defaultPins([input.datasetCode]);
    if (defaults.isErr()) return err(defaults.error);
    const ids = [
      ...new Set([
        ...pinsByDimension.values(),
        ...defaults.value.map((pin) => pin.nomItemId),
        ...(unitId === undefined ? [] : [unitId]),
      ]),
    ];
    const members = await repo.membersByIds(input.datasetCode, ids);
    if (members.isErr()) return err(members.error);
    const selection = buildInsSelection(
      dataset.value,
      dimensions.value,
      defaults.value,
      members.value,
      {
        pinsByDimension,
        ...(unitId === undefined ? {} : { unitNomItemId: unitId }),
      }
    );
    if (selection.isErr()) return err(selection.error);
    if (selection.value === null)
      return err(
        invalid(
          'sourcePins',
          'Choose one member for every classification without a certified default, and one source unit'
        )
      );
    if (!selection.value.hasGeography)
      return err(invalid('datasetCode', 'This INS dataset has no territorial observations'));
    const units = await repo.listUnits(input.datasetCode);
    if (units.isErr()) return err(units.error);
    const matchingUnits = units.value.filter(
      (unit) => unit.nomItemId === selection.value?.unitNomItemId
    );
    const unit = matchingUnits[0];
    if (matchingUnits.length !== 1 || unit === undefined) return err(unavailable());
    const level = input.granularity === 'County' ? 'NUTS3' : 'LAU';
    const nodes = await repo.territoriesByCodes(input.territoryCodes, [level]);
    if (nodes.isErr()) return err(nodes.error);
    const byCode = new Map(nodes.value.map((node) => [node.code, node]));
    if (
      byCode.size !== nodes.value.length ||
      new Set(nodes.value.map((node) => node.territoryId)).size !== byCode.size ||
      nodes.value.some((node) => node.level !== level || !codes.has(node.code))
    )
      return err(unavailable());
    return ok({
      dataset: dataset.value,
      unit,
      unresolvedTerritoryCodes: input.territoryCodes.filter((code) => !byCode.has(code)),
      request: {
        datasetCode: input.datasetCode,
        nonGeographicPins: selection.value.nonGeographicPins,
        unitNomItemId: selection.value.unitNomItemId,
        periodicity,
        territories: input.territoryCodes.flatMap((code) => {
          const node = byCode.get(code);
          return node === undefined ? [] : [{ code, territoryId: node.territoryId }];
        }),
      },
    });
  });
