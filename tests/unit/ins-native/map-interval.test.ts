import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  readIntervalMapSeries,
  type InsMapInterval,
} from '@/modules/ins-native/core/map-interval.js';
import {
  makeMapSeriesRequests,
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
const selection: InsMapInterval = { operation: 'sum', periodTokens: ['2019', '2020', '2021'] };

const fixture = async () => {
  const repo = makeFakeRepo();
  const seed = (
    await repo.readDefaultSeries(makeMapSeriesRequests(input)._unsafeUnwrap(), 3)
  )._unsafeUnwrap();
  const records = new Map<string, InsObservationView[]>(
    seed.map((row) => [
      row.seriesKey,
      row.observations.map((observation) => ({ ...observation, value: '0.1' })),
    ])
  );
  const calls: number[] = [];
  repo.readDefaultSeries = async (requests, limit, filter) => {
    calls.push(requests.length);
    const rows: InsSeriesResult[] = requests.map((request) => {
      const observations = (records.get(request.key) ?? []).filter(
        (observation) =>
          filter?.periodRanges?.some(
            (range) =>
              observation.period.periodStart <= range.end &&
              observation.period.periodEnd >= range.start
          ) ?? true
      );
      return observations.length === 0
        ? { seriesKey: request.key, status: 'NO_DATA', observations: [], witnesses: [] }
        : {
            seriesKey: request.key,
            status: 'SERIES',
            observations: observations.slice(0, limit),
            witnesses: [],
          };
    });
    return ok(rows);
  };
  const cluj = records.get('54975') ?? [];
  return { repo, records, calls, cluj };
};

const scalar = async (operation: 'sum' | 'average', values: readonly string[]) => {
  const { repo, records, cluj } = await fixture();
  records.set(
    '54975',
    cluj.map((row, i) => ({ ...row, value: values[i] ?? '0' }))
  );
  const result = (
    await readIntervalMapSeries(repo, input, { ...selection, operation })
  )._unsafeUnwrap();
  if (result.operation === 'latest') throw new Error('Wrong test operation');
  return result.cells.get('54975');
};

describe('explicit native INS map intervals', () => {
  it('sums exact decimals, zero and negative values', async () => {
    expect(await scalar('sum', ['0.1', '0.1', '0.1'])).toEqual({ status: 'VALUE', value: '0.3' });
    expect(await scalar('sum', ['0', '-0.1', '0.1'])).toEqual({ status: 'VALUE', value: '0' });
    expect(
      await scalar('sum', ['123456789012.123456', '123456789012.123456', '123456789012.123456'])
    ).toEqual({ status: 'VALUE', value: '370370367036.370368' });
  });
  it('averages over the full selected count with isolated 40-digit rounding', async () => {
    expect(await scalar('average', ['1', '0', '0'])).toEqual({
      status: 'VALUE',
      value: '0.' + '3'.repeat(40),
    });
  });
  it('requires every selected period and retains null coverage separately', async () => {
    const { repo, records, cluj } = await fixture();
    records.set('54975', [{ ...cluj[0]!, value: null, valueStatus: 'c' }, cluj[1]!]);
    const result = (await readIntervalMapSeries(repo, input, selection))._unsafeUnwrap();
    expect(result.cells.get('54975')).toEqual({
      status: 'INCOMPLETE',
      missingPeriodCount: 1,
      nullPeriodCount: 1,
    });
  });
  it('supports noncontiguous periods without adding the intervening observation', async () => {
    const { repo } = await fixture();
    const result = (
      await readIntervalMapSeries(repo, input, { operation: 'sum', periodTokens: ['2019', '2021'] })
    )._unsafeUnwrap();
    expect(result.cells.get('54975')).toEqual({ status: 'VALUE', value: '0.2' });
  });
  it('uses one latest period inside the selected interval, with nulls and gaps', async () => {
    const { repo, records, cluj } = await fixture();
    records.set('54975', [{ ...cluj[0]!, value: null, valueStatus: ':' }, ...cluj.slice(1)]);
    records.set('1017', (records.get('1017') ?? []).slice(1));
    const result = (
      await readIntervalMapSeries(repo, input, { ...selection, operation: 'latest' })
    )._unsafeUnwrap();
    expect(result.operation).toBe('latest');
    if (result.operation !== 'latest') return;
    expect(result.referencePeriod?.periodStart).toBe('2021-01-01');
    expect(result.cells.get('1017')).toEqual({ status: 'MISSING_REFERENCE_PERIOD' });
    const cell = result.cells.get('54975');
    expect(cell?.status === 'OBSERVATION' ? cell.observation.value : 'wrong').toBeNull();
  });
  it('refuses duplicate source time identities rather than aggregating them', async () => {
    const { repo, records, cluj } = await fixture();
    records.set('54975', [
      ...cluj,
      { ...cluj[0]!, coordinate: { ...cluj[0]!.coordinate, timeNomItemId: 9999 } },
    ]);
    expect((await readIntervalMapSeries(repo, input, selection)).isErr()).toBe(true);
  });
  it('refuses overlap-only source periods and inconsistent period IDs', async () => {
    for (const change of [{ periodStart: '2018-01-01' }, { periodId: 9999 }]) {
      const { repo, records, cluj } = await fixture();
      records.set('54975', [
        { ...cluj[0]!, period: { ...cluj[0]!.period, ...change } },
        ...cluj.slice(1),
      ]);
      expect((await readIntervalMapSeries(repo, input, selection)).isErr()).toBe(true);
    }
  });
  it('refuses mixed currency regimes, invalid source values and wrong units', async () => {
    for (const change of [
      { currencyCode: 'ROL' },
      { value: 'NaN' },
      { value: '1e500' },
      { value: '0.1234567' },
      { unit: { nomItemId: 9999 } },
    ]) {
      const { repo, records, cluj } = await fixture();
      records.set('54975', [
        {
          ...cluj[0]!,
          ...change,
          unit: { ...cluj[0]!.unit, ...('unit' in change ? change.unit : {}) },
        },
        ...cluj.slice(1),
      ]);
      expect((await readIntervalMapSeries(repo, input, selection)).isErr()).toBe(true);
    }
  });
  it('refuses unknown monetary currency for reductions while preserving raw latest', async () => {
    const { repo, records, cluj } = await fixture();
    records.set(
      '54975',
      cluj.map((row) => ({
        ...row,
        unit: { ...row.unit, unitKind: 'monetary' },
        currencyCode: null,
      }))
    );
    expect((await readIntervalMapSeries(repo, input, selection)).isErr()).toBe(true);
    expect(
      (await readIntervalMapSeries(repo, input, { ...selection, operation: 'average' })).isErr()
    ).toBe(true);
    expect(
      (await readIntervalMapSeries(repo, input, { ...selection, operation: 'latest' })).isOk()
    ).toBe(true);
  });

  it('rejects empty, repeated, noncanonical, mixed-frequency and oversized selections before reads', async () => {
    for (const periodTokens of [
      [],
      ['2020', '2020'],
      ['2020 '],
      ['0000'],
      ['2020', '2020-01'],
      Array.from({ length: 1001 }, (_, i) => String(1900 + i)),
    ]) {
      const { repo, calls } = await fixture();
      expect(
        (await readIntervalMapSeries(repo, input, { ...selection, periodTokens })).isErr()
      ).toBe(true);
      expect(calls).toEqual([]);
    }
  });
  it('requires the operation even for an existing saved interval', async () => {
    const { repo, calls } = await fixture();
    expect(
      (
        await readIntervalMapSeries(repo, input, {
          periodTokens: ['2020'],
        } as unknown as InsMapInterval)
      ).isErr()
    ).toBe(true);
    expect(calls).toEqual([]);
  });
  it('fails the entire interval on the overflow witness', async () => {
    const { repo, cluj } = await fixture();
    repo.readDefaultSeries = async (requests) =>
      ok(
        requests.map((request) => ({
          seriesKey: request.key,
          status: 'SERIES' as const,
          witnesses: [],
          observations: Array.from({ length: 1001 }, () => cluj[0]!),
        }))
      );
    expect((await readIntervalMapSeries(repo, input, selection)).isErr()).toBe(true);
  });
  it('shares setup for short intervals without exceeding the row budget', async () => {
    const { repo, calls } = await fixture();
    const result = await readIntervalMapSeries(
      repo,
      {
        ...input,
        territories: Array.from({ length: 200 }, (_, i) => ({
          code: String(i),
          territoryId: i + 1,
        })),
      },
      selection
    );
    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([200]);
  });

  it('bounds territory history reads and rejects failure after an earlier chunk succeeds', async () => {
    const { repo } = await fixture();
    const calls: number[] = [];
    let snapshots = 0;
    repo.withSnapshot = (fn) => {
      snapshots++;
      return fn(repo);
    };
    repo.readDefaultSeries = async (requests) => {
      calls.push(requests.length);
      return calls.length === 2
        ? err({ type: 'Timeout', message: 'Deadline exceeded' })
        : ok(
            requests.map((request) => ({
              seriesKey: request.key,
              status: 'NO_DATA' as const,
              observations: [],
              witnesses: [],
            }))
          );
    };
    const result = await readIntervalMapSeries(
      repo,
      {
        ...input,
        territories: Array.from({ length: 41 }, (_, i) => ({
          code: String(i),
          territoryId: i + 1,
        })),
      },
      { operation: 'sum', periodTokens: Array.from({ length: 1000 }, (_, i) => String(1900 + i)) }
    );
    expect(result.isErr() && result.error.type).toBe('Timeout');
    expect(calls).toEqual([40, 1]);
    expect(snapshots).toBe(1);
  });
});
