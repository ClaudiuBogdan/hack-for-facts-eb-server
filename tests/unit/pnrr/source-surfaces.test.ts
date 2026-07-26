import createFastify, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePnrrResolvers } from '@/modules/pnrr/shell/graphql/resolvers.js';
import { makePnrrMcpTools } from '@/modules/pnrr/shell/mcp/tools.js';
import { makePnrrRestRoutes } from '@/modules/pnrr/shell/rest/routes.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';

import type { PnrrRepository } from '@/modules/pnrr/core/ports.js';
import type {
  PnrrFundingCall,
  PnrrProgramRevision,
  PnrrRelease,
} from '@/modules/pnrr/core/types.js';

const RELEASE: PnrrRelease = {
  releaseId: 'pnrr-v2:source-release',
  releaseKind: 'operational_snapshot',
  state: 'degraded',
  sourceSnapshotAt: '2026-07-01T00:00:00Z',
  completedAt: '2026-07-01T01:00:00Z',
  lanes: [],
  limitation: 'local source fixture',
};

const CALL: PnrrFundingCall = {
  callId: 'call-1',
  title: 'Digitalizarea administrației',
  budgetRon: '999999999999999999.000000000000000001',
  totalEligibleValueRon: '800000000000000000.123456789',
  sourceSystem: 'pnrr_platform',
  sourceUrl: 'https://proiecte.pnrr.gov.ro/calls/call-1',
  retrievedAt: '2026-07-01T00:00:00Z',
};

const REVISION: PnrrProgramRevision = {
  revisionId: 'council:ST-14452-2025',
  identifierScheme: 'council_register',
  legalReference: 'ST 14452/25',
  celex: null,
  legalStatus: 'adopted',
  isCurrentAdopted: true,
  effectiveDate: '2025-11-13',
  sourceAuthority: 'Council of the European Union',
  sourceUrl: 'https://data.consilium.europa.eu/doc/document/ST-14452-2025-INIT/en/pdf',
  documentCount: 2,
  textReadyDocumentCount: 0,
  ocrRequiredDocumentCount: 1,
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('PNRR source-record API surfaces', () => {
  it('serves the same release-bound funding call through GraphQL, REST, and MCP', async () => {
    const repo = {
      getCurrentRelease: vi.fn(async () => ok(RELEASE)),
      listFundingCalls: vi.fn(async () => ok({ items: [CALL], next: null })),
      contractorsForAcquisitions: vi.fn(async () => ok(new Map())),
    } as unknown as PnrrRepository;

    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrFundingCalls: (
          root: unknown,
          args: { first?: number; assertReleaseId?: string }
        ) => Promise<{ edges: { node: PnrrFundingCall; cursor: string }[] }>;
      };
    };
    const graphql = await resolvers.Query.pnrrFundingCalls(null, {
      first: 20,
      assertReleaseId: RELEASE.releaseId,
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const restResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/calls?assertReleaseId=${encodeURIComponent(RELEASE.releaseId)}`,
    });
    expect(restResponse.statusCode).toBe(200);
    const rest = restResponse.json();

    const sourceTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'list_pnrr_source_records');
    expect(sourceTool).toBeDefined();
    const mcp = await sourceTool!.handler({
      source: 'calls',
      assertReleaseId: RELEASE.releaseId,
    });

    expect(graphql.edges[0]?.node).toEqual(CALL);
    expect(rest.data.items[0]).toEqual(CALL);
    expect(mcp.items?.[0]).toEqual(CALL);
    expect(CALL.budgetRon).toBe('999999999999999999.000000000000000001');
  });

  it('serves a Council revision without inventing a CELEX identifier', async () => {
    const repo = {
      getCurrentRelease: vi.fn(async () => ok(RELEASE)),
      listProgramRevisions: vi.fn(async () => ok({ items: [REVISION], next: null })),
      contractorsForAcquisitions: vi.fn(async () => ok(new Map())),
    } as unknown as PnrrRepository;

    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrProgramRevisions: (
          root: unknown,
          args: { first?: number; assertReleaseId?: string }
        ) => Promise<{ edges: { node: PnrrProgramRevision; cursor: string }[] }>;
      };
    };
    const graphql = await resolvers.Query.pnrrProgramRevisions(null, {
      first: 20,
      assertReleaseId: RELEASE.releaseId,
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), { prefix: '/api/v1/pnrr' });
    const restResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/program-revisions?assertReleaseId=${encodeURIComponent(RELEASE.releaseId)}`,
    });
    expect(restResponse.statusCode).toBe(200);
    const rest = restResponse.json();

    const sourceTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'list_pnrr_source_records');
    expect(sourceTool).toBeDefined();
    const mcp = await sourceTool!.handler({
      source: 'program_revisions',
      assertReleaseId: RELEASE.releaseId,
    });

    expect(graphql.edges[0]?.node).toEqual(REVISION);
    expect(rest.data.items[0]).toEqual(REVISION);
    expect(mcp.items?.[0]).toEqual(REVISION);
    expect(REVISION.celex).toBeNull();
  });
});
