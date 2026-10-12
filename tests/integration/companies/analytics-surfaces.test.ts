/**
 * Companies analytics over the REAL GraphQL slice (Mercurius, inject) and the
 * REAL MCP dispatcher, both over the same in-memory engine: identical answers
 * on both surfaces, typed errors on both, and the merged slice builds next to
 * the kernel and the existing companies SDL.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeCompanyAnalysisResolvers } from '@/modules/companies/shell/graphql/analytics-resolvers.js';
import { companyAnalysisTypeDefs } from '@/modules/companies/shell/graphql/analytics-typedefs.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompanyAnalysisMcpTools } from '@/modules/companies/shell/mcp/analytics-tools.js';
import {
  baseTypeDefs,
  createMcpHttpDispatcher,
  mergeGraphqlSlices,
  scalarResolvers,
  type KernelMcpTool,
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import {
  ACTIVITY_DATASET,
  DATASET,
  analyticsDeps,
  fakeLabels,
  fakePrivacy,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
  v3ReleaseRow,
} from '../../unit/companies/analytics/analytics-fixtures.js';

import type { CompanyAnalysisContext } from '@/modules/companies/core/analytics-usecases.js';

const ACTIVE = releaseRow(7, DATASET.companies, DATASET.statements);

const context = (): CompanyAnalysisContext =>
  analyticsDeps(
    makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]),
    fakeReleases(ACTIVE),
    fakeLabels({ '100': 'ALFA SRL' })
  );

const buildGraphql = async (analytics: CompanyAnalysisContext): Promise<FastifyInstance> => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'companies', typeDefs: `${companiesTypeDefs}\n\n${companyAnalysisTypeDefs}` },
  ]);
  const app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeCompanyAnalysisResolvers(analytics) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  return app;
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (
  app: FastifyInstance,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GqlResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json<GqlResponse>();
};

const callTool = async (
  tools: readonly KernelMcpTool[],
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer(tools));
  const response = (await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { structuredContent?: Record<string, unknown> } };
  await dispatcher.close();
  const content = response.result?.structuredContent;
  if (content === undefined) throw new Error(`no structured content: ${JSON.stringify(response)}`);
  return content;
};

const AGGREGATE = /* GraphQL */ `
  fragment Agg on CompanyAnalysisMetricAggregate {
    metric
    unit
    kind
    sum
    contributors
    mean
    coverage {
      reported
      missing
      notAdmitted
      heldProfile
      heldObservation
      heldQuality
      heldComponent
    }
  }
`;
const BUCKET = /* GraphQL */ `
  fragment Bucket on CompanyAnalysisBucket {
    kind
    key
    label
    labelSource
    basis
    caen {
      code
      revision
      basis
      label
      descriptionStatus
      descriptions {
        revision
        label
      }
    }
    groups
    companies
    filers
    metric {
      ...Agg
    }
    activity {
      basis
      source
      code
      revision
      label
      descriptionStatus
      descriptions {
        revision
        label
      }
      derived
    }
    activityQuality {
      numericMatchSelected
      incompleteCoverage
      withUnqualifiedRows
      anafObservedFrom
      anafObservedTo
    }
  }
`;

/** The whole release ref (MCP returns the whole object, so parity selects all of it). */
const RELEASE = `release {
  releaseId publishedAt active
  source {
    editionId publicationEpoch sourceSnapshotId sourcePublishedAt interpretationVersion
    privacyPolicyVersion dimensionPolicyVersion eligibilityPolicyVersion
  }
}`;

let app: FastifyInstance;
let tools: readonly KernelMcpTool[];

beforeAll(async () => {
  const analytics = context();
  app = await buildGraphql(analytics);
  tools = makeCompanyAnalysisMcpTools({ analytics, clientBaseUrl: 'https://transparenta.eu' });
});

afterAll(async () => {
  await app.close();
});

describe('companies analytics GraphQL and MCP surfaces', () => {
  it('serves stats identically on both surfaces, with exact strings', async () => {
    const scope = {
      cuis: ['100', '200', '300'],
      county: { in: ['CJ', 'B'], includeUnknown: true },
    };
    const body = await gql(
      app,
      `${AGGREGATE}
      query ($scope: CompanyAnalysisScopeInput) {
        companyAnalysisStats(release: "7", scope: $scope, metrics: [TURNOVER, EMPLOYEES]) {
          ${RELEASE}
          scope scopeHash fiscalYear companies filers nonFilers caveats
          metrics { ...Agg }
        }
      }`,
      { scope }
    );
    expect(body.errors).toBeUndefined();
    const graphql = body.data?.['companyAnalysisStats'];
    const mcp = await callTool(tools, 'aggregate_companies', {
      shape: 'stats',
      release: '7',
      scope,
      metrics: ['TURNOVER', 'EMPLOYEES'],
    });
    expect(mcp['ok']).toBe(true);
    expect(mcp['item']).toEqual(graphql);
    expect(graphql).toMatchObject({ companies: '3', filers: '3' });
  });

  it('serves the breakdown identically, with other and unknown buckets', async () => {
    const body = await gql(
      app,
      `${AGGREGATE}${BUCKET}
      query {
        companyAnalysisBreakdown(dimension: MAIN_CAEN, topN: 1) {
          ${RELEASE}
          scope scopeHash fiscalYear dimension metric groupCount rankBy rankedBy topN caveats
          groups { ...Bucket }
          other { ...Bucket }
          unknown { ...Bucket }
          unclassified { ...Bucket }
          totals { ...Bucket }
        }
      }`
    );
    expect(body.errors).toBeUndefined();
    const mcp = await callTool(tools, 'aggregate_companies', {
      shape: 'breakdown',
      dimension: 'MAIN_CAEN',
      topN: 1,
    });
    expect(mcp['item']).toEqual(body.data?.['companyAnalysisBreakdown']);
  });

  it('serves the series identically, gaps included', async () => {
    const body = await gql(
      app,
      `${AGGREGATE}
      query {
        companyAnalysisSeries(metric: EMPLOYEES, cohortMode: EACH_YEAR) {
          ${RELEASE}
          scope scopeHash fiscalYear metric unit kind cohortMode referenceYear cohortCompanies
          fromYear toYear caveats
          points { fiscalYear available gapReason companies filers metric { ...Agg } }
        }
      }`
    );
    expect(body.errors).toBeUndefined();
    const mcp = await callTool(tools, 'aggregate_companies', {
      shape: 'series',
      metric: 'EMPLOYEES',
      cohortMode: 'EACH_YEAR',
    });
    expect(mcp['item']).toEqual(body.data?.['companyAnalysisSeries']);
  });

  it('pages records identically and accepts each surface’s cursor on the other', async () => {
    const selection = `
      ${RELEASE}
      scope scopeHash fiscalYear sort sortMetric direction totalCount caveats
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          cui currentName legalForm legalFormBasis filed employeeSizeBand vatPayer fiscallyInactive
          county { code label labelSource } countyBasis
          uat { code label labelSource } uatBasis
          observedStatus { code label labelSource } observedStatusBasis observedStatusCoverage
          onrcCaenCoverage onrcRecordedDate onrcRecordedYear onrcRecordedDateBasis
          mainCaen { code revision basis label descriptionStatus descriptions { revision label } }
          values { metric value status }
          activity {
            basis source code revision label descriptionStatus
            descriptions { revision label } derived
          }
          onrcClassKeyCount onrcUnqualifiedRowCount anafCaenForm anafOnrcAgreement anafStatusDate
        }
      }`;
    const first = await gql(app, `query { companyAnalysisRecords(first: 2) { ${selection} } }`);
    expect(first.errors).toBeUndefined();
    const page = first.data?.['companyAnalysisRecords'] as {
      pageInfo: { endCursor: string };
    };
    const mcpFirst = await callTool(tools, 'aggregate_companies', { shape: 'records', first: 2 });
    expect(mcpFirst['item']).toEqual(page);

    const second = await gql(
      app,
      `query ($after: String) { companyAnalysisRecords(first: 2, after: $after) { ${selection} } }`,
      { after: page.pageInfo.endCursor }
    );
    const mcpSecond = await callTool(tools, 'aggregate_companies', {
      shape: 'records',
      first: 2,
      after: page.pageInfo.endCursor,
    });
    expect(mcpSecond['item']).toEqual(second.data?.['companyAnalysisRecords']);
    const cuis = (
      second.data?.['companyAnalysisRecords'] as { edges: { node: { cui: string } }[] }
    ).edges.map((e) => e.node.cui);
    expect(cuis).toEqual(['200', '500']);
  });

  it('describes the release on both surfaces', async () => {
    const body = await gql(
      app,
      `query {
        companyAnalysisRelease {
          release { releaseId active }
          fiscalYears companies companyYears nameFilter
          defaults { fiscalYear metric cohortMode rankBy topN recordSort direction pageSize }
          metrics { metric unit kind offeredYears }
          limits { maxSelectedCuis maxPageSize maxTopN }
          years { fiscalYear statements metrics { metric offered coverage { heldObservation } } }
          asOf { kind id published retrieved rows }
        }
      }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyAnalysisRelease']).toMatchObject({
      release: { releaseId: '7', active: true },
      fiscalYears: [2021, 2023, 2024],
      nameFilter: false,
      defaults: { fiscalYear: 2024, metric: 'TURNOVER' },
    });
    const mcp = await callTool(tools, 'get_company_analysis_release', {});
    expect(mcp).toMatchObject({ ok: true, meta: { releaseId: '7' } });
  });

  it('returns the same typed INVALID_INPUT on both surfaces', async () => {
    const body = await gql(app, `query { companyAnalysisStats(release: "99") { companies } }`);
    expect(body.errors?.[0]?.extensions).toMatchObject({
      code: 'INVALID_INPUT',
      type: 'InvalidInput',
      field: 'release',
    });
    const mcp = await callTool(tools, 'aggregate_companies', { shape: 'stats', release: '99' });
    expect(mcp).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
      meta: { field: 'release' },
      error: body.errors?.[0]?.message,
    });
  });

  it('answers SERVICE_UNAVAILABLE on both surfaces when not configured', async () => {
    const disabled = await buildGraphql(null);
    const body = await gql(disabled, `query { companyAnalysisRelease { companies } }`);
    await disabled.close();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const mcp = await callTool(
      makeCompanyAnalysisMcpTools({ analytics: null, clientBaseUrl: 'https://transparenta.eu' }),
      'aggregate_companies',
      { shape: 'stats' }
    );
    expect(mcp).toMatchObject({ ok: false, errorType: 'ServiceUnavailable' });
  });

  it.each([
    [
      'a privacy withdrawal (active release)',
      { epoch: '1' },
      {},
      'SERVICE_UNAVAILABLE',
      'ServiceUnavailable',
    ],
    [
      'a privacy withdrawal (pinned release)',
      { epoch: '1' },
      { release: '7' },
      'INVALID_INPUT',
      'InvalidInput',
    ],
    [
      'an unconfirmable privacy state (replica)',
      { inRecovery: true },
      {},
      'SERVICE_UNAVAILABLE',
      'ServiceUnavailable',
    ],
  ] as const)(
    'returns the same error and no figures on both surfaces after %s',
    async (_label, privacyOver, args, code, type) => {
      const privacy = fakePrivacy(privacyOver);
      const analytics = analyticsDeps(
        makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]),
        fakeReleases(ACTIVE, [], privacy),
        fakeLabels()
      );
      const guarded = await buildGraphql(analytics);
      const release = 'release' in args ? `(release: "${args.release}")` : '';
      const body = await gql(guarded, `query { companyAnalysisStats${release} { companies } }`);
      await guarded.close();
      expect(body.data?.['companyAnalysisStats']).toBeNull();
      expect(body.errors?.[0]?.extensions).toMatchObject({ code, type });
      const mcp = await callTool(
        makeCompanyAnalysisMcpTools({ analytics, clientBaseUrl: 'https://transparenta.eu' }),
        'aggregate_companies',
        { shape: 'stats', ...args }
      );
      expect(mcp).toMatchObject({
        ok: false,
        errorType: type,
        errorCode: code,
        error: body.errors?.[0]?.message,
      });
      expect(mcp).not.toHaveProperty('item');
    }
  );

  it('refuses unknown MCP scope fields at the transport (strict input)', async () => {
    const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer(tools));
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aggregate_companies', arguments: { shape: 'stats', scope: { q: 'x' } } },
    });
    await dispatcher.close();
    expect(JSON.stringify(response)).not.toContain('"ok":true');
  });
});

describe('revision-safe CAEN GraphQL presentation', () => {
  it('keeps an exact revision separate from an unknown-revision conflict on the actual GraphQL transport', async () => {
    const analytics = analyticsDeps(
      makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]),
      fakeReleases(ACTIVE),
      fakeLabels({}, { 'rev2:6201': 'Denumirea Rev.2', 'rev3:6201': 'Denumirea Rev.3' })
    );
    const app = await buildGraphql(analytics);
    try {
      const response = await gql(
        app,
        `query { companyAnalysisBreakdown(dimension: MAIN_CAEN) { groups { key caen { code revision basis label descriptionStatus descriptions { revision label } } } } }`
      );
      expect(response.errors).toBeUndefined();
      const breakdown = response.data?.['companyAnalysisBreakdown'] as {
        groups: { key: string; caen: unknown }[];
      };
      expect(breakdown.groups.find((group) => group.key === 'rev2:6201')?.caen).toEqual({
        code: '6201',
        revision: 'rev2',
        basis: 'REVISION_KNOWN',
        label: 'Denumirea Rev.2',
        descriptionStatus: 'EXACT',
        descriptions: [{ revision: 'rev2', label: 'Denumirea Rev.2' }],
      });
      expect(breakdown.groups.find((group) => group.key === '?:6201')?.caen).toEqual({
        code: '6201',
        revision: null,
        basis: 'REVISION_UNKNOWN',
        label: null,
        descriptionStatus: 'CONFLICT',
        descriptions: [
          { revision: 'rev2', label: 'Denumirea Rev.2' },
          { revision: 'rev3', label: 'Denumirea Rev.3' },
        ],
      });
      const recordsResponse = await gql(
        app,
        `query { companyAnalysisRecords(first: 100) { edges { node { mainCaen { code revision basis label descriptionStatus descriptions { revision label } } } } } }`
      );
      expect(recordsResponse.errors).toBeUndefined();
      const records = recordsResponse.data?.['companyAnalysisRecords'] as {
        edges: { node: { mainCaen: { code: string; revision: string | null } | null } }[];
      };
      for (const key of ['rev2:6201', '?:6201']) {
        const revision = key.startsWith('?') ? null : 'rev2';
        expect(
          records.edges.find(
            ({ node }) => node.mainCaen?.code === '6201' && node.mainCaen.revision === revision
          )?.node.mainCaen
        ).toEqual(breakdown.groups.find((group) => group.key === key)?.caen);
      }
    } finally {
      await app.close();
    }
  });
});

describe('the ACTIVITY capability on both surfaces', () => {
  it('refuses ACTIVITY on a v2 release with the same typed RELEASE_CAPABILITY_UNAVAILABLE', async () => {
    const body = await gql(
      app,
      `query { companyAnalysisBreakdown(dimension: ACTIVITY) { groupCount } }`
    );
    expect(body.data?.['companyAnalysisBreakdown']).toBeNull();
    expect(body.errors?.[0]?.extensions).toEqual({
      code: 'RELEASE_CAPABILITY_UNAVAILABLE',
      type: 'ReleaseCapabilityUnavailable',
      field: 'dimension',
      capability: 'ACTIVITY',
      releaseId: '7',
      schemaVersion: 'companies-analytics-ch-v2',
    });
    const mcp = await callTool(tools, 'aggregate_companies', {
      shape: 'breakdown',
      dimension: 'ACTIVITY',
    });
    expect(mcp).toEqual({
      ok: false,
      kind: 'company_analysis_breakdown',
      errorCode: 'RELEASE_CAPABILITY_UNAVAILABLE',
      error: body.errors?.[0]?.message,
      meta: {
        field: 'dimension',
        capability: 'ACTIVITY',
        releaseId: '7',
        schemaVersion: 'companies-analytics-ch-v2',
      },
    });
    const filtered = await gql(
      app,
      `query { companyAnalysisStats(scope: { activityBasis: [ANAF_FISCAL_CODE] }) { companies } }`
    );
    expect(filtered.errors?.[0]?.extensions).toMatchObject({
      code: 'RELEASE_CAPABILITY_UNAVAILABLE',
      field: 'scope.activityBasis',
    });
  });

  it('serves the v3 ACTIVITY breakdown and records identically, unclassified apart', async () => {
    const analytics = analyticsDeps(
      makeInMemoryEngine(ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements, [9]),
      fakeReleases(v3ReleaseRow(9, ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements)),
      fakeLabels({}, { 'rev2:6201': 'Software (rev2)' })
    );
    const v3 = await buildGraphql(analytics);
    const v3Tools = makeCompanyAnalysisMcpTools({
      analytics,
      clientBaseUrl: 'https://transparenta.eu',
    });
    try {
      const body = await gql(
        v3,
        `${AGGREGATE}${BUCKET}
        query {
          companyAnalysisBreakdown(dimension: ACTIVITY, topN: 2) {
            ${RELEASE}
            scope scopeHash fiscalYear dimension metric groupCount rankBy rankedBy topN caveats
            groups { ...Bucket }
            other { ...Bucket }
            unknown { ...Bucket }
            unclassified { ...Bucket }
            totals { ...Bucket }
          }
        }`
      );
      expect(body.errors).toBeUndefined();
      const breakdown = body.data?.['companyAnalysisBreakdown'] as {
        groups: { key: string }[];
        unclassified: { key: string; activity: { basis: string } }[];
      };
      expect(breakdown.groups.map((g) => g.key)).toEqual(['onrc:rev2:4711', 'anaf:6201']);
      expect(breakdown.unclassified.map((g) => [g.key, g.activity.basis])).toEqual([
        ['(onrc_multiple_classes)', 'ONRC_MULTIPLE_CLASSES'],
        ['(anaf_fiscal_uncatalogued)', 'ANAF_FISCAL_UNCATALOGUED'],
        ['(no_qualified_selection)', 'NO_QUALIFIED_SELECTION'],
      ]);
      const mcp = await callTool(v3Tools, 'aggregate_companies', {
        shape: 'breakdown',
        dimension: 'ACTIVITY',
        topN: 2,
      });
      expect(mcp['item']).toEqual(body.data?.['companyAnalysisBreakdown']);
      expect(String(mcp['summary'])).toContain('never ranked');

      const records = await gql(
        v3,
        `query { companyAnalysisRecords(sort: CUI, first: 3, scope: { activity: [{ source: ONRC, code: "6201", revision: "rev2" }] }) {
          totalCount
          edges { node { cui activity { basis source code revision label descriptionStatus derived } onrcClassKeyCount anafCaenForm anafOnrcAgreement anafStatusDate } }
        } }`
      );
      expect(records.errors).toBeUndefined();
      expect(records.data?.['companyAnalysisRecords']).toEqual({
        totalCount: '2',
        edges: [
          {
            node: {
              cui: '1001',
              activity: {
                basis: 'ONRC_SINGLE_CLASS',
                source: 'ONRC',
                code: '6201',
                revision: 'rev2',
                label: 'Software (rev2)',
                descriptionStatus: 'EXACT',
                derived: true,
              },
              onrcClassKeyCount: 1,
              anafCaenForm: 'four_digit',
              anafOnrcAgreement: 'match_one_key',
              anafStatusDate: '2026-09-01',
            },
          },
          {
            node: {
              cui: '1002',
              activity: {
                basis: 'ONRC_CLASS_ANAF_NUMERIC_MATCH',
                source: 'ONRC',
                code: '6201',
                revision: 'rev2',
                label: 'Software (rev2)',
                descriptionStatus: 'EXACT',
                derived: true,
              },
              onrcClassKeyCount: 2,
              anafCaenForm: 'four_digit',
              anafOnrcAgreement: 'match_one_key',
              anafStatusDate: '2026-09-28',
            },
          },
        ],
      });
      const anafWithRevision = await gql(
        v3,
        `query { companyAnalysisStats(scope: { activity: [{ source: ANAF, code: "6201", revision: "rev2" }] }) { companies } }`
      );
      expect(anafWithRevision.errors?.[0]?.extensions).toMatchObject({
        code: 'INVALID_INPUT',
        field: 'scope.activity',
      });
    } finally {
      await v3.close();
    }
  });
});
