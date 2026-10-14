/**
 * The county source report over the REAL REST plugin and the REAL GraphQL
 * slice, both over one in-memory repository: the same report and competitor
 * page for the same inputs, one 404 (REST) and null (GraphQL) for an absent,
 * restricted or unreported contest, query decoding before any read, fixed 5xx
 * messages, an inherited 429, no-store on every reply, and no MCP tool.
 */
import rateLimit from '@fastify/rate-limit';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { err } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeElectionsModule, type ElectionsRepository } from '@/modules/elections/index.js';
import {
  electionsTypeDefs,
  makeElectionsResolvers,
} from '@/modules/elections/shell/graphql/schema.js';
import { makeElectionsRestPlugin } from '@/modules/elections/shell/rest/routes.js';
import {
  baseTypeDefs,
  databaseError,
  GRAPHQL_ERROR_CODE,
  mergeGraphqlSlices,
  scalarResolvers,
} from '@/modules/shared/index.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';
import {
  completeCompetitors,
  completeStatement,
  competitor,
  countyContest,
  makeFakeElectionsRepo,
  RESTRICTED_SENTINEL,
  type CountySourceFixture,
} from '../../fixtures/elections/catalog.js';

const ALBA = 'contest:aep-local-2020:mayor:county:1';
const BUCURESTI = 'contest:aep-local-2020:mayor:county:42';
const RESTRICTED = `contest:aep-local-2020:mayor:county:${RESTRICTED_SENTINEL}`;
const PATH = '/api/v1/elections/county-source-reports/lookup';

const REPORT = `contestKey electionKey reportedOffice scopeType sourceScopeKey scopeLabel notice scopeNote
  source { title url reportedElectionDate sourceFileVerifiedOn valuesComparedOn }
  statement { sourceCode sourceLabel value }
  competitors { items { sourceLabel voturi mandate } page pageSize total hasMore }`;

const apps: FastifyInstance[] = [];
let restApp: FastifyInstance;
let graphApp: FastifyInstance;

const restFor = async (repo: ElectionsRepository) => {
  const app = fastifyLib({ logger: false });
  await app.register(makeElectionsRestPlugin({ repo }), { prefix: '/api/v1/elections' });
  await app.ready();
  apps.push(app);
  return app;
};

const graphFor = async (repo: ElectionsRepository) => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'elections', typeDefs: electionsTypeDefs },
  ]);
  const app = fastifyLib({ logger: false });
  apps.push(app);
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeElectionsResolvers({ repo }) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  return app;
};

beforeAll(async () => {
  const repo = makeFakeElectionsRepo();
  restApp = await restFor(repo);
  graphApp = await graphFor(repo);
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

interface Envelope {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: string;
  readonly message?: string;
  readonly field?: string;
  readonly resource?: string;
  readonly requestId?: string;
}

const get = async (query: string, app: FastifyInstance = restApp) => {
  const res = await app.inject({ method: 'GET', url: `${PATH}${query}` });
  return {
    status: res.statusCode,
    headers: res.headers,
    raw: res.body,
    body: res.json<Envelope>(),
  };
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { message: string; extensions?: Record<string, unknown> }[];
}

const gql = async (variables: Record<string, unknown>, app: FastifyInstance = graphApp) => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      query: `query($key: ID!, $page: Int, $pageSize: Int) {
        electionCountySourceReport(contestKey: $key, page: $page, pageSize: $pageSize) { ${REPORT} }
      }`,
      variables,
    }),
  });
  return { raw: res.body, body: res.json<GqlResponse>() };
};

const keyQuery = (key: string, extra = '') => `?contestKey=${encodeURIComponent(key)}${extra}`;

describe('county source report: REST and GraphQL parity', () => {
  it.each([
    [ALBA, 1, 20],
    [ALBA, 2, 2],
    [BUCURESTI, 1, 20],
  ])('serves the same report for %s, page %d of %d', async (key, page, pageSize) => {
    const rest = await get(keyQuery(key, `&page=${String(page)}&pageSize=${String(pageSize)}`));
    expect(rest.status).toBe(200);
    expect(rest.headers['cache-control']).toBe('no-store');
    const graph = await gql({ key, page, pageSize });
    expect(graph.body.errors).toBeUndefined();
    expect(rest.body.data).toEqual(graph.body.data?.['electionCountySourceReport']);
  });

  it('serves every cell, keeping zero and integers above 2^53 as exact strings on both surfaces', async () => {
    const rest = await get(keyQuery(ALBA, '&pageSize=100'));
    const data = rest.body.data as {
      statement: { sourceCode: string; value: unknown }[];
      competitors: { items: { voturi: unknown; mandate: unknown }[]; total: number };
    };
    expect(data.statement).toHaveLength(12);
    expect(data.statement.find((cell) => cell.sourceCode === 'a')?.value).toBe('9007199254740993');
    expect(data.statement.find((cell) => cell.sourceCode === 'a1')?.value).toBe('0');
    expect(data.statement.every((cell) => typeof cell.value === 'string')).toBe(true);
    expect(data.competitors.total).toBe(234);
    expect(
      data.competitors.items.every(
        (item) => typeof item.voturi === 'string' && typeof item.mandate === 'string'
      )
    ).toBe(true);
    expect(rest.raw).toContain('"9007199254740993"');
    expect((await gql({ key: ALBA })).raw).toContain('"9007199254740993"');
  });

  it('holds an incomplete source whole and refuses a duplicated label, alike on both surfaces', async () => {
    const albaWith = (overrides: Partial<Pick<CountySourceFixture, 'statement' | 'competitors'>>) =>
      makeFakeElectionsRepo({
        reports: [
          {
            contest: countyContest('1', 'ALBA'),
            statement: completeStatement(),
            competitors: completeCompetitors([]),
            ...overrides,
          },
        ],
      });
    const held = albaWith({ competitors: completeCompetitors([]).slice(1) });
    const absent = await get(keyQuery('contest:absent'));
    const heldRest = await get(keyQuery(ALBA), await restFor(held));
    expect(heldRest.status).toBe(404);
    expect({ ...heldRest.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
    const heldGraph = await gql({ key: ALBA }, await graphFor(held));
    expect(heldGraph.body.errors).toBeUndefined();
    expect(heldGraph.body.data).toEqual({ electionCountySourceReport: null });
    // The duplicate sorts last: page 1 alone looks clean.
    const duplicated = albaWith({
      competitors: [...completeCompetitors([]), competitor('SINTETIC 234', '0', null)],
    });
    const failedRest = await get(keyQuery(ALBA, '&pageSize=2'), await restFor(duplicated));
    expect(failedRest.status).toBe(500);
    expect(failedRest.body).toMatchObject({
      ok: false,
      error: 'Database',
      message: 'elections read failed; quote the requestId to report it',
    });
    const failedGraph = await gql({ key: ALBA, pageSize: 2 }, await graphFor(duplicated));
    expect(failedGraph.body.data?.['electionCountySourceReport'] ?? null).toBeNull();
    expect(failedGraph.body.errors?.[0]?.extensions?.['code']).toBe(GRAPHQL_ERROR_CODE.Database);
  });

  it('answers an absent, restricted or unreported contest with one 404 and a GraphQL null', async () => {
    const absent = await get(keyQuery('contest:absent'));
    expect(absent.status).toBe(404);
    expect(absent.body).toMatchObject({ ok: false, error: 'NotFound', resource: 'report' });
    for (const key of [RESTRICTED, 'contest:bec-local-2024:mayor:siruta:179132']) {
      const hidden = await get(keyQuery(key));
      expect(hidden.status).toBe(404);
      expect({ ...hidden.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
      expect(hidden.raw).not.toContain(RESTRICTED_SENTINEL);
      expect(hidden.headers['cache-control']).toBe('no-store');
      const graph = await gql({ key });
      expect(graph.body.errors).toBeUndefined();
      expect(graph.body.data).toEqual({ electionCountySourceReport: null });
      expect(graph.raw).not.toContain(RESTRICTED_SENTINEL);
    }
  });
});

describe('county source report: decoding before any read', () => {
  it.each([
    ['a missing contest key', '', 'contestKey'],
    ['an empty contest key', '?contestKey=', 'contestKey'],
    ['a repeated contest key', '?contestKey=a&contestKey=b', 'contestKey'],
    ['an unknown parameter', `${keyQuery(ALBA)}&electionKey=aep-local-2020`, 'query'],
    ['page 0', `${keyQuery(ALBA)}&page=0`, 'page'],
    ['a fractional pageSize', `${keyQuery(ALBA)}&pageSize=1.5`, 'pageSize'],
    ['pageSize over the kernel maximum', `${keyQuery(ALBA)}&pageSize=101`, 'pageSize'],
    ['an over-long key', keyQuery('k'.repeat(513)), 'contestKey'],
  ])('rejects %s with 400', async (_label, query, field) => {
    const repo = makeFakeElectionsRepo();
    const res = await get(query, await restFor(repo));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'InvalidInput', field });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(repo.calls).toEqual([]);
  });

  it('rejects an out-of-range GraphQL page with a typed error', async () => {
    const graph = await gql({ key: ALBA, pageSize: 101 });
    expect(graph.body.data?.['electionCountySourceReport'] ?? null).toBeNull();
    expect(graph.body.errors?.[0]?.extensions?.['code']).toBe(GRAPHQL_ERROR_CODE.InvalidInput);
  });
});

describe('county source report: failures, limits and mount', () => {
  it('maps a read failure to the fixed 500 without its cause', async () => {
    const failing: ElectionsRepository = {
      ...makeFakeElectionsRepo(),
      countySourceReport: () =>
        Promise.resolve(err(databaseError('Elections read failed', new Error('relation secret')))),
    };
    const res = await get(keyQuery(ALBA), await restFor(failing));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      error: 'Database',
      message: 'elections read failed; quote the requestId to report it',
    });
    expect(res.raw).not.toContain('secret');
  });

  it('keeps an inherited rate-limit refusal a 429 with Retry-After', async () => {
    const repo = makeFakeElectionsRepo();
    const limited = fastifyLib({ logger: false });
    apps.push(limited);
    await limited.register(rateLimit, { max: 1, timeWindow: 60_000 });
    await limited.register(makeElectionsRestPlugin({ repo }), { prefix: '/api/v1/elections' });
    await limited.ready();
    expect((await get(keyQuery(ALBA), limited)).status).toBe(200);
    const second = await get(keyQuery(ALBA), limited);
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.body).toMatchObject({ ok: false, error: 'RateLimited' });
    expect(repo.calls).toEqual(['countySourceReport']);
  });

  it('registers no MCP tool for the report', () => {
    const module = makeElectionsModule({ db: makeCapturingDb([]), enabled: true });
    expect(module.mcpTools.map((tool) => tool.name).join(' ')).not.toMatch(/report|source/iu);
  });

  it('refuses while disabled and validates when enabled on the real composition', async () => {
    const boot = async (electionsEnabled: boolean) => {
      const built = await buildRedesignApp({
        logLevel: 'silent',
        modules: ['elections'],
        electionsEnabled,
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
    const disabled = await get(keyQuery(ALBA), await boot(false));
    expect(disabled.status).toBe(503);
    expect(disabled.body).toMatchObject({ ok: false, error: 'ServiceUnavailable' });
    const enabled = await get(`${keyQuery(ALBA)}&page=0`, await boot(true));
    expect(enabled.status).toBe(400);
    expect(enabled.body).toMatchObject({ ok: false, error: 'InvalidInput', field: 'page' });
  }, 60_000);
});
