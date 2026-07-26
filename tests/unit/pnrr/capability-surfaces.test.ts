import createFastify, { type FastifyInstance } from 'fastify';
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePnrrResolvers } from '@/modules/pnrr/shell/graphql/resolvers.js';
import { pnrrTypeDefs } from '@/modules/pnrr/shell/graphql/typedefs.js';
import { makePnrrMcpTools } from '@/modules/pnrr/shell/mcp/tools.js';
import { makePnrrRestRoutes } from '@/modules/pnrr/shell/rest/routes.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';

import type { PnrrRepository } from '@/modules/pnrr/core/ports.js';
import type { PnrrCapability, PnrrRelease } from '@/modules/pnrr/core/types.js';

const RELEASE: PnrrRelease = {
  releaseId: 'pnrr-v2:capability-release',
  releaseKind: 'operational_snapshot',
  state: 'degraded',
  sourceSnapshotAt: '2026-07-26T00:00:00Z',
  completedAt: '2026-07-26T01:00:00Z',
  lanes: [],
  limitation: 'fixture',
};

const CAPABILITY: PnrrCapability = {
  id: 'projects',
  releaseId: RELEASE.releaseId,
  state: 'degraded',
  reasonCodes: ['fixture'],
  limitation: 'fixture',
};

const makeRepo = (
  release: PnrrRelease = RELEASE,
  capability: PnrrCapability = CAPABILITY
): PnrrRepository =>
  ({
    getCurrentRelease: vi.fn(async () => ok(release)),
    getCapabilities: vi.fn(async () => ok([capability])),
    contractorsForAcquisitions: vi.fn(async () => ok(new Map())),
  }) as unknown as PnrrRepository;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('PNRR release-bound capabilities', () => {
  it('keeps established GraphQL and MCP reads available without an active release', async () => {
    const release: PnrrRelease = {
      ...RELEASE,
      releaseId: 'pnrr-no-active-release',
      state: 'abstained',
    };
    const repo = {
      ...makeRepo(release),
      listEntities: vi.fn(async () => ok({ items: [], next: null })),
      getEntity: vi.fn(async () => ok(null)),
      getEntityProfile: vi.fn(async () => ok(null)),
    } as unknown as PnrrRepository;
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrEntities: (
          root: unknown,
          args: { first?: number; assertReleaseId?: string }
        ) => Promise<{ edges: unknown[] }>;
      };
    };

    await expect(resolvers.Query.pnrrEntities(null, { first: 20 })).resolves.toEqual(
      expect.objectContaining({ edges: [] })
    );

    const entityTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'get_pnrr_entity');
    expect(entityTool).toBeDefined();
    await expect(entityTool!.handler({ cui: '16054368' })).resolves.toEqual(
      expect.objectContaining({ ok: true, kind: 'entity' })
    );
  });

  it('retains the established contractor-ranking schema while exposing the safer count basis', () => {
    expect(pnrrTypeDefs).toContain('value\n    awards\n    relationships');
    expect(pnrrTypeDefs).toContain('wonAsContractor: Int!');
    expect(pnrrTypeDefs).toContain('wonValue: Money');
    expect(pnrrTypeDefs).toContain('awardCount: Int!');
  });

  it('serves the identical release-bound capability through GraphQL, REST, and MCP', async () => {
    const repo = makeRepo();
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrCapabilities: (
          root: unknown,
          args: { assertReleaseId?: string }
        ) => Promise<readonly PnrrCapability[]>;
      };
    };
    const graphql = await resolvers.Query.pnrrCapabilities(null, {
      assertReleaseId: RELEASE.releaseId,
    });

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), {
      prefix: '/api/v1/pnrr',
    });
    const restResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/capabilities?assertReleaseId=${encodeURIComponent(RELEASE.releaseId)}`,
    });
    expect(restResponse.statusCode).toBe(200);
    const rest = restResponse.json();

    const statusTool = makePnrrMcpTools({
      repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((tool) => tool.name === 'get_pnrr_status');
    expect(statusTool).toBeDefined();
    const mcp = await statusTool!.handler({});
    const mcpItem = mcp.item as { capabilities: readonly PnrrCapability[] } | undefined;

    expect(graphql).toEqual([CAPABILITY]);
    expect(rest.data).toEqual(graphql);
    expect(mcpItem?.capabilities).toEqual(graphql);
  });

  it('keeps abstained release capabilities inspectable', async () => {
    const release: PnrrRelease = {
      ...RELEASE,
      releaseId: 'pnrr-no-active-release',
      state: 'abstained',
    };
    const capability: PnrrCapability = {
      ...CAPABILITY,
      releaseId: release.releaseId,
      state: 'abstained',
      reasonCodes: ['no_active_release'],
    };
    const repo = makeRepo(release, capability);
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrCapabilities: (
          root: unknown,
          args: { assertReleaseId?: string }
        ) => Promise<readonly PnrrCapability[]>;
      };
    };

    await expect(
      resolvers.Query.pnrrCapabilities(null, {
        assertReleaseId: release.releaseId,
      })
    ).resolves.toEqual([capability]);

    const app = createFastify({ logger: false });
    apps.push(app);
    await app.register(makePnrrRestRoutes({ repo }), {
      prefix: '/api/v1/pnrr',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/pnrr/capabilities?assertReleaseId=${release.releaseId}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects capabilities when the release changes during the read', async () => {
    const changed = { ...RELEASE, releaseId: 'pnrr-v2:next-release' };
    const repo = makeRepo();
    vi.mocked(repo.getCurrentRelease)
      .mockResolvedValueOnce(ok(RELEASE))
      .mockResolvedValueOnce(ok(changed));
    const resolvers = makePnrrResolvers({
      repo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        pnrrCapabilities: (
          root: unknown,
          args: { assertReleaseId?: string }
        ) => Promise<readonly PnrrCapability[]>;
      };
    };

    await expect(
      resolvers.Query.pnrrCapabilities(null, {
        assertReleaseId: RELEASE.releaseId,
      })
    ).rejects.toMatchObject({
      extensions: {
        code: 'RELEASE_MISMATCH',
        expectedReleaseId: RELEASE.releaseId,
        currentReleaseId: changed.releaseId,
      },
    });
  });
});
