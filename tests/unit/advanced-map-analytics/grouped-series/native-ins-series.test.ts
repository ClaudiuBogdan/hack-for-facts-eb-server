import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  nativeInsMapInput,
  extractNativeInsSeries,
} from '@/modules/advanced-map-analytics/grouped-series/shell/providers/native-ins-series.js';

import { makeFakeRepo } from '../../ins-native/fake-repo.js';

import type { InsMapSeries } from '@/modules/advanced-map-analytics/grouped-series/core/types.js';

const series: InsMapSeries = { id: 'ins', type: 'ins-series', datasetCode: 'POPTEST' };
const universe = ['54975', '1017', '179141'];

describe('native INS map request adapter', () => {
  it('defaults to shared latest and lets the publication resolve certified defaults', () => {
    expect(nativeInsMapInput(series, 'UAT', universe)._unsafeUnwrap()).toEqual({
      datasetCode: 'POPTEST',
      granularity: 'UAT',
      territoryCodes: universe,
      sourcePins: [],
    });
  });
  it('keeps exact source pairs and explicit frequency for latest', () => {
    const result = nativeInsMapInput(
      {
        ...series,
        periodicity: 'MONTHLY',
        unitCodes: ['9685'],
        classificationSelections: { D0: ['1'], D1: ['105'] },
      },
      'County',
      ['CJ']
    )._unsafeUnwrap();
    expect(result).toMatchObject({
      periodicity: 'MONTHLY',
      unitCode: '9685',
      sourcePins: [
        { dimensionIndex: 0, memberCode: '1' },
        { dimensionIndex: 1, memberCode: '105' },
      ],
    });
  });
  it.each([
    { classificationSelections: { SEXE: ['M'] } },
    { classificationSelections: { D0: ['1', '2'] } },
    { classificationSelections: { D0: [] } },
    { classificationSelections: { D01: ['1'] } },
    { aggregation: 'first' },
    { hasValue: false },
    { unitCodes: ['1', '2'] },
  ] as Partial<InsMapSeries>[])('rejects unproven legacy interpretation %j', (patch) => {
    expect(nativeInsMapInput({ ...series, ...patch }, 'UAT', universe).isErr()).toBe(true);
  });
  it('accepts the full native member range and rejects noncanonical source IDs', () => {
    for (const member of ['0', '-1', '-2147483648', '2147483647']) {
      expect(
        nativeInsMapInput(
          { ...series, classificationSelections: { D0: [member] } },
          'UAT',
          universe
        )._unsafeUnwrap().sourcePins
      ).toEqual([{ dimensionIndex: 0, memberCode: member }]);
    }
    for (const member of ['-0', '+1', '01', '2147483648', '-2147483649']) {
      expect(
        nativeInsMapInput(
          { ...series, classificationSelections: { D0: [member] } },
          'UAT',
          universe
        ).isErr()
      ).toBe(true);
    }
  });

  it('requires the operation even for an existing saved interval', () => {
    const period = {
      type: Frequency.YEAR,
      selection: { interval: { start: '2020', end: '2021' } },
    } as const;
    expect(
      nativeInsMapInput({ ...series, period, aggregation: 'sum' }, 'UAT', universe).isErr()
    ).toBe(true);
    expect(
      nativeInsMapInput(
        { ...series, period, intervalOperation: 'average' },
        'UAT',
        universe
      )._unsafeUnwrap().interval
    ).toEqual({ operation: 'average', periodTokens: ['2020', '2021'] });
  });
  it('expands bounded partial-year intervals without including outside months', () => {
    const result = nativeInsMapInput(
      {
        ...series,
        intervalOperation: 'sum',
        period: {
          type: Frequency.MONTH,
          selection: { interval: { start: '2020-11', end: '2021-02' } },
        },
      },
      'UAT',
      universe
    )._unsafeUnwrap();
    expect(result.interval?.periodTokens).toEqual(['2020-11', '2020-12', '2021-01', '2021-02']);
    expect(result.periodicity).toBe('MONTHLY');
  });
  it('preserves gaps between selected dates and rejects duplicates or frequency mismatch', () => {
    const request: InsMapSeries = {
      ...series,
      intervalOperation: 'latest',
      period: { type: Frequency.YEAR, selection: { dates: ['2020', '2022'] } },
    };
    expect(
      nativeInsMapInput(request, 'UAT', universe)._unsafeUnwrap().interval?.periodTokens
    ).toEqual(['2020', '2022']);
    expect(nativeInsMapInput({ ...request, periodicity: 'MONTHLY' }, 'UAT', universe).isErr()).toBe(
      true
    );
    expect(
      nativeInsMapInput(
        { ...request, period: { type: Frequency.YEAR, selection: { dates: ['2020', '2020'] } } },
        'UAT',
        universe
      ).isErr()
    ).toBe(true);
  });
  it('rejects reversed and oversized intervals before reading data', () => {
    for (const interval of [
      { start: '2021', end: '2020' },
      { start: '0001', end: '9999' },
      { start: '0000', end: '0001' },
    ]) {
      expect(
        nativeInsMapInput(
          {
            ...series,
            intervalOperation: 'sum',
            period: {
              type: Frequency.YEAR,
              selection: { interval: interval as { start: '2020'; end: '2021' } },
            },
          },
          'UAT',
          universe
        ).isErr()
      ).toBe(true);
    }
  });
});

describe('native INS map read lifecycle', () => {
  it('reads native data, preserves string values and leaves sectors unavailable', async () => {
    const repo = makeFakeRepo();
    let closed = 0;
    const result = (
      await extractNativeInsSeries(
        () => ({
          getRepo: async () => ok(repo),
          close: async () => {
            closed++;
            return ok(undefined);
          },
        }),
        { ...series, unit: 'misleading custom unit' },
        'UAT',
        universe
      )
    )._unsafeUnwrap();
    expect(closed).toBe(1);
    expect(result.vector.unit).not.toBe('misleading custom unit');
    expect(typeof result.vector.valuesBySirutaCode.get('54975')).toBe('string');
    expect(result.vector.valuesBySirutaCode.get('179141')).toBeUndefined();
    expect(result.warnings[0]?.details).toMatchObject({
      operation: 'latest',
      statuses: { UNRESOLVED_TERRITORY: 1 },
    });
  });
  it('uses an excluded territory latest null head as the shared reference period', async () => {
    const repo = makeFakeRepo();
    const read = repo.readDefaultSeries.bind(repo);
    repo.readDefaultSeries = async (requests, limit, filter) =>
      (await read(requests, limit, filter)).map((rows) =>
        rows.map((row) =>
          row.status !== 'SERIES'
            ? row
            : {
                ...row,
                observations: row.observations.map((observation, index) =>
                  row.seriesKey === '1017' && index === 0
                    ? {
                        ...observation,
                        value: null,
                        period: {
                          ...observation.period,
                          periodId: 999,
                          year: 2026,
                          periodStart: '2026-01-01',
                          periodEnd: '2026-12-31',
                        },
                      }
                    : observation
                ),
              }
        )
      );
    const result = (
      await extractNativeInsSeries(
        () => ({ getRepo: async () => ok(repo), close: async () => ok(undefined) }),
        { ...series, sirutaCodes: ['54975'] },
        'UAT',
        universe
      )
    )._unsafeUnwrap();
    expect(result.vector.valuesBySirutaCode.get('54975')).toBeUndefined();
    expect(result.vector.valuesBySirutaCode.has('1017')).toBe(false);
    expect(result.warnings[0]?.details).toMatchObject({
      referencePeriod: { year: 2026 },
      statuses: { MISSING_REFERENCE_PERIOD: 1 },
    });
  });

  it('fails on session close failure instead of returning read values', async () => {
    const result = await extractNativeInsSeries(
      () => ({
        getRepo: async () => ok(makeFakeRepo()),
        close: async () => err({ type: 'ServiceUnavailable', message: 'failed' }),
      }),
      series,
      'UAT',
      universe
    );
    expect(result._unsafeUnwrapErr().type).toBe('ProviderError');
  });
  it('closes the session when acquisition or reading fails', async () => {
    let closed = 0;
    const result = await extractNativeInsSeries(
      () => ({
        getRepo: async () => err({ type: 'Timeout', message: 'deadline' }),
        close: async () => {
          closed++;
          return ok(undefined);
        },
      }),
      series,
      'UAT',
      universe
    );
    expect(result._unsafeUnwrapErr().type).toBe('ProviderError');
    expect(closed).toBe(1);
  });
  it('rejects city and wrong-granularity filters before opening the session', async () => {
    let opened = 0;
    const result = await extractNativeInsSeries(
      () => {
        opened++;
        return { getRepo: async () => ok(makeFakeRepo()), close: async () => ok(undefined) };
      },
      { ...series, territoryCodes: ['179132'] },
      'UAT',
      universe
    );
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInputError');
    expect(opened).toBe(0);
  });
});
