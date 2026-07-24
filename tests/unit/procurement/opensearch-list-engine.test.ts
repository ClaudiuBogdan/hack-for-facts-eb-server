/**
 * The list engine's fail-closed contract (codex review, 2026-07-25).
 *
 * OpenSearch answers HTTP 200 for a search that timed out or lost a shard,
 * and reports `relation: "eq"` on a count taken over the shards that DID
 * answer. Serving that as an exact total and a complete page is the worst
 * failure this surface can produce, so the engine rejects any response it
 * cannot prove complete — and refuses an index with no gated build stamp,
 * because an undated list silently reads as live.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeOpenSearchListEngine } from '@/modules/procurement/shell/repo/opensearch-list-repo.js';

import type { OffsetSearchRequest } from '@/modules/procurement/core/types.js';

const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }));

vi.mock('node:https', () => ({
  request: (...args: unknown[]): unknown => httpsRequestMock(...args) as unknown,
}));

type Handler = (chunk?: Buffer) => void;

/** Queue one JSON body per HTTPS call the engine makes (search, then _mapping). */
const respondWith = (...payloads: readonly unknown[]): void => {
  const bodies = [...payloads];
  httpsRequestMock.mockImplementation(
    (_options: unknown, callback: (res: unknown) => void) => {
      const body = JSON.stringify(bodies.shift() ?? {});
      const listeners: Record<string, Handler[]> = {};
      const res = {
        statusCode: 200,
        on: (event: string, handler: Handler) => {
          (listeners[event] ??= []).push(handler);
          return res;
        },
      };
      queueMicrotask(() => {
        callback(res);
        for (const handler of listeners['data'] ?? []) handler(Buffer.from(body));
        for (const handler of listeners['end'] ?? []) handler();
      });
      return { on: () => undefined, end: () => undefined, destroy: () => undefined };
    }
  );
};

const page: OffsetSearchRequest = { page: 1, pageSize: 20, sort: 'date_desc' };
// A fresh engine per test: the build-stamp read is cached for five minutes,
// so a shared instance would carry one test's missing stamp into the next.
const newEngine = () =>
  makeOpenSearchListEngine({
    url: 'https://search.invalid:9200',
    indexes: { contracts: 'proto_contracts' },
  });
const completeShards = { total: 1, successful: 1, skipped: 0, failed: 0 };
const stamped = {
  proto_contracts: { mappings: { _meta: { built_at: '2026-07-24T21:58:58Z' } } },
};

afterEach(() => {
  httpsRequestMock.mockReset();
});

describe('opensearch list engine — fail closed', () => {
  it('rejects a timed-out search even though it reports an exact total', async () => {
    respondWith(
      {
        timed_out: true,
        _shards: completeShards,
        hits: { total: { value: 42, relation: 'eq' }, hits: [{ _id: 'c1' }] },
      },
      stamped
    );
    expect((await newEngine().search('contracts', {}, page)).isErr()).toBe(true);
  });

  it('rejects a search that lost a shard', async () => {
    respondWith(
      {
        _shards: { total: 2, successful: 1, skipped: 0, failed: 1 },
        hits: { total: { value: 7, relation: 'eq' }, hits: [] },
      },
      stamped
    );
    expect((await newEngine().search('contracts', {}, page)).isErr()).toBe(true);
  });

  it('rejects an index with no build stamp rather than serving an undated list', async () => {
    respondWith(
      {
        _shards: completeShards,
        hits: { total: { value: 1, relation: 'eq' }, hits: [{ _id: 'c1' }] },
      },
      { proto_contracts: { mappings: {} } }
    );
    expect((await newEngine().search('contracts', {}, page)).isErr()).toBe(true);
  });

  it('serves a complete, stamped response with ordered pks', async () => {
    respondWith(
      {
        _shards: completeShards,
        hits: {
          total: { value: 2, relation: 'eq' },
          hits: [{ _id: 'c10' }, { _id: 'c11' }],
        },
      },
      stamped
    );
    const result = await newEngine().search('contracts', {}, page);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      pks: [10, 11],
      total: 2,
      totalExhaustive: true,
      asOf: '2026-07-24T21:58:58Z',
    });
  });

  it('serves the page WITHOUT facets when a facet block is unparseable', async () => {
    respondWith(
      {
        _shards: completeShards,
        hits: { total: { value: 5, relation: 'eq' }, hits: [{ _id: 'c1' }] },
        // `sum_other_doc_count` missing: the remainder is unknown, so the
        // distribution cannot be presented as complete.
        aggregations: { status: { buckets: [{ key: 'awarded', doc_count: 3 }] } },
      },
      stamped
    );
    const result = await newEngine().search('contracts', {}, page, ['status']);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().facets).toEqual([]);
  });
});
