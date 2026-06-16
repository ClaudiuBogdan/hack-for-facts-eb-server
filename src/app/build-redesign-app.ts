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
// eslint-disable-next-line import-x/no-unresolved -- SDK wildcard subpath exports
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import fastifyLib, { type FastifyInstance } from 'fastify';
import mercuriusPlugin from 'mercurius';

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
  deps.registerContributors?.(kernel);

  // ── GraphQL ────────────────────────────────────────────────────────────────
  const { typeDefs, resolvers } = kernel.buildGraphql(deps.graphqlSlices ?? []);
  const mergedResolvers =
    deps.graphqlResolvers !== undefined
      ? deepMergeResolvers(resolvers, deps.graphqlResolvers)
      : resolvers;

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

  // ── MCP (stateless streamable HTTP) ──────────────────────────────────────────
  const mcpServer = kernel.buildMcpServer(deps.mcpTools ?? []);

  app.post('/api/v1/mcp', async (request, reply) => {
    // Stateless mode: omit sessionIdGenerator; JSON request/response. The SDK's
    // transport types are stricter than its runtime contract under
    // exactOptionalPropertyTypes, so connect/handleRequest cross a thin cast.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
    });
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
    const handle = transport.handleRequest.bind(transport);
    await handle(request.raw, reply.raw, request.body);
    return reply;
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
