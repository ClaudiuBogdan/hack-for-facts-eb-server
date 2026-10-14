/**
 * The staged v4 MAIN_ACTIVITY capability on the REAL GraphQL slice
 * (Mercurius, inject) and the MCP tool: a v3 release (which DOES offer
 * ACTIVITY) refuses the MAIN_ACTIVITY dimension and the main filters with
 * the typed RELEASE_CAPABILITY_UNAVAILABLE naming MAIN_ACTIVITY, the release
 * advertises no MAIN_ACTIVITY and no main pin, and ACTIVITY still answers.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeCompanyAnalysisResolvers } from '@/modules/companies/shell/graphql/analytics-resolvers.js';
import { companyAnalysisTypeDefs } from '@/modules/companies/shell/graphql/analytics-typedefs.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompanyAnalysisMcpTools } from '@/modules/companies/shell/mcp/analytics-tools.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import {
  ACTIVITY_DATASET,
  analyticsDeps,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  v3ReleaseRow,
} from '../../unit/companies/analytics/analytics-fixtures.js';

import type { CompanyAnalysisContext } from '@/modules/companies/core/analytics-usecases.js';

const context = (): CompanyAnalysisContext =>
  analyticsDeps(
    makeInMemoryEngine(ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements, [9]),
    fakeReleases(v3ReleaseRow(9, ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements)),
    fakeLabels({}, {})
  );

let app: FastifyInstance;
beforeAll(async () => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'companies', typeDefs: `${companiesTypeDefs}\n\n${companyAnalysisTypeDefs}` },
  ]);
  app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeCompanyAnalysisResolvers(context()) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (query: string): Promise<GqlResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  return res.json<GqlResponse>();
};

const refusal = (field: string) => ({
  code: 'RELEASE_CAPABILITY_UNAVAILABLE',
  type: 'ReleaseCapabilityUnavailable',
  field,
  capability: 'MAIN_ACTIVITY',
  releaseId: '9',
  schemaVersion: 'companies-analytics-ch-v3',
});

describe('MAIN_ACTIVITY on a v3 release', () => {
  it('the release advertises ACTIVITY but neither MAIN_ACTIVITY nor a main pin', async () => {
    const body = await gql(
      `query { companyAnalysisRelease { schemaVersion dimensions { dimension } mainCaen { contentEpoch } } }`
    );
    expect(body.errors).toBeUndefined();
    const release = body.data?.['companyAnalysisRelease'] as {
      dimensions: { dimension: string }[];
      mainCaen: unknown;
    };
    const dimensions = release.dimensions.map((d) => d.dimension);
    expect(dimensions).toContain('ACTIVITY');
    expect(dimensions).not.toContain('MAIN_ACTIVITY');
    expect(release.mainCaen).toBeNull();
  });

  it('refuses the dimension and both filters by name on GraphQL', async () => {
    const breakdown = await gql(
      `query { companyAnalysisBreakdown(dimension: MAIN_ACTIVITY) { groupCount } }`
    );
    expect(breakdown.data?.['companyAnalysisBreakdown']).toBeNull();
    expect(breakdown.errors?.[0]?.extensions).toEqual(refusal('dimension'));

    const keyed = await gql(
      `query { companyAnalysisStats(scope: { mainActivity: [{ revision: "rev3", code: "4711" }] }) { companies } }`
    );
    expect(keyed.errors?.[0]?.extensions).toEqual(refusal('scope.mainActivity'));

    const status = await gql(
      `query { companyAnalysisRecords(scope: { mainActivityStatus: [NO_ONRC_MATCH] }) { totalCount } }`
    );
    expect(status.errors?.[0]?.extensions).toEqual(refusal('scope.mainActivityStatus'));
  });

  it('ACTIVITY still answers on the same release (no regression)', async () => {
    const body = await gql(
      `query { companyAnalysisBreakdown(dimension: ACTIVITY) { groupCount groups { key mainActivity { status } } } }`
    );
    expect(body.errors).toBeUndefined();
    const groups = (
      body.data?.['companyAnalysisBreakdown'] as {
        groups: { key: string; mainActivity: unknown }[];
      }
    ).groups;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.mainActivity === null)).toBe(true);
  });

  it('the MCP tool answers the same typed refusal', async () => {
    const tool = makeCompanyAnalysisMcpTools({
      analytics: context(),
      clientBaseUrl: 'https://transparenta.eu',
    }).find((t) => t.name === 'aggregate_companies')!;
    const out = await tool.handler({ shape: 'breakdown', dimension: 'MAIN_ACTIVITY' });
    expect(out).toMatchObject({
      ok: false,
      errorCode: 'RELEASE_CAPABILITY_UNAVAILABLE',
      meta: { field: 'dimension', capability: 'MAIN_ACTIVITY', releaseId: '9' },
    });
  });
});
