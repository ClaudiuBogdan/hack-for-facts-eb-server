import createFastify, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePnrrResolvers } from '@/modules/pnrr/shell/graphql/resolvers.js';
import { makePnrrMcpTools } from '@/modules/pnrr/shell/mcp/tools.js';
import { makePnrrRestRoutes } from '@/modules/pnrr/shell/rest/routes.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';

import type { PnrrRepository } from '@/modules/pnrr/core/ports.js';
import type { PnrrProject, PnrrProjectFacets, PnrrRelease } from '@/modules/pnrr/core/types.js';

const RELEASE: PnrrRelease = {
  releaseId: 'pnrr-v2:release-1',
  releaseKind: 'operational_snapshot',
  state: 'degraded',
  sourceSnapshotAt: '2026-06-10T00:00:00.000Z',
  completedAt: '2026-06-10T01:00:00.000Z',
  lanes: [],
  limitation: 'manifest incomplete',
};

const PROJECT: PnrrProject = {
  projectKey: 'mipe-dashboard-record:abc',
  projectKeyVersion: 'mipe_observation_v1',
  sourceObservationId: 'mipe-dashboard-record:abc',
  snapshotId: 'snapshot-1',
  snapshotDate: '2026-06-09',
  endpointName: 'progres_tehnic_proiecte',
  itemKey: '1302412307',
  commitmentBusinessId: '1302412307',
  contractNumber: '2255DOT',
  contractTitle: 'Modernizare drum',
  beneficiaryCui: '4297649',
  beneficiaryName: 'Beneficiar',
  beneficiaryType: 'UAT',
  componentCode: 'C15',
  measureCode: 'I9',
  submeasureCode: null,
  responsibleInstitutionCode: null,
  responsibleInstitutionName: null,
  financingSource: null,
  commitmentDate: '2025-01-10',
  startDate: '2025-02-01',
  endDate: '2026-06-30',
  lastFundingDate: null,
  totalValueRon: '1313523.380000000000000001',
  euContributionRon: '1103801.16',
  nationalPublicValueRon: null,
  vatRon: null,
  ineligibleValueRon: null,
  receivedAmountRon: null,
  allocatedEur: null,
  paidEur: null,
  receivedEur: null,
  prefinancingEur: null,
  suspendedEur: null,
  revokedEur: null,
  projectCount: null,
  contractBeneficiaryCount: null,
  paymentBeneficiaryCount: null,
  nationalImpactProjectCount: null,
  paymentCount: null,
  beneficiaryCount: null,
  totalEur: null,
  totalRon: null,
  financialProgressRatio: 0.4288,
  physicalProgressRatio: 0.491,
  countyName: 'VRANCEA',
  countySiruta: '39',
  localityName: 'COMUNA VIDRA',
  impact: 'local',
  timelineMonth: null,
  timelineLabel: null,
  status: 'ÎN IMPLEMENTARE',
  sourceSystem: 'pnrr_mipe_dashboard',
  sourceUrl: 'https://mfe.gov.ro/pnrr-dashboard/generator/data/projects.json',
  retrievedAt: '2026-06-10T00:00:00.000Z',
  linkedCommitmentKey: 'commitment-1',
  commitmentRelationship: 'candidate_project',
  commitmentAggregationState: 'single_observation_additive',
};

const FACETS: PnrrProjectFacets = {
  totalCount: 17,
  components: [{ value: 'C15', label: 'Educație', count: 11 }],
  measures: [{ value: 'I9', label: null, count: 7 }],
  statuses: [{ value: 'ÎN IMPLEMENTARE', label: 'ÎN IMPLEMENTARE', count: 13 }],
  counties: [{ value: '39', label: 'VRANCEA', count: 5 }],
};

const repoStub = (): PnrrRepository =>
  ({
    getCurrentRelease: vi.fn(async () => ok(RELEASE)),
    listProjects: vi.fn(async () => ok({ items: [PROJECT], next: null })),
    getProject: vi.fn(async () => ok(PROJECT)),
    getProjectHistory: vi.fn(async () => ok([PROJECT])),
    getProjectFacets: vi.fn(async () => ok(FACETS)),
    contractorsForAcquisitions: vi.fn(async () => ok(new Map())),
  }) as unknown as PnrrRepository;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('PNRR project API surfaces', () => {
  it('serves the same exact MIPE project through GraphQL, REST, and MCP', async () => {
    const repo = repoStub();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrProject: (
          root: unknown,
          args: { key: string; assertReleaseId?: string }
        ) => Promise<PnrrProject | null>;
      };
    };
    const graphqlProject = await resolvers.Query.pnrrProject(null, {
      key: PROJECT.projectKey,
      assertReleaseId: RELEASE.releaseId,
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const restResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/projects/${encodeURIComponent(PROJECT.projectKey)}?assertReleaseId=${encodeURIComponent(RELEASE.releaseId)}`,
    });
    expect(restResponse.statusCode).toBe(200);
    const restProject = restResponse.json().data;

    const projectTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'get_pnrr_project');
    expect(projectTool).toBeDefined();
    const mcp = await projectTool!.handler({
      key: PROJECT.projectKey,
      assertReleaseId: RELEASE.releaseId,
    });

    expect(graphqlProject).toEqual(PROJECT);
    expect(restProject).toEqual(PROJECT);
    expect(mcp.item).toEqual(PROJECT);
    expect(mcp.link).toContain('/pnrr/proiecte/');
  });

  it('returns RELEASE_MISMATCH instead of serving a mixed release', async () => {
    const repo = repoStub();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrProject: (
          root: unknown,
          args: { key: string; assertReleaseId?: string }
        ) => Promise<PnrrProject | null>;
      };
    };

    await expect(
      resolvers.Query.pnrrProject(null, {
        key: PROJECT.projectKey,
        assertReleaseId: 'stale-release',
      })
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'RELEASE_MISMATCH' }),
    });
  });

  it('serves identical filtered facets through GraphQL, REST, and MCP', async () => {
    const repo = repoStub();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrProjectFacets: (
          root: unknown,
          args: {
            filter?: Record<string, unknown>;
            assertReleaseId?: string;
          }
        ) => Promise<PnrrProjectFacets>;
      };
    };
    const filter = { componentCode: { eq: 'C15' } };
    const graphqlFacets = await resolvers.Query.pnrrProjectFacets(null, {
      filter,
      assertReleaseId: RELEASE.releaseId,
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const restResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/projects/facets?componentCode=C15&assertReleaseId=${encodeURIComponent(RELEASE.releaseId)}`,
    });
    expect(restResponse.statusCode).toBe(200);
    const restFacets = restResponse.json().data;

    const facetTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'get_pnrr_project_facets');
    expect(facetTool).toBeDefined();
    const mcp = await facetTool!.handler({
      filter,
      assertReleaseId: RELEASE.releaseId,
    });

    expect(graphqlFacets).toEqual(FACETS);
    expect(restFacets).toEqual(FACETS);
    expect(mcp.item).toEqual(FACETS);
    expect(repo.getProjectFacets).toHaveBeenCalledWith(filter);
  });

  it('rejects an invalid scoped CUI instead of silently widening the query', async () => {
    const repo = repoStub();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrOverview: (
          root: unknown,
          args: { scope?: { beneficiaryCui?: string } }
        ) => Promise<unknown>;
      };
    };

    await expect(
      resolvers.Query.pnrrOverview(null, {
        scope: { beneficiaryCui: 'not-a-cui' },
      })
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
    });
  });

  it('rejects unsupported analytical roles instead of echoing an unexecuted scope', async () => {
    const repo = repoStub();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrOverview: (
          root: unknown,
          args: { scope?: { grain?: string; currency?: string } }
        ) => Promise<unknown>;
        pnrrVerification: (
          root: unknown,
          args: { scope?: { componentCode?: string } }
        ) => Promise<unknown>;
      };
    };

    await expect(
      resolvers.Query.pnrrOverview(null, {
        scope: { grain: 'payment' },
      })
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'BAD_USER_INPUT', field: 'grain' }),
    });
    await expect(
      resolvers.Query.pnrrOverview(null, {
        scope: { currency: 'EUR' },
      })
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'BAD_USER_INPUT', field: 'currency' }),
    });
    await expect(
      resolvers.Query.pnrrVerification(null, {
        scope: { componentCode: 'C1' },
      })
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: 'BAD_USER_INPUT', field: 'scope' }),
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/overview?currency=EUR&assertReleaseId=${encodeURIComponent(
        RELEASE.releaseId
      )}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'InvalidInput',
    });
  });
});
