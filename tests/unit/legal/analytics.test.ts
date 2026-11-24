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
import { afterEach, describe, expect, it } from 'vitest';

import {
  encodeActsCursor,
  parseLegalAnalyticsRequest,
} from '@/modules/legal/core/analytics/request.js';
import {
  getLegalAnalytics,
  LAYER_CHANGED,
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
import { createCache, serviceUnavailable, type ApiError } from '@/modules/shared/index.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import type {
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
  totals: { acts: 10, actsWithText: 6, inStock: 3, uncertain: 2, unplaced: 1 },
  types: [
    { key: 'hotarare', acts: 6 },
    { key: 'lege', acts: 4 },
  ],
  issuerCount: 2,
  issuers: [
    { lineage: 'Guvernul', family: 'guvern', acts: 6 },
    { lineage: 'Parlamentul', family: 'parlament', acts: 4 },
  ],
  years: { min: 1990, max: 2026 },
});

const summaryOf = (total: number): LegalAnalyticsSummary => ({
  total,
  population: 10,
  uncertain: 2,
  unplaced: 1,
  withText: 6,
  withVersions: 3,
  felul: [{ key: 'rule-making', acts: total }],
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
      return Promise.resolve(ok(summaryOf(request.filter.population === 'stock' ? 3 : 10)));
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

const depsOf = (repo: LegalAnalyticsRepo): LegalAnalyticsDeps => ({
  repo,
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

  it('accepts a group, a kind, uncertain and unplaced as felul', () => {
    for (const felul of ['rule-making', 'appointments', 'uncertain', 'unplaced']) {
      expect(parseLegalAnalyticsRequest('summary', { felul }, head).isOk(), felul).toBe(true);
    }
  });

  it('binds an acts cursor to its layer, filter and order', () => {
    const first = parseLegalAnalyticsRequest('acts', { felul: 'court' }, head)._unsafeUnwrap();
    const cursor = encodeActsCursor('7', first.key, { value: 4, actId: '123' });
    const next = parseLegalAnalyticsRequest(
      'acts',
      { felul: 'court', cursor },
      head
    )._unsafeUnwrap();
    expect(next.view === 'acts' && next.after).toEqual({ value: 4, actId: '123' });
    expect(next.key).not.toBe(first.key);
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

  it('refuses an unknown view', async () => {
    const r = await getLegalAnalytics(depsOf(fakeRepo().repo), 'topics', {});
    expect(r._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'view' });
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
      data: { total: 3, uncertain: 2, unplaced: 1 },
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
    const tool = makeLegalAnalyticsMcpTool(deps, 'https://transparenta.eu');
    const mcp = await tool.handler({ view: 'summary', args: { felul: 'court' } });
    expect(mcp).toMatchObject({ ok: true, kind: 'legal_analytics' });
    expect((mcp.item as { data: unknown }).data).toEqual(rest.data);
    const refused = await tool.handler({ view: 'summary', args: { felul: 'nothing' } });
    expect(refused).toMatchObject({ ok: false, errorType: 'InvalidInput' });
  });
});
