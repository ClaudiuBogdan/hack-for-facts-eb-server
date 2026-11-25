/**
 * The log reason of a refusal, through the REAL call sites (25 Nov): the contract-award and DA
 * release resolvers, switched off, log `reason: 'not_enabled'` on the GraphQL error line in both
 * formatter modes, while no response (GraphQL, REST, MCP) carries the reason.
 */

import { Writable } from 'node:stream';

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  caRecordsTypeDefs,
  makeCaRecordsResolvers,
} from '@/modules/procurement/shell/graphql/ca-records-schema.js';
import {
  daReleaseTypeDefs,
  makeDaReleaseResolvers,
} from '@/modules/procurement/shell/graphql/da-release-schema.js';
import { makeCaRecordsMcpTools } from '@/modules/procurement/shell/mcp/ca-records-tools.js';
import { makeCaRecordsRepo } from '@/modules/procurement/shell/repo/ca-records-repo.js';
import { makeDaReleaseRepo } from '@/modules/procurement/shell/repo/da-release-repo.js';
import { makeCaRecordsRestPlugin } from '@/modules/procurement/shell/rest/ca-records-routes.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const collector = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: string | Uint8Array, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .split('\n')
          .filter((line) => line.trim() !== '')
      );
      callback();
    },
  });
  return { lines, stream };
};

/** Both repos switched off: every read refuses before any statement (none is captured). */
const off = () => {
  const captured: CapturedQuery[] = [];
  const db = makeCapturingDb(captured);
  return {
    captured,
    ca: { repo: makeCaRecordsRepo(db, false) },
    da: { repo: makeDaReleaseRepo(db, false) },
  };
};

const graphqlApp = async (isProduction: boolean, stream: Writable) => {
  const deps = off();
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'procurement-ca', typeDefs: caRecordsTypeDefs },
    { source: 'procurement-da', typeDefs: daReleaseTypeDefs },
  ]);
  const ca = makeCaRecordsResolvers(deps.ca);
  const da = makeDaReleaseResolvers(deps.da);
  const app = fastifyLib({ logger: { level: 'info', stream }, disableRequestLogging: true });
  apps.push(app);
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [
        { ...scalarResolvers, ...ca, ...da, Query: { ...ca.Query, ...da.Query } },
      ] as never,
      isProduction,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  return { app, captured: deps.captured };
};

const QUERIES = [
  '{ procurementContractAwardSummary(buyerFiscalCode: "14399840") { recordCount } }',
  '{ procurementDaPurchases(pageSize: 1) { total } }',
];

describe('a refusal logs its reason, through the real resolvers', () => {
  for (const isProduction of [false, true])
    it(`logs not_enabled and never answers it (production ${String(isProduction)})`, async () => {
      const logs = collector();
      const { app, captured } = await graphqlApp(isProduction, logs.stream);
      for (const query of QUERIES) {
        logs.lines.length = 0;
        const res = await app.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ query }),
        });
        const body = res.json<{ errors: { extensions: Record<string, unknown> }[] }>();
        expect(body.errors[0]?.extensions['code'], query).toBe('SERVICE_UNAVAILABLE');
        expect(res.body, query).not.toContain('not_enabled');
        expect(res.body, query).not.toContain('reason');
        const logged = logs.lines.filter((line) => line.includes('"msg":"GraphQL error"'));
        expect(logged, query).toHaveLength(1);
        expect(logged[0], query).toContain('"reason":"not_enabled"');
      }
      expect(captured).toEqual([]);
    });
});

describe('REST and MCP envelopes carry no reason', () => {
  it('answers the same envelope keys as before', async () => {
    const deps = off();
    const app = fastifyLib({ logger: false });
    apps.push(app);
    await app.register(makeCaRecordsRestPlugin(deps.ca), {
      prefix: '/api/v1/procurement/contract-awards',
    });
    await app.ready();
    const res = await app.inject({
      url: '/api/v1/procurement/contract-awards/buyer-summary?buyerFiscalCode=14399840',
    });
    expect(res.statusCode).toBe(503);
    expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
      'error',
      'message',
      'ok',
      'requestId',
    ]);
    const tool = makeCaRecordsMcpTools(deps.ca).find(
      (t) => t.name === 'get_procurement_contract_award_summary'
    );
    const output = await tool?.handler({ buyerFiscalCode: '14399840' });
    expect(output).toEqual({
      ok: false,
      kind: 'procurement_contract_award_summary',
      error: 'Contract awards are not enabled on this server.',
      errorType: 'ServiceUnavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
    });
  });
});
