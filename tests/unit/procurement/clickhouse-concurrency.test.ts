/**
 * The procurement ClickHouse reader under the per-pod cap: reads over the cap
 * wait and then run; a full queue or a timed-out wait answers a retryable
 * ServiceUnavailable (never sent upstream); ClickHouse's own
 * TOO_MANY_SIMULTANEOUS_QUERIES (code 202) answers the same error, with static
 * text, never ClickHouse's message (its version, user and limit).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLICKHOUSE_CONCURRENCY,
  CLICKHOUSE_RETRY_AFTER_SECONDS,
  makeClickhouseAnalysisRepo,
} from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse, generationWithoutFrameworkRole as GEN } from './clickhouse-response.js';

import type { AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import type { AnalysisRepo } from '@/modules/procurement/core/ports.js';
import type { ConcurrencyGateOptions } from '@/modules/shared/index.js';

const activeGeneration: AnalysisRepo['activeGeneration'] = () =>
  Promise.reject(new Error('activeGeneration is not used by these tests'));

const route: AnalysisRoute = { grain: 'contract' };

const statsRow = {
  rows: '1',
  with_value: '1',
  with_estimated: '0',
  awarded_bani_out: '100',
  estimated_bani_out: null,
  ceiling_bani_out: null,
  mod_adjusted_bani_out: null,
  awarded_matched_bani_out: null,
  min_month: '2025-01',
  max_month: '2025-01',
  undated_count: '0',
  undated_bani_out: null,
  withheld_bani_out: null,
};

const RAW_202 =
  'Code: 202. DB::Exception: Too many simultaneous queries for user api_reader. Maximum: 6. (TOO_MANY_SIMULTANEOUS_QUERIES) (version 25.3.1.1)';

const makeRepo = (concurrency?: ConcurrencyGateOptions): AnalysisRepo =>
  makeClickhouseAnalysisRepo(
    {
      url: 'http://clickhouse.test',
      database: 'proto',
      ...(concurrency !== undefined && { concurrency }),
    },
    activeGeneration
  );

/** A fetch whose responses the test releases one by one. */
const heldFetch = () => {
  const held: ((response: Response) => void)[] = [];
  const spy = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        held.push(resolve);
      })
  );
  vi.stubGlobal('fetch', spy);
  return {
    spy,
    releaseNext: () => held.shift()?.(compactResponse([statsRow])),
  };
};

const BUSY = {
  type: 'ServiceUnavailable',
  message: 'procurement analytics is busy; retry shortly',
  retryAfterSeconds: CLICKHOUSE_RETRY_AFTER_SECONDS,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ClickHouse per-pod read cap', () => {
  it('defaults to 3 per pod, so 2 replicas stay within the server limit of 6', () => {
    expect(CLICKHOUSE_CONCURRENCY.maxConcurrent * 2).toBeLessThanOrEqual(6);
  });

  it('sends at most N reads; the (N+1)-th waits and then runs', async () => {
    const upstream = heldFetch();
    const repo = makeRepo({ maxConcurrent: 2, maxQueued: 4, queueWaitMs: 5_000 });
    const reads = [2021, 2022, 2023].map((year) => repo.statsFor(route, { year }, GEN));
    await vi.waitFor(() => {
      expect(upstream.spy).toHaveBeenCalledTimes(2);
    });
    // Still two: the third is queued, not sent.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upstream.spy).toHaveBeenCalledTimes(2);
    upstream.releaseNext();
    await vi.waitFor(() => {
      expect(upstream.spy).toHaveBeenCalledTimes(3);
    });
    upstream.releaseNext();
    upstream.releaseNext();
    const results = await Promise.all(reads);
    expect(results.every((result) => result.isOk())).toBe(true);
  });

  it('answers a retryable busy error, without a request, when the queue is full', async () => {
    const upstream = heldFetch();
    const repo = makeRepo({ maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5_000 });
    const first = repo.statsFor(route, { year: 2021 }, GEN);
    const second = repo.statsFor(route, { year: 2022 }, GEN);
    const third = await repo.statsFor(route, { year: 2023 }, GEN);
    expect(third._unsafeUnwrapErr()).toEqual(BUSY);
    upstream.releaseNext();
    await vi.waitFor(() => {
      expect(upstream.spy).toHaveBeenCalledTimes(2);
    });
    upstream.releaseNext();
    expect((await first).isOk()).toBe(true);
    expect((await second).isOk()).toBe(true);
    expect(upstream.spy).toHaveBeenCalledTimes(2);
  });

  it('answers the busy error when a read waits past the timeout', async () => {
    const upstream = heldFetch();
    const repo = makeRepo({ maxConcurrent: 1, maxQueued: 4, queueWaitMs: 20 });
    const first = repo.statsFor(route, { year: 2021 }, GEN);
    const waited = await repo.statsFor(route, { year: 2022 }, GEN);
    expect(waited._unsafeUnwrapErr()).toEqual(BUSY);
    upstream.releaseNext();
    expect((await first).isOk()).toBe(true);
    expect(upstream.spy).toHaveBeenCalledTimes(1);
  });

  it('frees the slot when a read fails, so the next one runs', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : Promise.resolve(compactResponse([statsRow]));
      })
    );
    const repo = makeRepo({ maxConcurrent: 1, maxQueued: 0, queueWaitMs: 5_000 });
    expect((await repo.statsFor(route, { year: 2021 }, GEN)).isErr()).toBe(true);
    expect((await repo.statsFor(route, { year: 2022 }, GEN)).isOk()).toBe(true);
  });
});

describe('ClickHouse TOO_MANY_SIMULTANEOUS_QUERIES', () => {
  it.each([
    [
      'the exception-code header',
      () =>
        new Response(RAW_202, {
          status: 500,
          headers: { 'x-clickhouse-exception-code': '202' },
        }),
    ],
    ['the body prefix', () => new Response(RAW_202, { status: 500 })],
  ])('maps code 202 (read from %s) to the retryable busy error', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const error = (await makeRepo().statsFor(route, {}, GEN))._unsafeUnwrapErr();
    expect(error).toEqual(BUSY);
    expect(JSON.stringify(error)).not.toMatch(/api_reader|version|Maximum/u);
  });

  it('keeps other ClickHouse failures a database error, without ClickHouse text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Code: 60. DB::Exception: Unknown table proto.x for user api_reader', {
          status: 404,
          headers: { 'x-clickhouse-exception-code': '60' },
        })
      )
    );
    const error = (await makeRepo().statsFor(route, {}, GEN))._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'Database', message: 'clickhouse HTTP 404 (code 60)' });
    expect(JSON.stringify(error)).not.toContain('api_reader');
  });
});
