/**
 * The whole-request memo in front of the native grouped-series provider
 * (review N/M2): hits skip the inner provider, the key ignores who asks,
 * uploaded-dataset requests bypass the memo, errors are never replayed, and
 * identical concurrent requests share one computation.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createKeyBuilder } from '@/infra/cache/index.js';
import { createProviderError } from '@/modules/advanced-map-analytics/grouped-series/core/errors.js';
import {
  getGroupedSeriesData,
  isCacheableGroupedSeriesRequest,
  makeCachedGroupedSeriesProvider,
  type GroupedSeriesDataRequest,
  type GroupedSeriesProvider,
  type GroupedSeriesProviderOutput,
} from '@/modules/advanced-map-analytics/index.js';
import { createCache } from '@/modules/shared/index.js';

/** A real, validator-accepted request (same shape as the use-case tests). */
const request = (over: Partial<GroupedSeriesDataRequest> = {}): GroupedSeriesDataRequest => ({
  granularity: 'UAT',
  series: [
    {
      id: 's1',
      type: 'line-items-aggregated-yearly',
      filter: {
        account_category: 'ch',
        report_type: 'Executie bugetara agregata la nivel de ordonator principal',
        report_period: {
          type: Frequency.YEAR,
          selection: { interval: { start: '2025', end: '2025' } },
        },
      },
    },
  ],
  ...over,
});

/** Real Map-valued vectors: the cache must hand them back intact. */
const output = (tag: string): GroupedSeriesProviderOutput => ({
  sirutaUniverse: ['1001', '2002'],
  vectors: [
    {
      seriesId: 's1',
      unit: tag,
      valuesBySirutaCode: new Map([
        ['1001', '10.50'],
        ['2002', '20.25'],
      ]),
    },
  ],
  warnings: [],
});

const innerCounting = (
  answer: (n: number) => ReturnType<GroupedSeriesProvider['fetchGroupedSeriesVectors']>
) => {
  let calls = 0;
  const inner: GroupedSeriesProvider = {
    fetchGroupedSeriesVectors: () => {
      calls += 1;
      return answer(calls);
    },
  };
  return { inner, calls: () => calls };
};

const cachedOver = (inner: GroupedSeriesProvider) =>
  makeCachedGroupedSeriesProvider({
    inner,
    cache: createCache({ ttlMs: 60_000, maxEntries: 10 }),
    keyBuilder: createKeyBuilder(),
  });

describe('cached grouped-series provider', () => {
  it('serves a cache hit through the use case with the Map-valued vectors intact', async () => {
    // The first cut stored the output in a serialising cache, which turned
    // every `valuesBySirutaCode` Map into `{}` and made the SECOND public map
    // read throw inside the use case (Codex P1). Two consecutive use-case
    // calls must both build the same matrix.
    const { inner, calls } = innerCounting(() => Promise.resolve(ok(output('RON'))));
    const provider = cachedOver(inner);
    const first = await getGroupedSeriesData({ provider }, { request: request() });
    const second = await getGroupedSeriesData({ provider }, { request: request() });
    expect(first.isOk()).toBe(true);
    expect(second._unsafeUnwrap().rows).toEqual(first._unsafeUnwrap().rows);
    expect(second._unsafeUnwrap().rows.map((r) => r.sirutaCode)).toEqual(['1001', '2002']);
    expect(second._unsafeUnwrap().rows.map((r) => r.valuesBySeriesId.get('s1'))).toEqual([
      '10.50',
      '20.25',
    ]);
    expect(calls()).toBe(1);
  });

  it('serves a repeat of the same request from memory, whoever asks', async () => {
    const { inner, calls } = innerCounting((n) => Promise.resolve(ok(output(`run-${String(n)}`))));
    const provider = cachedOver(inner);
    const first = await provider.fetchGroupedSeriesVectors(request());
    const second = await provider.fetchGroupedSeriesVectors(request({ requestUserId: 'user_1' }));
    expect(first._unsafeUnwrap().vectors[0]?.unit).toBe('run-1');
    expect(second._unsafeUnwrap().vectors[0]?.unit).toBe('run-1');
    expect(calls()).toBe(1);
  });

  it('keys on granularity, series and groups', async () => {
    const { inner, calls } = innerCounting((n) => Promise.resolve(ok(output(`run-${String(n)}`))));
    const provider = cachedOver(inner);
    await provider.fetchGroupedSeriesVectors(request());
    await provider.fetchGroupedSeriesVectors(request({ granularity: 'County' }));
    await provider.fetchGroupedSeriesVectors(
      request({
        groups: [
          {
            groupWorkspaceId: 'w',
            groupId: 'g',
            sourceSeriesId: 's1',
            memberTerritoryCodes: ['1'],
          },
        ],
      })
    );
    expect(calls()).toBe(3);
  });

  it('never memoises a request that names an uploaded dataset', async () => {
    const { inner, calls } = innerCounting((n) => Promise.resolve(ok(output(`run-${String(n)}`))));
    const provider = cachedOver(inner);
    const uploaded = request({
      series: [{ id: 'u', type: 'uploaded-map-dataset', datasetPublicId: 'abc' } as never],
    });
    expect(isCacheableGroupedSeriesRequest(uploaded)).toBe(false);
    await provider.fetchGroupedSeriesVectors(uploaded);
    await provider.fetchGroupedSeriesVectors(uploaded);
    expect(calls()).toBe(2);
  });

  it('does not replay an error', async () => {
    const { inner, calls } = innerCounting((n) =>
      Promise.resolve(n === 1 ? err(createProviderError('down')) : ok(output('recovered')))
    );
    const provider = cachedOver(inner);
    expect((await provider.fetchGroupedSeriesVectors(request())).isErr()).toBe(true);
    expect(
      (await provider.fetchGroupedSeriesVectors(request()))._unsafeUnwrap().vectors[0]?.unit
    ).toBe('recovered');
    expect(calls()).toBe(2);
  });

  it('coalesces identical concurrent requests into one computation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { inner, calls } = innerCounting(async (n) => {
      await gate;
      return ok(output(`run-${String(n)}`));
    });
    const provider = cachedOver(inner);
    const a = provider.fetchGroupedSeriesVectors(request());
    const b = provider.fetchGroupedSeriesVectors(request());
    release?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra._unsafeUnwrap().vectors[0]?.unit).toBe('run-1');
    expect(rb._unsafeUnwrap().vectors[0]?.unit).toBe('run-1');
    expect(calls()).toBe(1);
  });
});
