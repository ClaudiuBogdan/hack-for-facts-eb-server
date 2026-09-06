/** Exact-year domicile population from an explicitly admitted INS publication. */
import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { buildInsSelection } from './default-series.js';

import type { InsRepo } from './ports.js';
import type { InsDefaultSeriesRequest } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface AnnualPopulationAdmission {
  readonly datasetCode: string;
  readonly revisionId: string;
  readonly custodySha256: string;
  readonly transformContractSha256: string;
  readonly ageDimension: number;
  readonly allAgesMember: number;
  readonly sexDimension: number;
  readonly allSexesMember: number;
  readonly personsUnit: number;
}
export interface AnnualPopulationInput {
  /** Already verified source-node identities after canonical ancestor pruning. */
  readonly territories: readonly { readonly key: string; readonly territoryId: number }[];
  readonly years: readonly number[];
}
export interface AnnualPopulationCell {
  readonly key: string;
  readonly year: number;
  readonly population: string | null;
}
export interface AnnualPopulationResult {
  readonly cells: readonly AnnualPopulationCell[];
  readonly provenance: {
    readonly basis: 'domicile_january_1';
    readonly datasetCode: string;
    readonly revisionId: string;
    readonly custodySha256: string;
    readonly transformContractSha256: string;
    readonly sourceUrl: string;
  };
}
const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'Annual population publication is not admitted or is inconsistent',
});
const invalid = (): ApiError => ({
  type: 'InvalidInput',
  field: 'population',
  message: 'Annual population requires unique territories and 1 to 1000 exact years',
});

/** The caller must retain this snapshot through selection, ancestry resolution and reads. */
export const readAnnualPopulation = (
  outer: InsRepo,
  admission: AnnualPopulationAdmission,
  input: AnnualPopulationInput
): Promise<Result<AnnualPopulationResult, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    const years = new Set(input.years);
    const keys = new Set(input.territories.map((territory) => territory.key));
    if (
      years.size === 0 ||
      years.size > 1000 ||
      years.size !== input.years.length ||
      input.years.some((year) => !Number.isInteger(year) || year < 1 || year > 9999) ||
      keys.size !== input.territories.length ||
      keys.has('') ||
      input.territories.some(
        (territory) => !Number.isSafeInteger(territory.territoryId) || territory.territoryId <= 0
      ) ||
      new Set(input.territories.map((territory) => territory.territoryId)).size !== keys.size
    )
      return err(invalid());
    const datasetResult = await repo.getDataset(admission.datasetCode);
    if (datasetResult.isErr()) return err(datasetResult.error);
    const dataset = datasetResult.value;
    if (
      dataset?.publicationStatus !== 'READY' ||
      dataset.dataStatus !== 'AVAILABLE' ||
      dataset.revisionId !== admission.revisionId ||
      dataset.custodySha256 !== admission.custodySha256 ||
      dataset.transformContractSha256 !== admission.transformContractSha256 ||
      dataset.periodicities.length !== 1 ||
      dataset.periodicities[0] !== 'ANNUAL'
    )
      return err(unavailable());
    const dimensions = await repo.listDimensions(admission.datasetCode);
    if (dimensions.isErr()) return err(dimensions.error);
    const members = await repo.membersByIds(admission.datasetCode, [
      ...new Set([admission.allAgesMember, admission.allSexesMember, admission.personsUnit]),
    ]);
    if (members.isErr()) return err(members.error);
    for (const [dimension, memberId] of [
      [admission.ageDimension, admission.allAgesMember],
      [admission.sexDimension, admission.allSexesMember],
    ] as const) {
      const matched = members.value.filter(
        (member) => member.dimIndex === dimension && member.nomItemId === memberId
      );
      if (matched.length !== 1 || matched[0]?.memberRole !== 'TOTAL') return err(unavailable());
    }
    const selected = buildInsSelection(dataset, dimensions.value, [], members.value, {
      pinsByDimension: new Map([
        [admission.ageDimension, admission.allAgesMember],
        [admission.sexDimension, admission.allSexesMember],
      ]),
      unitNomItemId: admission.personsUnit,
    });
    if (selected.isErr()) return err(selected.error);
    if (
      selected.value?.nonGeographicPins.size !== 2 ||
      admission.ageDimension === admission.sexDimension
    )
      return err(unavailable());
    const units = await repo.listUnits(admission.datasetCode);
    if (units.isErr()) return err(units.error);
    const unit = units.value.find((item) => item.nomItemId === admission.personsUnit);
    if (
      unit === undefined ||
      units.value.filter((item) => item.nomItemId === admission.personsUnit).length !== 1 ||
      unit.baseUnit !== 'persons' ||
      unit.scaleFactor !== '1' ||
      unit.unitKind !== 'non-monetary' ||
      unit.currencyRegime !== null
    )
      return err(unavailable());
    const nonGeographicPins = selected.value.nonGeographicPins;
    const cells: AnnualPopulationCell[] = [];
    const periodIds = new Map<number, number>();
    const yearsByPeriodId = new Map<number, number>();
    const periodRanges = input.years.map((year) => ({
      start: `${String(year).padStart(4, '0')}-01-01`,
      end: `${String(year).padStart(4, '0')}-12-31`,
    }));
    // Match the admitted map-reader hydration policy; retain one overflow witness per series.
    const batchSize = Math.floor(40040 / (years.size + 1));
    for (let offset = 0; offset < input.territories.length; offset += batchSize) {
      const territories = input.territories.slice(offset, offset + batchSize);
      const requests: InsDefaultSeriesRequest[] = territories.map((territory) => ({
        key: territory.key,
        datasetCode: admission.datasetCode,
        nonGeographicPins: nonGeographicPins,
        unitNomItemId: admission.personsUnit,
        geoScope: { kind: 'modern', territoryIds: [territory.territoryId] },
      }));
      const result = await repo.readDefaultSeries(requests, years.size + 1, {
        periodicities: ['ANNUAL'],
        periodRanges,
      });
      if (result.isErr()) return err(result.error);
      const rows = new Map(result.value.map((row) => [row.seriesKey, row]));
      if (rows.size !== territories.length || rows.size !== result.value.length)
        return err(unavailable());
      for (const territory of territories) {
        const row = rows.get(territory.key);
        if (row === undefined) return err(unavailable());
        const values = new Map<number, string | null>();
        if (row.status === 'SERIES') {
          if (row.observations.length === 0 || row.observations.length > years.size)
            return err(unavailable());
          for (const observation of row.observations) {
            const year = Number(observation.period.periodStart.slice(0, 4));
            const date = String(year).padStart(4, '0');
            if (
              !years.has(year) ||
              values.has(year) ||
              (periodIds.has(year) && periodIds.get(year) !== observation.period.periodId) ||
              (yearsByPeriodId.has(observation.period.periodId) &&
                yearsByPeriodId.get(observation.period.periodId) !== year) ||
              observation.period.periodicity !== 'ANNUAL' ||
              observation.period.periodStart !== `${date}-01-01` ||
              observation.period.periodEnd !== `${date}-12-31` ||
              observation.unit.nomItemId !== admission.personsUnit ||
              observation.unit.baseUnit !== 'persons' ||
              observation.unit.scaleFactor !== '1' ||
              observation.currencyCode !== null ||
              (observation.value !== null &&
                (!/^\d+(?:\.0+)?$/u.test(observation.value) ||
                  !new Decimal(observation.value).isInteger()))
            )
              return err(unavailable());
            periodIds.set(year, observation.period.periodId);
            yearsByPeriodId.set(observation.period.periodId, year);
            // Zero is a valid component; only the completed union must be positive.
            values.set(year, observation.value);
          }
        }
        for (const year of input.years)
          cells.push({ key: territory.key, year, population: values.get(year) ?? null });
      }
    }
    return ok({
      cells,
      provenance: {
        basis: 'domicile_january_1',
        datasetCode: dataset.code,
        revisionId: admission.revisionId,
        custodySha256: admission.custodySha256,
        transformContractSha256: admission.transformContractSha256,
        sourceUrl: dataset.sourceUrl,
      },
    });
  });
