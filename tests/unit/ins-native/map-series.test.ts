import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  readLatestMapSeries,
  type InsLatestMapRequest,
} from '@/modules/ins-native/core/map-series.js';

import { makeFakeRepo } from './fake-repo.js';

import type { InsObservationView, InsSeriesResult } from '@/modules/ins-native/core/types.js';

const input: InsLatestMapRequest = {
  datasetCode: 'POPTEST',
  nonGeographicPins: new Map([
    [1, 1],
    [2, 105],
  ]),
  unitNomItemId: 9685,
  periodicity: 'ANNUAL',
  territories: [
    { code: '54975', territoryId: 931 },
    { code: '1017', territoryId: 56 },
  ],
};

const fixture = async () => {
  const repo = makeFakeRepo();
  const rows = (
    await repo.readDefaultSeries(
      input.territories.map((t) => ({
        key: t.code,
        datasetCode: input.datasetCode,
        nonGeographicPins: input.nonGeographicPins,
        unitNomItemId: input.unitNomItemId,
        geoScope: { kind: 'modern' as const, territoryIds: [t.territoryId] as const },
      })),
      2
    )
  )._unsafeUnwrap();
  const first = rows[0]?.observations[0];
  const second = rows[1]?.observations[0];
  if (first === undefined || second === undefined) throw new Error('Missing test seed');
  const series = (key: string, observations: readonly InsObservationView[]): InsSeriesResult => ({
    seriesKey: key,
    status: 'SERIES',
    observations,
    witnesses: [],
  });
  repo.readDefaultSeries = async () => ok([series('54975', [first]), series('1017', [second])]);
  return { repo, first, second, series };
};

const earlier = (observation: InsObservationView): InsObservationView => ({
  ...observation,
  period: {
    ...observation.period,
    periodId: 29,
    periodStart: '2020-01-01',
    periodEnd: '2020-12-31',
  },
});

describe('INS maps with one latest reference period', () => {
  it('leaves an older territory unavailable instead of falling back', async () => {
    const { repo, first, second, series } = await fixture();
    repo.readDefaultSeries = async (_requests, limit, period) => {
      expect(limit).toBe(2);
      expect(period).toEqual({ periodicities: ['ANNUAL'] });
      return ok([series('54975', [first]), series('1017', [earlier(second)])]);
    };
    const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
    expect(result.referencePeriod?.periodStart).toBe('2021-01-01');
    expect(result.cells.get('1017')).toEqual({ status: 'MISSING_REFERENCE_PERIOD' });
    expect(result.cells.get('54975')).toEqual({ status: 'OBSERVATION', observation: first });
  });

  it('keeps the latest null cell and its confidentiality status, even with an older numeric cell', async () => {
    const { repo, first, second, series } = await fixture();
    const confidential = { ...first, value: null, valueStatus: 'c' };
    repo.readDefaultSeries = async () =>
      ok([
        series('54975', [confidential, { ...earlier(first), value: '100' }]),
        series('1017', [earlier(second)]),
      ]);
    const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
    expect(result.referencePeriod?.periodStart).toBe('2021-01-01');
    expect(result.cells.get('54975')).toEqual({ status: 'OBSERVATION', observation: confidential });
    expect(result.cells.get('1017')).toEqual({ status: 'MISSING_REFERENCE_PERIOD' });
  });

  it('retains the reference when every current value is null', async () => {
    const { repo, first, second, series } = await fixture();
    repo.readDefaultSeries = async () =>
      ok([
        series('54975', [{ ...first, value: null, valueStatus: ':' }]),
        series('1017', [{ ...second, value: null, valueStatus: ':' }]),
      ]);
    const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
    expect(result.referencePeriod).toEqual(first.period);
    expect(
      [...result.cells.values()].every(
        (cell) => cell.status === 'OBSERVATION' && cell.observation.value === null
      )
    ).toBe(true);
  });

  it('retains exact zero, negative and beyond-safe-integer values as strings', async () => {
    const { repo, first, second, series } = await fixture();
    for (const value of ['0', '-0.01', '9007199254740993.123456789']) {
      repo.readDefaultSeries = async () =>
        ok([series('54975', [{ ...first, value }]), series('1017', [second])]);
      const cell = (await readLatestMapSeries(repo, input))._unsafeUnwrap().cells.get('54975');
      expect(cell?.status === 'OBSERVATION' ? cell.observation.value : null).toBe(value);
    }
  });

  it('preserves ambiguity witnesses and reports no reference if no unique series exists', async () => {
    const { repo } = await fixture();
    const ambiguous: InsSeriesResult = {
      seriesKey: '54975',
      status: 'AMBIGUOUS_GEOGRAPHY',
      observations: [],
      witnesses: [
        [
          [2, 3075],
          [3, 931],
        ],
        [
          [2, 3065],
          [3, 113],
        ],
      ],
    };
    repo.readDefaultSeries = async () =>
      ok([ambiguous, { seriesKey: '1017', status: 'NO_DATA', observations: [], witnesses: [] }]);
    const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
    expect(result.referencePeriod).toBeNull();
    expect(result.cells.get('54975')).toEqual({
      status: 'AMBIGUOUS_GEOGRAPHY',
      witnesses: ambiguous.witnesses,
    });
  });

  it('rejects competing source time identities for the same latest period, even for equal values', async () => {
    const { repo, first, second, series } = await fixture();
    repo.readDefaultSeries = async () =>
      ok([
        series('54975', [
          first,
          { ...first, coordinate: { ...first.coordinate, timeNomItemId: 9999 } },
        ]),
        series('1017', [second]),
      ]);
    expect((await readLatestMapSeries(repo, input)).isErr()).toBe(true);
  });

  it('does not merge equal end dates with different start dates', async () => {
    const { repo, first, second, series } = await fixture();
    repo.readDefaultSeries = async () =>
      ok([
        series('54975', [first]),
        series('1017', [
          { ...second, period: { ...second.period, periodId: 999, periodStart: '2020-01-01' } },
        ]),
      ]);
    expect((await readLatestMapSeries(repo, input))._unsafeUnwrap().cells.get('1017')).toEqual({
      status: 'MISSING_REFERENCE_PERIOD',
    });
  });

  it('rejects inconsistent period IDs, unexpected frequency and unordered heads', async () => {
    const { repo, first, second, series } = await fixture();
    for (const invalid of [
      [{ ...first, period: { ...first.period, periodId: 999 } }],
      [{ ...first, period: { ...first.period, periodicity: 'MONTHLY' as const } }],
      [earlier(first), first],
    ]) {
      repo.readDefaultSeries = async () => ok([series('54975', invalid), series('1017', [second])]);
      expect((await readLatestMapSeries(repo, input)).isErr()).toBe(true);
    }
  });

  it('rejects a period ID reused with conflicting dates', async () => {
    const { repo, first, second, series } = await fixture();
    repo.readDefaultSeries = async () =>
      ok([
        series('54975', [first]),
        series('1017', [{ ...second, period: { ...second.period, periodStart: '2020-01-01' } }]),
      ]);
    expect((await readLatestMapSeries(repo, input)).isErr()).toBe(true);
  });

  it('rejects missing, unexpected, duplicate and empty series outcomes', async () => {
    const { repo, first, second, series } = await fixture();
    for (const rows of [
      [series('54975', [first])],
      [series('54975', [first]), series('unexpected', [second])],
      [series('54975', [first]), series('54975', [second])],
      [series('54975', []), series('1017', [second])],
    ]) {
      repo.readDefaultSeries = async () => ok(rows);
      expect((await readLatestMapSeries(repo, input)).isErr()).toBe(true);
    }
  });

  it('propagates deadline/publication failures without successful partial results', async () => {
    const { repo } = await fixture();
    repo.readDefaultSeries = async () => err({ type: 'Timeout', message: 'Deadline exceeded' });
    const result = await readLatestMapSeries(repo, input);
    expect(result.isErr() && result.error.type).toBe('Timeout');
  });

  it('uses exactly one snapshot and returns an empty map for an empty universe', async () => {
    const repo = makeFakeRepo();
    let snapshots = 0;
    repo.withSnapshot = (fn) => {
      snapshots++;
      return fn(repo);
    };
    expect(
      (await readLatestMapSeries(repo, { ...input, territories: [] }))._unsafeUnwrap()
    ).toEqual({ referencePeriod: null, cells: new Map() });
    expect(snapshots).toBe(1);
  });

  it('rejects duplicate public codes or native territory identities', async () => {
    const repo = makeFakeRepo();
    for (const territories of [
      [
        { code: '54975', territoryId: 931 },
        { code: '54975', territoryId: 56 },
      ],
      [
        { code: '54975', territoryId: 931 },
        { code: '1017', territoryId: 931 },
      ],
    ])
      expect((await readLatestMapSeries(repo, { ...input, territories })).isErr()).toBe(true);
    expect(repo.seriesReads).toHaveLength(0);
  });
});
