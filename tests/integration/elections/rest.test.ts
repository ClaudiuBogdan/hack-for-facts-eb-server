/**
 * Elections REST over the REAL plugin (Fastify inject) and the REAL MCP
 * dispatcher, both over one in-memory repository: the same items, totals and
 * paging for the same inputs, one 404 for absent rows, query decoding before
 * any read, fixed 5xx messages and no-store on every reply. The last block
 * boots the real redesign composition to prove the mount.
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
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import {
  COUNCIL,
  EVENT,
  MAYOR,
  OCCURRENCE,
  makeFakeElectionsRepo,
} from '../../fixtures/elections/results.js';

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

const q = encodeURIComponent;

describe('elections REST reads', () => {
  it('pages events with the same items and meta as MCP', async () => {
    const res = await get('/events');
    expect(res.status, res.raw).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.meta).toEqual({
      page: { page: 1, pageSize: 20, total: 1 },
      hasMore: false,
      totalCounts: 'events',
    });
    const tool = await structured('list_election_events', {});
    expect(tool['items']).toEqual(res.body.data);
    expect(res.body.data).toEqual([
      expect.objectContaining({ eventKey: EVENT, family: 'local', year: 2024 }),
    ]);
  });

  it('looks up an event, and answers 404 for an unpublished one', async () => {
    const res = await get(`/events/lookup?eventKey=${q(EVENT)}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({
      eventKey: EVENT,
      occurrences: [{ occurrenceKey: OCCURRENCE }],
    });
    expect(res.body.data).not.toHaveProperty('sources');
    expect(await structured('get_election_event', { eventKey: EVENT })).toMatchObject({
      item: res.body.data,
    });
    const absent = await get('/events/lookup?eventKey=ro:local:2016');
    expect(absent.status).toBe(404);
    expect(absent.body).toMatchObject({ ok: false, error: 'NotFound', resource: 'event' });
  });

  it('pages contests with races and filters them by office', async () => {
    const res = await get(`/contests?occurrenceKey=${q(OCCURRENCE)}`);
    expect(res.status, res.raw).toBe(200);
    expect((res.body.data as { contestKey: string }[]).map((item) => item.contestKey)).toEqual([
      COUNCIL,
      MAYOR,
    ]);
    const filtered = await get(`/contests?occurrenceKey=${q(OCCURRENCE)}&offices=mayor`);
    expect(filtered.body.data).toEqual([
      expect.objectContaining({
        contestKey: MAYOR,
        race: expect.objectContaining({
          marginVotes: '250',
          leader: expect.objectContaining({ share: expect.objectContaining({ percent: '63.16' }) }),
        }) as unknown,
      }),
    ]);
    const tool = await structured('list_election_contests', {
      occurrenceKey: OCCURRENCE,
      filter: { offices: { in: ['mayor'] } },
    });
    expect(tool['items']).toEqual(filtered.body.data);
    const unknown = await get('/contests?occurrenceKey=ro:local:2016:2016-06-05');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'NotFound', resource: 'occurrence' });
  });

  it('serves a result and its breakdown, the same as MCP', async () => {
    const result = await get(
      `/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=county_council&scopeKey=county:AB&contestKey=${q(COUNCIL)}`
    );
    expect(result.status, result.raw).toBe(200);
    expect(result.body.data).toMatchObject({
      contest: { contestKey: COUNCIL },
      place: { placeKey: 'county:AB', placeType: 'county' },
      participation: { percent: '50.00' },
    });
    expect(
      (
        await structured('get_election_result', {
          occurrenceKey: OCCURRENCE,
          office: 'county_council',
          scopeKey: 'county:AB',
          contestKey: COUNCIL,
        })
      )['item']
    ).toEqual(result.body.data);
    const scopes = await get(
      `/results?occurrenceKey=${q(OCCURRENCE)}&office=county_council&scopeType=uat&contestKey=${q(COUNCIL)}`
    );
    expect(scopes.status, scopes.raw).toBe(200);
    expect(
      (scopes.body.data as { place: { placeKey: string } }[]).map((item) => item.place.placeKey)
    ).toEqual(['uat:1017', 'uat:1026']);
    expect(scopes.body.meta).toMatchObject({ totalCounts: 'places' });
    const aggregate = await get(
      `/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=mayor&scopeKey=county:AB`
    );
    expect(aggregate.body.data).toMatchObject({ contest: null, race: null });
    expect(
      (await get(`/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=mayor&scopeKey=uat:9`))
        .status
    ).toBe(404);
  });

  it('lists competitors filtered by kind', async () => {
    const res = await get(`/competitors?eventKey=${q(EVENT)}&kinds=party&pageSize=1`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.meta).toMatchObject({
      page: { page: 1, pageSize: 1, total: 2 },
      hasMore: true,
    });
    expect((await get(`/competitors?eventKey=${q(EVENT)}&kinds=bogus`)).status).toBe(400);
  });
});

describe('elections REST input handling', () => {
  it.each([
    ['/events?page=0', 'page'],
    ['/events?pageSize=101', 'pageSize'],
    ['/events?page=1&page=2', 'page'],
    ['/contests', 'occurrenceKey'],
    [`/contests?occurrenceKey=${q(OCCURRENCE)}&statuses=finished`, undefined],
    [`/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=mayor`, 'scopeKey'],
    [`/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=mayor&scopeKey=uat:01`, 'scopeKey'],
    [`/results/lookup?occurrenceKey=${q(OCCURRENCE)}&office=Mayor&scopeKey=national`, 'office'],
    [`/results?occurrenceKey=${q(OCCURRENCE)}&office=mayor&scopeType=sector`, 'scopeType'],
    ['/competitors', 'eventKey'],
  ])('refuses %s before any read', async (url, field) => {
    const repo = makeFakeElectionsRepo();
    const res = await get(url, await restApp(repo));
    expect(res.status, res.raw).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'InvalidInput' });
    if (field !== undefined) expect(res.body.field).toBe(field);
    expect(repo.calls).toEqual([]);
  });

  it('refuses an unknown parameter without echoing it', async () => {
    const res = await get('/events?secret=pool-password');
    expect(res.status).toBe(400);
    expect(res.raw).not.toContain('pool-password');
  });

  it('answers a disabled repository with 503 and a fixed message', async () => {
    const disabled: ElectionsRepository = {
      ...makeFakeElectionsRepo(),
      listEvents: () => Promise.resolve(err(serviceUnavailable('Elections are not enabled.'))),
    };
    const res = await get('/events', await restApp(disabled));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'ServiceUnavailable',
      message: 'elections read failed; quote the requestId to report it',
    });
  });

  it('maps a database error and a thrown fault to the fixed 500 without their text', async () => {
    for (const repo of [
      {
        ...makeFakeElectionsRepo(),
        listEvents: () => Promise.resolve(err(databaseError('pool secret exploded'))),
      },
      {
        ...makeFakeElectionsRepo(),
        listEvents: () => Promise.reject(new Error('pool secret exploded')),
      },
    ] satisfies ElectionsRepository[]) {
      const res = await get('/events', await restApp(repo));
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        ok: false,
        message: 'elections read failed; quote the requestId to report it',
      });
      expect(res.raw).not.toContain('secret');
      expect(res.headers['cache-control']).toBe('no-store');
    }
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
    expect((await get('/events', limited)).status).toBe(200);
    const second = await get('/events', limited);
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.body).toEqual({
      ok: false,
      error: 'RateLimited',
      message: 'rate limit exceeded; retry later',
      requestId: expect.any(String) as unknown,
    });
    expect(repo.calls).toEqual(['listEvents']);
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
    const res = await get('/events', await boot(['elections']));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'ServiceUnavailable' });
  }, 60_000);

  it('validates on the enabled mount, and is absent without the module', async () => {
    const enabled = await get('/events?page=0', await boot(['elections'], true));
    expect(enabled.status).toBe(400);
    expect(enabled.body).toMatchObject({ ok: false, error: 'InvalidInput', field: 'page' });
    const without = await boot(['ngos']);
    const res = await without.inject({ method: 'GET', url: '/api/v1/elections/events' });
    expect(res.statusCode).toBe(404);
  }, 60_000);
});
