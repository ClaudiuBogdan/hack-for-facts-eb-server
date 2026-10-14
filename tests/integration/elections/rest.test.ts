/**
 * Elections REST over the REAL plugin (Fastify inject) and the REAL MCP
 * dispatcher, both over one in-memory repository: the same items, totals and
 * paging for the same inputs, one 404 for absent and restricted rows, query
 * decoding before any read, fixed 5xx messages and no-store on every reply.
 * The last block boots the real redesign composition to prove the mount.
 */
import rateLimit from '@fastify/rate-limit';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { err } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeElectionsMcpTools } from '@/modules/elections/shell/mcp/tools.js';
import { makeElectionsRestPlugin } from '@/modules/elections/shell/rest/routes.js';
import {
  createMcpHttpDispatcher,
  databaseError,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import { makeFakeElectionsRepo, RESTRICTED_SENTINEL } from '../../fixtures/elections/catalog.js';

import type { ElectionsRepository } from '@/modules/elections/index.js';

const apps: FastifyInstance[] = [];

const restApp = async (repo: ElectionsRepository) => {
  const app = fastifyLib({ logger: false });
  await app.register(makeElectionsRestPlugin({ repo }), { prefix: '/api/v1/elections' });
  await app.ready();
  apps.push(app);
  return app;
};

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

interface Envelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly meta?: Record<string, unknown>;
  readonly error?: string;
  readonly message?: string;
  readonly field?: string;
  readonly resource?: string;
  readonly requestId?: string;
}

const structured = async (name: string, args: Record<string, unknown>) => {
  const dispatcher = createMcpHttpDispatcher(() =>
    createKernelMcpServer(makeElectionsMcpTools({ repo: makeFakeElectionsRepo() }))
  );
  const response = (await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { structuredContent?: Record<string, unknown> } };
  await dispatcher.close();
  const content = response.result?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return content;
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await restApp(makeFakeElectionsRepo());
});

const get = async (url: string, target: FastifyInstance = app) => {
  const res = await target.inject({ method: 'GET', url: `/api/v1/elections${url}` });
  return {
    status: res.statusCode,
    headers: res.headers,
    raw: res.body,
    body: res.json<Envelope>(),
  };
};

const withoutRequestId = ({ requestId: _ignored, ...rest }: Envelope) => rest;

describe('elections REST and MCP parity', () => {
  it('returns the same catalog page, total and paging flags as the MCP tool', async () => {
    const res = await get('/editions?reportedYears=2024&page=1&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const mcp = await structured('list_election_editions', {
      filter: { reportedYears: { in: [2024] } },
      page: 1,
      pageSize: 2,
    });
    expect(res.body).toMatchObject({
      ok: true,
      data: mcp['items'],
      meta: {
        page: { page: 1, pageSize: 2, total: 3 },
        hasMore: true,
        totalCounts: 'source_editions',
      },
      requestId: expect.any(String) as unknown,
    });
  });

  it('reads a repeated parameter as one list, ANDed across fields', async () => {
    const res = await get(
      '/editions?reportedYears=2009&reportedYears=2014&reportedFamilies=parliamentary'
    );
    expect((res.body.data as { electionKey: string }[]).map((item) => item.electionKey)).toEqual([
      'bec-european-2009',
    ]);
    const european = await get('/editions?reportedFamilies=european');
    expect(european.body).toMatchObject({ ok: true, data: [], meta: { page: { total: 0 } } });
  });

  it('returns the same contest list and details as the MCP tools', async () => {
    const list = await get('/contests?electionKey=bec-local-2024&reportedOffices=mayor');
    const mcpList = await structured('list_election_contests', {
      electionKey: 'bec-local-2024',
      filter: { reportedOffices: { in: ['mayor'] } },
    });
    expect(list.body).toMatchObject({
      ok: true,
      data: mcpList['items'],
      meta: { page: { total: 3 }, totalCounts: 'source_contests' },
    });

    const contestKey = 'contest:aep-local-2014-t1:mayor:siruta:179141';
    const contest = await get(`/contests/lookup?contestKey=${encodeURIComponent(contestKey)}`);
    const mcpContest = await structured('get_election_contest', { contestKey });
    expect(contest.body).toMatchObject({ ok: true, data: mcpContest['item'] });

    const edition = await get('/editions/lookup?electionKey=bec-local-2024');
    const mcpEdition = await structured('get_election_edition', { electionKey: 'bec-local-2024' });
    expect(edition.body).toMatchObject({ ok: true, data: mcpEdition['item'] });
    expect(edition.body.data).toMatchObject({
      verifiedYear: null,
      readiness: { identity: 'HELD', results: 'UNAVAILABLE', mandates: 'UNAVAILABLE' },
    });
  });

  it('serves no restricted value anywhere in full listings', async () => {
    const editions = await get('/editions?pageSize=100');
    const contests = await get('/contests?electionKey=bec-local-2024&pageSize=100');
    expect(editions.raw + contests.raw).not.toContain(RESTRICTED_SENTINEL);
    expect(contests.body.meta).toMatchObject({ page: { total: 6 } });
  });
});

describe('elections REST privacy: one 404 for absent and restricted rows', () => {
  it.each([
    ['/editions/lookup?electionKey=', 'edition'],
    ['/contests?electionKey=', 'edition list'],
    ['/contests/lookup?contestKey=', 'contest'],
  ])('answers %s the same for a restricted and an absent key (%s)', async (path) => {
    const restrictedKey = path.startsWith('/contests/lookup')
      ? `contest:bec-local-2024:mayor:siruta:${RESTRICTED_SENTINEL}`
      : `restricted-${RESTRICTED_SENTINEL}`;
    const restricted = await get(`${path}${encodeURIComponent(restrictedKey)}`);
    const absent = await get(`${path}no-such-key`);
    expect(restricted.status).toBe(404);
    expect(restricted.body).toMatchObject({ ok: false, error: 'NotFound' });
    expect(withoutRequestId(restricted.body)).toEqual(withoutRequestId(absent.body));
    expect(restricted.raw).not.toContain(RESTRICTED_SENTINEL);
    expect(restricted.headers['cache-control']).toBe('no-store');
  });

  it('refuses a contest under a restricted edition like an absent one', async () => {
    const key = `contest:restricted-${RESTRICTED_SENTINEL}:mayor:siruta:1017`;
    const res = await get(`/contests/lookup?contestKey=${encodeURIComponent(key)}`);
    expect(res.status).toBe(404);
    expect(res.raw).not.toContain(RESTRICTED_SENTINEL);
  });
});

describe('elections REST query decoding (fail fast, no repository call)', () => {
  it.each([
    ['an unknown parameter', '/editions?verifiedYears=2024', 'query'],
    ['a repeated scalar', '/editions?page=1&page=2', 'page'],
    ['a non-integer page', '/editions?page=abc', 'page'],
    ['a fractional pageSize', '/editions?pageSize=1.5', 'pageSize'],
    ['pageSize over the kernel maximum', '/editions?pageSize=101', 'pageSize'],
    ['page 0', '/editions?page=0', 'page'],
    ['an unsafe page offset', `/editions?page=${String(Number.MAX_SAFE_INTEGER)}`, 'page'],
    ['a non-integer year', '/editions?reportedYears=2024a', 'reportedYears'],
    ['a year out of range', '/editions?reportedYears=24', 'reportedYears'],
    ['an empty label', '/editions?reportedFamilies=', 'reportedFamilies'],
    ['a missing edition key', '/editions/lookup', 'electionKey'],
    ['a repeated edition key', '/editions/lookup?electionKey=a&electionKey=b', 'electionKey'],
    ['a contest list without its edition', '/contests?reportedOffices=mayor', 'electionKey'],
    ['an empty contest key', '/contests/lookup?contestKey=', 'contestKey'],
    ['an over-long key', `/contests/lookup?contestKey=${'k'.repeat(513)}`, 'contestKey'],
  ])('rejects %s with 400', async (_label, url, field) => {
    const repo = makeFakeElectionsRepo();
    const res = await get(url, await restApp(repo));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'InvalidInput', field });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(repo.calls).toEqual([]);
  });

  it('rejects an unknown scope type without echoing it', async () => {
    const repo = makeFakeElectionsRepo();
    const res = await get(
      '/contests?electionKey=bec-local-2024&scopeTypes=polling_station',
      await restApp(repo)
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'InvalidInput' });
    expect(res.raw).not.toContain('polling_station');
    expect(repo.calls).toEqual([]);
  });

  it('carries an opaque key longer than a path parameter, with reserved characters', async () => {
    const electionKey = `src/${'x'.repeat(300)}?%#&=`;
    const repo = makeFakeElectionsRepo({
      editions: [
        {
          electionKey,
          privacyClass: 'public',
          name: 'Long key edition',
          family: 'local',
          year: 2020,
          round: null,
          date: null,
          authority: 'BEC/AEP/ROAEP',
          event: null,
        },
      ],
      contests: [],
    });
    const res = await get(
      `/editions/lookup?electionKey=${encodeURIComponent(electionKey)}`,
      await restApp(repo)
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ electionKey });
  });

  it('answers HEAD on the same routes', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/api/v1/elections/editions' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('elections REST failures carry fixed messages', () => {
  const failing = (failure: ApiError): ElectionsRepository => ({
    listEditions: () => Promise.resolve(err(failure)),
    editionByKey: () => Promise.resolve(err(failure)),
    listContests: () => Promise.resolve(err(failure)),
    contestByKey: () => Promise.resolve(err(failure)),
  });

  it('maps a read failure to 500 without its cause', async () => {
    const res = await get(
      '/editions',
      await restApp(failing(databaseError('Elections read failed', new Error('relation secret'))))
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'Database' });
    expect(res.body.message).toBe('elections read failed; quote the requestId to report it');
    expect(res.raw).not.toContain('secret');
  });

  it('maps the disabled module to 503', async () => {
    const res = await get(
      '/contests/lookup?contestKey=k',
      await restApp(failing(serviceUnavailable('Elections are not enabled on this server.')))
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'ServiceUnavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('maps a thrown fault to the fixed 500 without its text', async () => {
    const throwing: ElectionsRepository = {
      ...makeFakeElectionsRepo(),
      listEditions: () => Promise.reject(new Error('pool secret exploded')),
    };
    const res = await get('/editions', await restApp(throwing));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'Database',
      message: 'elections read failed; quote the requestId to report it',
    });
    expect(res.raw).not.toContain('secret');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // On api.js the module inherits the global @fastify/rate-limit onRequest hook,
  // whose refusal reaches this plugin's error handler.
  it('keeps an inherited rate-limit refusal a 429 with Retry-After', async () => {
    const repo = makeFakeElectionsRepo();
    const limited = fastifyLib({ logger: false });
    apps.push(limited);
    await limited.register(rateLimit, { max: 1, timeWindow: 60_000 });
    await limited.register(makeElectionsRestPlugin({ repo }), { prefix: '/api/v1/elections' });
    await limited.ready();
    const first = await get('/editions', limited);
    expect(first.status).toBe(200);
    const second = await get('/editions', limited);
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.body).toEqual({
      ok: false,
      error: 'RateLimited',
      message: 'rate limit exceeded; retry later',
      requestId: expect.any(String) as unknown,
    });
    expect(repo.calls).toEqual(['listEditions']);
  });
});

// The real composition over a closed-port pool: only pre-database answers run.
describe('elections REST mounts with the module', () => {
  type Modules = NonNullable<Parameters<typeof buildRedesignApp>[0]['modules']>;

  const boot = async (modules: Modules, electionsEnabled?: boolean) => {
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules,
      ...(electionsEnabled === undefined ? {} : { electionsEnabled }),
      procurementWarmCache: false,
      kernelConfig: {
        prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
    });
    apps.push(built.app);
    await built.app.ready();
    return built.app;
  };

  it('refuses every read while disabled (the default) without a query', async () => {
    const res = await get('/editions', await boot(['elections']));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'ServiceUnavailable' });
  }, 60_000);

  it('validates on the enabled mount, and is absent without the module', async () => {
    const enabled = await get('/editions?page=0', await boot(['elections'], true));
    expect(enabled.status).toBe(400);
    expect(enabled.body).toMatchObject({ ok: false, error: 'InvalidInput', field: 'page' });
    const without = await boot(['ngos']);
    const res = await without.inject({ method: 'GET', url: '/api/v1/elections/editions' });
    expect(res.statusCode).toBe(404);
  }, 60_000);
});
