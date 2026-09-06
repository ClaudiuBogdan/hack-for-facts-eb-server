import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  readAnnualPopulation,
  type AnnualPopulationAdmission,
} from '@/modules/ins-native/core/annual-population.js';

import { makeFakeRepo } from './fake-repo.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { InsSeriesResult } from '@/modules/ins-native/core/types.js';

const admission: AnnualPopulationAdmission = {
  datasetCode: 'POPTEST',
  revisionId: '1',
  custodySha256: 'a'.repeat(64),
  transformContractSha256: 'b'.repeat(64),
  ageDimension: 0,
  allAgesMember: 1,
  sexDimension: 1,
  allSexesMember: 105,
  personsUnit: 9685,
};
const input = { territories: [{ key: 'CJ', territoryId: 25 }], years: [2019, 2021] };
const changedRows = (
  transform: (rows: readonly InsSeriesResult[]) => readonly InsSeriesResult[]
): InsRepo => {
  const fake = makeFakeRepo();
  const repo: InsRepo = {
    ...fake,
    withSnapshot: (fn) => fn(repo),
    readDefaultSeries: async (...args) => {
      const result = await fake.readDefaultSeries(...args);
      return result.map((rows) =>
        transform(
          rows.map((row) =>
            row.status !== 'SERIES'
              ? row
              : {
                  ...row,
                  observations: row.observations.map((observation) => {
                    expect(observation.value).toMatch(/^CJ-1-105-/u);
                    return {
                      ...observation,
                      value: observation.period.periodStart.startsWith('2019')
                        ? '9007199254740993'
                        : '710001',
                    };
                  }),
                }
          )
        )
      );
    },
  };
  return repo;
};

describe('admitted exact-year population', () => {
  it('reads all ages and sexes for exact years with publication provenance', async () => {
    const fake = changedRows((rows) => rows);
    const result = (await readAnnualPopulation(fake, admission, input))._unsafeUnwrap();
    expect(result.cells).toHaveLength(2);
    expect(result.cells.map((cell) => cell.year)).toEqual([2019, 2021]);
    expect(result.cells.every((cell) => cell.population !== null)).toBe(true);
    expect(result.provenance).toMatchObject({
      basis: 'domicile_january_1',
      datasetCode: 'POPTEST',
      revisionId: '1',
    });
    expect(result.cells.map((cell) => cell.population)).toEqual(['9007199254740993', '710001']);
  });
  it('marks a missing year unavailable without borrowing another year', async () => {
    const result = await readAnnualPopulation(
      changedRows((rows) => rows),
      admission,
      {
        ...input,
        years: [2018, 2021],
      }
    );
    expect(result._unsafeUnwrap().cells).toEqual([
      { key: 'CJ', year: 2018, population: null },
      expect.objectContaining({ key: 'CJ', year: 2021, population: expect.any(String) }),
    ]);
  });
  it.each(['0', '0.000', null])(
    'preserves a zero or missing component %s for union validation',
    async (value) => {
      const repo = changedRows((rows) =>
        rows.map((row) =>
          row.status !== 'SERIES'
            ? row
            : {
                ...row,
                observations: row.observations.map((observation) => ({ ...observation, value })),
              }
        )
      );
      expect(
        (await readAnnualPopulation(repo, admission, input))
          ._unsafeUnwrap()
          .cells.every((cell) => cell.population === value)
      ).toBe(true);
    }
  );
  it.each(['-1', '1.5', 'NaN', 'Infinity', '1e3'])(
    'rejects invalid population %s',
    async (value) => {
      const repo = changedRows((rows) =>
        rows.map((row) =>
          row.status !== 'SERIES'
            ? row
            : {
                ...row,
                observations: row.observations.map((observation) => ({ ...observation, value })),
              }
        )
      );
      expect((await readAnnualPopulation(repo, admission, input)).isErr()).toBe(true);
    }
  );
  it.each(['revisionId', 'custodySha256', 'transformContractSha256'] as const)(
    'rejects changed publication %s',
    async (field) => {
      expect(
        (
          await readAnnualPopulation(makeFakeRepo(), { ...admission, [field]: 'changed' }, input)
        ).isErr()
      ).toBe(true);
    }
  );
  it('rejects wrong age/sex/unit selection', async () => {
    for (const patch of [{ allAgesMember: 2 }, { allSexesMember: 106 }, { personsUnit: 9507 }]) {
      // Total population must be admitted by semantics, not merely by a member existing.
      expect(
        (await readAnnualPopulation(makeFakeRepo(), { ...admission, ...patch }, input)).isErr()
      ).toBe(true);
    }
  });
  it('rejects duplicate, missing and extra series', async () => {
    for (const transform of [
      (rows: readonly InsSeriesResult[]) => [...rows, ...rows],
      () => [],
      (rows: readonly InsSeriesResult[]) => rows.map((row) => ({ ...row, seriesKey: 'OTHER' })),
    ]) {
      expect((await readAnnualPopulation(changedRows(transform), admission, input)).isErr()).toBe(
        true
      );
    }
  });
  it('rejects duplicate years and nonannual boundaries', async () => {
    for (const transform of [
      (rows: readonly InsSeriesResult[]) =>
        rows.map((row) =>
          row.status !== 'SERIES'
            ? row
            : { ...row, observations: [row.observations[0]!, row.observations[0]!] }
        ),
      (rows: readonly InsSeriesResult[]) =>
        rows.map((row) =>
          row.status !== 'SERIES'
            ? row
            : {
                ...row,
                observations: row.observations.map((observation) => ({
                  ...observation,
                  period: { ...observation.period, periodEnd: '2021-06-30' },
                })),
              }
        ),
    ])
      expect((await readAnnualPopulation(changedRows(transform), admission, input)).isErr()).toBe(
        true
      );
  });
  it('propagates read failure instead of returning an empty successful result', async () => {
    const fake = makeFakeRepo();
    const repo: InsRepo = {
      ...fake,
      withSnapshot: (fn) => fn(repo),
      readDefaultSeries: () =>
        Promise.resolve(err({ type: 'ServiceUnavailable', message: 'offline' })),
    };
    expect((await readAnnualPopulation(repo, admission, input)).isErr()).toBe(true);
  });
  it('rejects unsupported or duplicate identities and years before reads', async () => {
    for (const patch of [
      { years: [] },
      { years: [2020, 2020] },
      { years: [0] },
      { territories: [{ key: 'CJ', territoryId: 0 }] },
      { territories: [...input.territories, ...input.territories] },
    ]) {
      expect(
        (
          await readAnnualPopulation(
            changedRows((rows) => rows),
            admission,
            { ...input, ...patch }
          )
        ).isErr()
      ).toBe(true);
    }
  });
});
