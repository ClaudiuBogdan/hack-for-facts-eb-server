/**
 * Legislation analytics (design §11): the validation every surface shares,
 * the layer-keyed cache, the layer-changed retry, and the three surfaces over
 * one usecase (REST with its validator and 304, GraphQL `legalAnalytics`,
 * MCP `query_legal_analytics`), over an in-memory repo.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { graphql } from 'graphql';
import { err, ok, type Result } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeActsCursor,
  parseLegalAnalyticsRequest,
} from '@/modules/legal/core/analytics/request.js';
import {
  ANALYTICS_BUSY,
  ANALYTICS_SLOTS,
  getLegalAnalytics,
  LAYER_CHANGED,
  makeLegalAnalyticsGate,
  type LegalAnalyticsDeps,
  type LegalAnalyticsRepo,
  type LegalAnalyticsViewRequest,
} from '@/modules/legal/core/analytics/usecases.js';
import {
  legalAnalyticsTypeDefs,
  makeLegalAnalyticsMcpTool,
  makeLegalAnalyticsResolvers,
} from '@/modules/legal/shell/analytics-surfaces.js';
import {
  decodeAnalyticsQuery,
  makeLegalAnalyticsRoutes,
} from '@/modules/legal/shell/rest/analytics-routes.js';
import {
  createCache,
  createMcpHttpDispatcher,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import type {
  LegalAnalyticsActs,
  LegalAnalyticsData,
  LegalAnalyticsHead,
  LegalAnalyticsSummary,
} from '@/modules/legal/core/analytics/types.js';

const headOf = (layerId: string): LegalAnalyticsHead => ({
  layer: {
    layerId,
    releaseId: '6',
    builtAt: '2026-11-24T20:36:43Z',
    publishedAt: '2026-11-24T20:36:49Z',
    releaseBuiltAt: '2026-11-21T17:19:17Z',
    releasePublishedAt: '2026-11-21T17:22:11Z',
  },
  rules: { felul: 'felul-v6-2026-11-24', stock: 'stock-firm-2026-11-24' },
  values: {
    felulGroups: ['rule-making', 'individual', 'court', 'unplaced'],
    felulKinds: {
      new_rules: 'rule-making',
      amendment: 'rule-making',
      appointments: 'individual',
      court: 'court',
      unplaced: 'unplaced',
    },
    stockKinds: ['new_rules'],
    weakBases: ['fallback', 'instrument_default'],
    issuerFamilies: ['guvern', 'parlament', 'fara_emitent'],
    linkKinds: ['amends', 'court_names'],
    linkNotes: ['resolved', 'code'],
  },
  total: 10,
  population: 10,
  totals: { acts: 10, actsWithText: 6, inStock: 3, uncertain: 2, unplaced: 1 },
  types: [
    { key: 'hotarare', acts: 6 },
    { key: 'lege', acts: 4 },
  ],
  issuerCount: 2,
  issuers: [
    { lineage: 'Guvernul', families: ['guvern'], acts: 6 },
    { lineage: 'Parlamentul', families: ['parlament'], acts: 4 },
    { lineage: `Ministerul ${'x'.repeat(300)}`, families: ['guvern'], acts: 1 },
  ],
  years: { min: 1990, max: 2026 },
});

const summaryOf = (total: number, stock = false): LegalAnalyticsSummary => ({
  total,
  population: stock ? 3 : 10,
  // the stock holds firm placements only: no uncertain act is ever in it
  uncertain: stock ? 0 : 2,
  unplaced: 1,
  withText: 6,
  withVersions: 3,
  felul: [{ key: 'rule-making', acts: total }],
});

/** One unnamed row, as the repo returns it (ids only). */
const actsOf = (): LegalAnalyticsActs => ({
  total: 10,
  population: 10,
  uncertain: 2,
  unplaced: 1,
  order: 'amended',
  hidden: 0,
  next: null,
  rows: [
    {
      actId: '42',
      citation: '',
      title: null,
      year: 2001,
      type: 'lege',
      issuer: 'Parlamentul',
      family: 'parlament',
      felul: 'rule-making',
      kind: 'new_rules',
      guess: null,
      amended: 3,
      court: 0,
      versions: 2,
      cited: 1,
      hasText: true,
    },
  ],
});

/** An in-memory repo: one layer at a time; `publish` moves the pointer. */
const fakeRepo = () => {
  let current = '7';
  const calls = { head: 0, read: 0 };
  const failNext: { error: ApiError | null } = { error: null };
  const repo: LegalAnalyticsRepo = {
    readHead: () => {
      calls.head += 1;
      return Promise.resolve(ok(headOf(current)));
    },
    read: (
      request: LegalAnalyticsViewRequest,
      head: LegalAnalyticsHead
    ): Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>> => {
      calls.read += 1;
      if (failNext.error !== null) {
        const e = failNext.error;
        failNext.error = null;
        return Promise.resolve(err(e));
      }
      if (head.layer.layerId !== current) return Promise.resolve(ok(LAYER_CHANGED));
      if (request.view === 'acts') return Promise.resolve(ok(actsOf()));
      const stock = request.filter.population === 'stock';
      return Promise.resolve(ok(summaryOf(stock ? 3 : 10, stock)));
    },
  };
  return {
    repo,
    calls,
    failNext,
    publish: (layer: string) => {
      current = layer;
    },
  };
};

const depsOf = (repo: LegalAnalyticsRepo, slots = ANALYTICS_SLOTS): LegalAnalyticsDeps => ({
  repo,
  gate: makeLegalAnalyticsGate(slots),
  inflight: new Map(),
  heads: createCache({ ttlMs: 60_000, maxEntries: 4 }),
  answers: createCache({ ttlMs: 60_000, maxEntries: 100 }),
});

describe('legal analytics request validation', () => {
  const head = headOf('7');

  it('drops defaults, sorts lists and keys the canonical form', () => {
    const a = parseLegalAnalyticsRequest(
      'breakdown',
      { type: ['lege', 'hotarare', 'lege'], lens: 'felul', limit: 30, population: 'flow' },
      head
    )._unsafeUnwrap();
    const b = parseLegalAnalyticsRequest(
      'breakdown',
      { type: ['hotarare', 'lege'] },
      head
    )._unsafeUnwrap();
    expect(a.key).toBe(b.key);
    expect(a.args).toEqual({ type: ['hotarare', 'lege'] });
  });

  it('refuses values the layer does not hold and arguments of another view', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['summary', { type: ['circulara'] }, 'type'],
      // 26 copies of one valid type: the raw list is bounded before de-duplication
      ['summary', { type: new Array<string>(26).fill('lege') }, 'type'],
      ['summary', { issuer: 'Nimeni' }, 'issuer'],
      ['summary', { family: 'altele' }, 'family'],
      ['summary', { felul: 'pardons' }, 'felul'],
      ['summary', { from: 2020, to: 2010 }, 'from'],
      ['summary', { versions: 4 }, 'versions'],
      ['summary', { population: 'all' }, 'population'],
      ['summary', { lens: 'type' }, 'lens'],
      ['breakdown', { lens: 'topic' }, 'lens'],
      ['grid', { lens: 'type', by: 'type' }, 'by'],
      ['series', { lens: 'year' }, 'lens'],
      ['acts', { order: 'title' }, 'order'],
      ['acts', { limit: 51 }, 'limit'],
      ['head', { type: ['lege'] }, 'type'],
    ];
    for (const [view, args, field] of cases) {
      const r = parseLegalAnalyticsRequest(view as 'summary', args, head);
      expect(r.isErr(), `${view} ${JSON.stringify(args)}`).toBe(true);
      expect(r._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field });
    }
  });

  it('accepts a lineage the layer knows whatever its length', () => {
    const long = `Ministerul ${'x'.repeat(300)}`;
    expect(parseLegalAnalyticsRequest('summary', { issuer: long }, head).isOk()).toBe(true);
    expect(parseLegalAnalyticsRequest('summary', { issuer: `${long}y` }, head).isErr()).toBe(true);
    // exact first, then the trimmed value
    expect(
      parseLegalAnalyticsRequest('summary', { issuer: ' Guvernul ' }, head)._unsafeUnwrap()
    ).toMatchObject({
      args: { issuer: 'Guvernul' },
    });
  });

  it('issues a cursor that fits whatever the filter, and takes it back (a 1,600-byte issuer)', () => {
    const long = `Ministerul ${'y'.repeat(1_590)}`;
    const wide = {
      ...head,
      issuers: [...head.issuers, { lineage: long, families: ['guvern'], acts: 2 }],
    };
    const first = parseLegalAnalyticsRequest(
      'acts',
      { issuer: long, limit: 1 },
      wide
    )._unsafeUnwrap();
    const cursor = encodeActsCursor('7', first.view === 'acts' ? first.pageKey : '', {
      value: 0,
      actId: '42',
    });
    expect(cursor.length).toBeLessThan(200);
    const second = parseLegalAnalyticsRequest(
      'acts',
      { issuer: long, limit: 1, cursor },
      wide
    )._unsafeUnwrap();
    expect(second.view === 'acts' && second.after).toEqual({ value: 0, actId: '42' });
    // the incoming cursor is never echoed in the answer's arguments
    expect(second.args).not.toHaveProperty('cursor');
  });

  it('accepts a group, a kind, uncertain and unplaced as felul', () => {
    for (const felul of ['rule-making', 'appointments', 'uncertain', 'unplaced']) {
      expect(parseLegalAnalyticsRequest('summary', { felul }, head).isOk(), felul).toBe(true);
    }
  });

  it('binds an acts cursor to its layer, filter and order', () => {
    const first = parseLegalAnalyticsRequest('acts', { felul: 'court' }, head)._unsafeUnwrap();
    const pageKey = first.view === 'acts' ? first.pageKey : '';
    const cursor = encodeActsCursor('7', pageKey, { value: 4, actId: '123' });
    const next = parseLegalAnalyticsRequest(
      'acts',
      { felul: 'court', cursor },
      head
    )._unsafeUnwrap();
    expect(next.view === 'acts' && next.after).toEqual({ value: 4, actId: '123' });
    expect(next.key).not.toBe(first.key);
    // the cursor-free page key stays the same on every page (page three is reachable)
    expect(next.view === 'acts' && next.pageKey).toBe(pageKey);
    const third = encodeActsCursor('7', pageKey, { value: 2, actId: '99' });
    expect(parseLegalAnalyticsRequest('acts', { felul: 'court', cursor: third }, head).isOk()).toBe(
      true
    );
    // positions PostgreSQL cannot hold, and over-long cursors, are refused before any read
    for (const bad of [
      encodeActsCursor('7', pageKey, { value: 2_147_483_648, actId: '1' }),
      encodeActsCursor('7', pageKey, { value: 1, actId: '9223372036854775808' }),
      'A'.repeat(3_000),
    ]) {
      expect(
        parseLegalAnalyticsRequest('acts', { felul: 'court', cursor: bad }, head)._unsafeUnwrapErr()
      ).toMatchObject({ field: 'cursor' });
    }
    for (const args of [
      { felul: 'individual', cursor },
      { felul: 'court', order: 'year', cursor },
      { felul: 'court', cursor: 'not-a-cursor' },
    ]) {
      expect(parseLegalAnalyticsRequest('acts', args, head)._unsafeUnwrapErr()).toMatchObject({
        field: 'cursor',
      });
    }
    expect(
      parseLegalAnalyticsRequest('acts', { felul: 'court', cursor }, headOf('8'))._unsafeUnwrapErr()
    ).toMatchObject({ field: 'cursor' });
  });
});

describe('legal analytics usecase', () => {
  it('caches answers by layer and canonical arguments, and never caches failures', async () => {
    const f = fakeRepo();
    const deps = depsOf(f.repo);
    const a = await getLegalAnalytics(deps, 'summary', { population: 'stock' });
    const b = await getLegalAnalytics(deps, 'summary', { population: 'stock' });
    expect(a._unsafeUnwrap().data).toEqual(b._unsafeUnwrap().data);
    expect(f.calls.read).toBe(1);
    expect(f.calls.head).toBe(1);
    f.failNext.error = serviceUnavailable('down');
    expect((await getLegalAnalytics(deps, 'summary', {})).isErr()).toBe(true);
    expect((await getLegalAnalytics(deps, 'summary', {})).isOk()).toBe(true);
    expect(f.calls.read).toBe(3);
  });

  it('re-reads the head once when a newer layer was published in between', async () => {
    const f = fakeRepo();
    const deps = depsOf(f.repo);
    expect((await getLegalAnalytics(deps, 'head', {}))._unsafeUnwrap().layer.layerId).toBe('7');
    f.publish('8');
    const answer = await getLegalAnalytics(deps, 'summary', {});
    expect(answer._unsafeUnwrap().layer.layerId).toBe('8');
    expect(f.calls.head).toBe(2);
  });

  it('serves the new layer once the head expires after a publication', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeRepo();
      const deps = depsOf(f.repo);
      expect((await getLegalAnalytics(deps, 'summary', {}))._unsafeUnwrap().layer.layerId).toBe(
        '7'
      );
      f.publish('8');
      // within the head's freshness window the warmed answer of layer 7 is still served
      expect((await getLegalAnalytics(deps, 'summary', {}))._unsafeUnwrap().layer.layerId).toBe(
        '7'
      );
      vi.advanceTimersByTime(61_000);
      expect((await getLegalAnalytics(deps, 'summary', {}))._unsafeUnwrap().layer.layerId).toBe(
        '8'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one read between identical requests and refuses past the slot wait', async () => {
    let releaseRead: () => void = () => undefined;
    const slow = fakeRepo();
    const blocked: LegalAnalyticsRepo = {
      readHead: slow.repo.readHead,
      read: (request, head) =>
        new Promise((resolve) => {
          releaseRead = () => {
            void slow.repo.read(request, head).then(resolve);
          };
        }),
    };
    vi.useFakeTimers();
    try {
      const deps = depsOf(blocked, 1);
      await getLegalAnalytics(deps, 'head', {});
      const a = getLegalAnalytics(deps, 'summary', {});
      const b = getLegalAnalytics(deps, 'summary', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.inflight.size).toBe(1); // one read for both
      const c = getLegalAnalytics(deps, 'summary', { population: 'stock' });
      await vi.advanceTimersByTimeAsync(2_100); // no slot within the wait
      expect((await c)._unsafeUnwrapErr()).toMatchObject({
        type: 'ServiceUnavailable',
        message: ANALYTICS_BUSY,
      });
      releaseRead();
      await vi.advanceTimersByTimeAsync(0);
      expect((await a)._unsafeUnwrap().data).toEqual((await b)._unsafeUnwrap().data);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shares a read of a view that names acts, and shares the head miss under the gate', async () => {
    const f = fakeRepo();
    let reads = 0;
    const repo: LegalAnalyticsRepo = {
      readHead: f.repo.readHead,
      // each read sees the state at its own start: a later read, after a restriction, answers differently
      read: (request, h) => {
        reads += 1;
        const mine = reads;
        return f.repo.read(request, h).then((r) =>
          r.map((d): LegalAnalyticsData | typeof LAYER_CHANGED => {
            if (d === LAYER_CHANGED || request.view !== 'acts') return d;
            const acts = d as LegalAnalyticsActs;
            return {
              ...acts,
              rows: acts.rows.map((row) => ({ ...row, citation: `read ${String(mine)}` })),
            };
          })
        );
      },
    };
    const deps = depsOf(repo);
    const [a, b, c] = await Promise.all([
      getLegalAnalytics(deps, 'acts', {}),
      getLegalAnalytics(deps, 'acts', {}),
      getLegalAnalytics(deps, 'summary', {}),
    ]);
    expect(f.calls.head).toBe(1); // one shared head read for three cold callers
    expect(reads).toBe(3); // two acts reads, one summary read: the acts callers never share
    const citations = [a, b].map(
      (r) => (r._unsafeUnwrap().data as LegalAnalyticsActs).rows[0]?.citation
    );
    expect(new Set(citations).size).toBe(2);
    expect(c.isOk()).toBe(true);
  });

  it('caps the waiters of the gate', async () => {
    const gate = makeLegalAnalyticsGate(1, 2);
    const first = await gate.acquire(1_000);
    expect(first).not.toBeNull();
    const waiting = [gate.acquire(1_000), gate.acquire(1_000)];
    expect(await gate.acquire(1_000)).toBeNull(); // at capacity: refused at once
    first?.();
    expect(await waiting[0]).not.toBeNull();
  });

  it('refuses an unknown view', async () => {
    const r = await getLegalAnalytics(depsOf(fakeRepo().repo), 'topics', {});
    expect(r._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'view' });
    expect(r._unsafeUnwrapErr().message).not.toContain('topics');
  });
});

describe('legal analytics surfaces', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const serve = async (deps: LegalAnalyticsDeps): Promise<FastifyInstance> => {
    const f = fastifyLib();
    await f.register(makeLegalAnalyticsRoutes(deps), { prefix: '/api/v1/legal/analytics' });
    await f.ready();
    return f;
  };

  it('decodes a query strictly', () => {
    expect(decodeAnalyticsQuery({ type: ['lege', 'ordin'], from: '1990' })._unsafeUnwrap()).toEqual(
      {
        type: ['lege', 'ordin'],
        from: 1990,
      }
    );
    expect(decodeAnalyticsQuery({ sort: 'x' }).isErr()).toBe(true);
    expect(decodeAnalyticsQuery({ from: ['1990', '1991'] }).isErr()).toBe(true);
    expect(decodeAnalyticsQuery({ from: '19x0' }).isErr()).toBe(true);
  });

  it('serves REST with a layer-keyed validator, answers 304, and errors no-store', async () => {
    const f = fakeRepo();
    app = await serve(depsOf(f.repo));
    const first = await app.inject({ url: '/api/v1/legal/analytics/summary?population=stock' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toMatch(/^public, max-age=\d+/u);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"legal-analytics-7-[0-9a-f]{20}"$/u);
    expect(first.json()).toMatchObject({
      ok: true,
      data: { total: 3, uncertain: 0, unplaced: 1 },
      meta: { view: 'summary', layer: { layerId: '7' }, args: { population: 'stock' } },
    });
    const reads = f.calls.read;
    const again = await app.inject({
      url: '/api/v1/legal/analytics/summary?population=stock',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(f.calls.read).toBe(reads);
    const bad = await app.inject({ url: '/api/v1/legal/analytics/summary?lens=type' });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
    f.failNext.error = serviceUnavailable('No legislation analytics layer is published.');
    const down = await app.inject({ url: '/api/v1/legal/analytics/summary' });
    expect(down.statusCode).toBe(503);
    expect(down.headers['cache-control']).toBe('no-store');
  });

  it('reads the naming views afresh: no-store, no validator, never cached', async () => {
    const f = fakeRepo();
    app = await serve(depsOf(f.repo));
    const first = await app.inject({ url: '/api/v1/legal/analytics/acts' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers.etag).toBeUndefined();
    const before = f.calls.read;
    const second = await app.inject({
      url: '/api/v1/legal/analytics/acts',
      headers: { 'if-none-match': '*' },
    });
    expect(second.statusCode).toBe(200);
    expect(f.calls.read).toBe(before + 1);
  });

  it('sends no-store on any error reply of the scope, a thrown one included', async () => {
    const broken: LegalAnalyticsRepo = {
      ...fakeRepo().repo,
      read: () => Promise.reject(new Error('driver exploded')),
    };
    app = await serve(depsOf(broken));
    const res = await app.inject({ url: '/api/v1/legal/analytics/summary' });
    expect(res.statusCode).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  it('marks a GraphQL answer that names acts no-store before it awaits', () => {
    const header = vi.fn();
    const resolvers = makeLegalAnalyticsResolvers(depsOf(fakeRepo().repo));
    void resolvers.Query.legalAnalytics(null, { view: 'ACTS' }, { reply: { header } });
    expect(header).toHaveBeenCalledWith('cache-control', 'no-store');
    header.mockReset();
    void resolvers.Query.legalAnalytics(null, { view: 'SUMMARY' }, { reply: { header } });
    expect(header).not.toHaveBeenCalled();
  });

  it('answers the same on REST, GraphQL and MCP', async () => {
    const deps = depsOf(fakeRepo().repo);
    app = await serve(deps);
    const rest = (await app.inject({ url: '/api/v1/legal/analytics/summary?felul=court' })).json<{
      data: unknown;
    }>();
    const schema = makeExecutableSchema({
      typeDefs: [scalarTypeDefs, 'type Query { _empty: Boolean }', legalAnalyticsTypeDefs],
      resolvers: [scalarResolvers, makeLegalAnalyticsResolvers(deps)],
    });
    const gql = await graphql({
      schema,
      source:
        'query { legalAnalytics(view: SUMMARY, args: { felul: "court", lens: null }) { view layer args data } }',
    });
    expect(gql.errors).toBeUndefined();
    const field = (gql.data as { legalAnalytics: { data: unknown; args: unknown } }).legalAnalytics;
    expect(field.data).toEqual(rest.data);
    expect(field.args).toEqual({ felul: 'court' });
    // the tool as the kernel registers and dispatches it (tools/call, with its strict input schema)
    const tool = makeLegalAnalyticsMcpTool(deps, 'https://transparenta.eu');
    const callTool = async (args: Record<string, unknown>) => {
      const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer([tool]));
      const response = (await dispatcher.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'query_legal_analytics', arguments: args },
      })) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
      await dispatcher.close();
      return response.result;
    };
    const mcp = await callTool({ view: 'summary', args: { felul: 'court' } });
    expect(mcp?.structuredContent).toMatchObject({ ok: true, kind: 'legal_analytics' });
    expect((mcp?.structuredContent?.['item'] as { data: unknown }).data).toEqual(rest.data);
    for (const bad of [
      { view: 'topics' },
      { view: 'summary', args: { bogus: 1 } },
      { view: 'summary', extra: 1 },
    ]) {
      expect((await callTool(bad))?.isError, JSON.stringify(bad)).toBe(true);
    }
    const refused = await callTool({ view: 'summary', args: { felul: 'nothing' } });
    expect(refused?.structuredContent).toMatchObject({ ok: false, errorType: 'InvalidInput' });
  });
});
