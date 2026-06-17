/**
 * Bootable redesign server (foundation §2, §10) — NO legacy modules.
 *
 * Wires ONLY the shared kernel:
 *  - GraphQL at `/api/v1/graphql` (kernel base Query + module slices, stitched).
 *  - MCP at `/api/v1/mcp` (stateless streamable-HTTP transport).
 *  - `GET /api/v1/health` (liveness; degrades on aux down, never hard-fails).
 *  - `GET /api/v1/ready` (readiness; gates deploys — fails if postgres is down).
 *
 * Surface = GraphQL + MCP only (REST deferred per the kernel brief). Source
 * modules are registered through `deps.graphqlSlices` / `deps.mcpTools` /
 * `deps.registerContributors` once they exist; the kernel boots standalone today.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance } from 'fastify';
import mercuriusPlugin from 'mercurius';

import { makeBudgetModule } from '../modules/budget/index.js';
import { makeCompaniesModule } from '../modules/companies/index.js';
import { makePnrrModule } from '../modules/pnrr/index.js';
import { makeReferenceModule } from '../modules/reference/index.js';
import { makeKernel, type Kernel, type KernelConfig, type GraphqlSlice, type KernelMcpTool } from '../modules/shared/index.js';

export interface BuildRedesignAppDeps {
  readonly kernelConfig: KernelConfig;
  readonly logLevel?: string;
  /** GraphQL SDL slices contributed by source modules (extend Query/Entity). */
  readonly graphqlSlices?: readonly GraphqlSlice[];
  /** Module GraphQL resolvers, merged over the kernel resolvers. */
  readonly graphqlResolvers?: Record<string, unknown>;
  /** MCP tools contributed by source modules. */
  readonly mcpTools?: readonly KernelMcpTool[];
  /** Hook to register source contributors into the kernel registry. */
  readonly registerContributors?: (kernel: Kernel) => void;
  readonly enableGraphiQL?: boolean;
  /** Client base URL for module MCP deep links. */
  readonly clientBaseUrl?: string;
  /**
   * Source modules to wire into the kernel. Defaults to all built-in modules.
   * Pass `[]` to boot the bare kernel.
   */
  readonly modules?: readonly ('pnrr' | 'reference' | 'budget' | 'companies' | 'legal')[];
}

export interface RedesignApp {
  readonly app: FastifyInstance;
  readonly kernel: Kernel;
}

const deepMergeResolvers = (
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (
      typeof existing === 'object' &&
      existing !== null &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeResolvers(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const buildRedesignApp = async (deps: BuildRedesignAppDeps): Promise<RedesignApp> => {
  const app = fastifyLib({
    logger: { level: deps.logLevel ?? 'info' },
    disableRequestLogging: true,
    trustProxy: true,
  });

  const kernel = await makeKernel(deps.kernelConfig);

  // ── Source modules (built on the kernel) ─────────────────────────────────────
  // Each module augments ProdDatabase, contributes a GraphQL slice + MCP tools,
  // and registers a SourceContributor. Registration order is data-independent.
  const enabledModules =
    deps.modules ?? (['pnrr', 'reference', 'budget', 'companies', 'legal'] as const);
  const moduleSlices: GraphqlSlice[] = [];
  const moduleResolvers: Record<string, unknown>[] = [];
  const moduleMcpTools: KernelMcpTool[] = [];

  if (enabledModules.includes('pnrr')) {
    const pnrr = makePnrrModule({
      db: kernel.db,
      registry: kernel.contributors,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(pnrr.contributor);
    moduleSlices.push(pnrr.graphqlSlice);
    moduleResolvers.push(pnrr.graphqlResolvers);
    moduleMcpTools.push(...pnrr.mcpTools);
  }

  if (enabledModules.includes('reference')) {
    // Reference reuses the kernel identity + territory hubs (§0) — they are
    // injected, not constructed by the module.
    const reference = makeReferenceModule({
      db: kernel.db,
      identityRepo: kernel.identityRepo,
      territoryRepo: kernel.territoryRepo,
      registry: kernel.contributors,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(reference.contributor);
    moduleSlices.push(reference.graphqlSlice);
    moduleResolvers.push(reference.graphqlResolvers);
    moduleMcpTools.push(...reference.mcpTools);
  }

  if (enabledModules.includes('budget')) {
    const budget = makeBudgetModule({
      db: kernel.db,
      registry: kernel.contributors,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(budget.contributor);
    moduleSlices.push(budget.graphqlSlice);
    moduleResolvers.push(budget.graphqlResolvers);
    moduleMcpTools.push(...budget.mcpTools);
  }

  if (enabledModules.includes('companies')) {
    const companies = makeCompaniesModule({
      db: kernel.db,
      registry: kernel.contributors,
      flowsRepo: kernel.flowsRepo,
      meili: kernel.clients.meiliClient,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(companies.contributor);
    moduleSlices.push(companies.graphqlSlice);
    moduleResolvers.push(companies.graphqlResolvers);
    moduleMcpTools.push(...companies.mcpTools);
  }

  deps.registerContributors?.(kernel);

  // ── GraphQL ────────────────────────────────────────────────────────────────
  const allSlices = [...moduleSlices, ...(deps.graphqlSlices ?? [])];
  const { typeDefs, resolvers } = kernel.buildGraphql(allSlices);
  let mergedResolvers = resolvers;
  for (const r of moduleResolvers) mergedResolvers = deepMergeResolvers(mergedResolvers, r);
  if (deps.graphqlResolvers !== undefined) {
    mergedResolvers = deepMergeResolvers(mergedResolvers, deps.graphqlResolvers);
  }

  // The kernel resolver map is a plain resolver object; @graphql-tools types it
  // as IResolvers. Cast through unknown — shape is correct at runtime.
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: mergedResolvers as unknown as Record<string, never>,
  });

  await app.register(mercuriusPlugin, {
    schema,
    path: '/api/v1/graphql',
    graphiql: deps.enableGraphiQL ?? process.env['NODE_ENV'] !== 'production',
    allowBatchedQueries: false,
  });

  // ── MCP (JSON-RPC over HTTP) ─────────────────────────────────────────────────
  // Direct JSON-RPC dispatch (no SDK hono/socket bridge, which crashes under
  // Fastify with `socket.destroySoon is not a function`). Works under a real
  // listen and inject() alike.
  const mcpDispatcher = kernel.buildMcpDispatcher([...moduleMcpTools, ...(deps.mcpTools ?? [])]);

  app.post('/api/v1/mcp', async (request, reply) => {
    const response = await mcpDispatcher.dispatch(request.body);
    if (response === null) return reply.code(202).send();
    return reply.code(200).send(response);
  });

  app.addHook('onClose', async () => {
    await mcpDispatcher.close();
  });

  // ── Health / readiness ───────────────────────────────────────────────────────
  app.get('/api/v1/health', async (_request, reply) => {
    const report = await kernel.health();
    // Liveness never hard-fails on aux down (§14.11); always 200.
    return reply.code(200).send(report);
  });

  app.get('/api/v1/ready', async (_request, reply) => {
    const report = await kernel.health();
    const ready = report.postgres.status === 'ok';
    return reply.code(ready ? 200 : 503).send({ ready, ...report });
  });

  app.addHook('onClose', async () => {
    await kernel.close();
  });

  return { app, kernel };
};
