/**
 * A busy refusal (the per-pod ClickHouse cap, or ClickHouse's own
 * TOO_MANY_SIMULTANEOUS_QUERIES) on every public surface: GraphQL answers
 * SERVICE_UNAVAILABLE with `extensions.retryAfterSeconds` and its static message
 * survives production redaction; MCP answers `errorType: ServiceUnavailable`
 * with `retryAfterSeconds`; REST answers 503 with `Retry-After`. The
 * ClickHouse-backed analysis reads use the real repository over a stubbed
 * ClickHouse HTTP answer, so the 202 → busy mapping is exercised end to end.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  makeDaTotalsCache,
  type DaReleaseDeps,
} from '@/modules/procurement/core/da-release-usecases.js';
import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { procurementTypeDefs } from '@/modules/procurement/shell/graphql/typedefs.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';
import {
  CLICKHOUSE_RETRY_AFTER_SECONDS,
  makeClickhouseAnalysisRepo,
} from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';
import { makeDaReleaseRestPlugin } from '@/modules/procurement/shell/rest/da-release-routes.js';
import { busyRetryLater, createMcpHttpDispatcher } from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import { makeFakeDaRepo } from '../../fixtures/procurement/da-release.js';
import { generationWithoutFrameworkRole as GEN } from '../../unit/procurement/clickhouse-response.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';

const KERNEL_STUB_SDL = /* GraphQL */ `
  scalar Date
  scalar SIRUTA
  type Query {
    _empty: String
  }
`;

const RAW_202 =
  'Code: 202. DB::Exception: Too many simultaneous queries for user api_reader. Maximum: 6. (TOO_MANY_SIMULTANEOUS_QUERIES) (version 25.3.1.1)';
const BUSY_MESSAGE = 'procurement analytics is busy; retry shortly';

/** The real ClickHouse repository, with every ClickHouse request refused with code 202. */
const refusedAnalysis = (): AnalysisRepo => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(RAW_202, { status: 500, headers: { 'x-clickhouse-exception-code': '202' } })
      )
    )
  );
  const repo = makeClickhouseAnalysisRepo(
    { url: 'http://clickhouse.test', database: 'proto' },
    () => Promise.resolve(ok(null))
  );
  // The generation ledger is Postgres in production; pin it here.
  return { ...repo, activeGeneration: () => Promise.resolve(ok(GEN)) };
};

const unusedRepo = {} as unknown as ProcurementRepo;
let app: FastifyInstance | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
});

describe('a busy ClickHouse read on every surface', () => {
  it('GraphQL: SERVICE_UNAVAILABLE with retryAfterSeconds, unredacted in production', async () => {
    const analysis = refusedAnalysis();
    app = fastifyLib({ logger: false });
    await app.register(
      makeGraphQLPlugin({
        schema: [KERNEL_STUB_SDL, procurementTypeDefs],
        resolvers: [
          makeProcurementResolvers({ repo: unusedRepo, analysis }) as unknown as Record<
            string,
            never
          >,
        ],
        isProduction: true,
        enableGraphiQL: false,
      })
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '{ procurementStats { blocks { recordCount } } }' }),
    });
    const body = res.json<{
      errors?: { message: string; extensions?: Record<string, unknown> }[];
    }>();
    expect(body.errors?.[0]).toMatchObject({
      message: BUSY_MESSAGE,
      extensions: {
        code: 'SERVICE_UNAVAILABLE',
        type: 'ServiceUnavailable',
        retryAfterSeconds: CLICKHOUSE_RETRY_AFTER_SECONDS,
      },
    });
    expect(res.body).not.toMatch(/api_reader|version|INTERNAL_SERVER_ERROR/u);
  });

  it('MCP: errorType ServiceUnavailable with retryAfterSeconds and no ClickHouse text', async () => {
    const tool = makeProcurementMcpTools({
      repo: unusedRepo,
      analysis: refusedAnalysis(),
      clientBaseUrl: 'https://transparenta.eu',
    }).find((candidate) => candidate.name === 'aggregate_procurement');
    if (tool === undefined) throw new Error('aggregate_procurement is not registered');
    const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer([tool]));
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aggregate_procurement', arguments: { shape: 'stats' } },
    });
    const wire = JSON.stringify(response);
    expect(wire).toContain('"errorType":"ServiceUnavailable"');
    expect(wire).toContain('"errorCode":"SERVICE_UNAVAILABLE"');
    expect(wire).toContain(`"retryAfterSeconds":${String(CLICKHOUSE_RETRY_AFTER_SECONDS)}`);
    expect(wire).toContain(BUSY_MESSAGE);
    expect(wire).not.toMatch(/api_reader|version 25/u);
    await dispatcher.close();
  });

  // No REST route reads ClickHouse today (the DA REST routes read procurement_v3
  // in Postgres); this pins the REST mapping of any busy refusal.
  it('REST: a busy refusal answers 503 with Retry-After', async () => {
    const busy = busyRetryLater(BUSY_MESSAGE, CLICKHOUSE_RETRY_AFTER_SECONDS);
    const deps: DaReleaseDeps = {
      repo: { ...makeFakeDaRepo(), snapshot: () => Promise.resolve(err(busy)) },
      totalsCache: makeDaTotalsCache(),
    };
    app = fastifyLib({ logger: false });
    await app.register(makeDaReleaseRestPlugin(deps), { prefix: '/api/v1/procurement/da' });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/v1/procurement/da/purchases' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(CLICKHOUSE_RETRY_AFTER_SECONDS));
    expect(res.json()).toMatchObject({
      ok: false,
      error: 'ServiceUnavailable',
      message: BUSY_MESSAGE,
    });
  });
});
