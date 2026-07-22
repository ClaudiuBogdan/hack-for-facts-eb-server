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

import { readFileSync } from 'node:fs';

import corsPlugin from '@fastify/cors';
import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance } from 'fastify';
import mercuriusPlugin from 'mercurius';

import {
  makeGraphQLErrorFormatter,
  makeGraphQLValidationRules,
} from '../infra/graphql/security.js';
import { makeBudgetModule } from '../modules/budget/index.js';
import { makeCompaniesModule } from '../modules/companies/index.js';
import { makeJudicialModule } from '../modules/judicial/index.js';
import { makeLegalModule } from '../modules/legal/index.js';
import { makeParliamentModule } from '../modules/parliament/index.js';
import { makePnrrModule } from '../modules/pnrr/index.js';
import { makePrimariiTransparencyModule } from '../modules/primarii-transparency/index.js';
import { makeProcurementModule } from '../modules/procurement/index.js';
import { makeReferenceModule } from '../modules/reference/index.js';
import {
  makeKernel,
  type Kernel,
  type KernelConfig,
  type GraphqlSlice,
  type KernelMcpTool,
} from '../modules/shared/index.js';

import type { UserDatabase } from '../infra/database/user/types.js';
import type { AgentModuleConfig } from '../modules/agent/index.js';
import type { QuotaRedis } from '../modules/agent/shell/quota/quota-store.js';
import type { AuthProvider } from '../modules/auth/index.js';
import type { Kysely } from 'kysely';

/**
 * Deps for the OPTIONAL agent service module (docs/AGENT-MODULE-SPEC.md).
 * Only the legacy mount passes this — it needs the user DB, Redis, and the
 * Clerk auth provider, none of which exist on the standalone redesign server.
 * The module itself is loaded dynamically so the standalone server never pulls
 * the AI SDK graph.
 */
export interface RedesignAgentDeps {
  readonly userDb: Kysely<UserDatabase>;
  readonly redis: QuotaRedis | null;
  readonly authProvider: AuthProvider;
  readonly config: AgentModuleConfig;
}

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
  /** Client base URL for module MCP deep links. Also trusted as a CORS origin. */
  readonly clientBaseUrl?: string;
  /**
   * Additional browser origins allowed to call the API cross-origin (in prod).
   * In development any `localhost` origin is allowed regardless. Requests with no
   * `Origin` header (server-to-server, SSR loaders, curl) are always allowed.
   */
  readonly corsAllowedOrigins?: readonly string[];
  /**
   * Source modules to wire into the kernel. Defaults to all built-in modules.
   * Pass `[]` to boot the bare kernel.
   */
  readonly modules?: readonly (
    | 'pnrr'
    | 'reference'
    | 'budget'
    | 'companies'
    | 'legal'
    | 'parliament'
    | 'judicial'
    | 'procurement'
    | 'primarii-transparency'
  )[];
  /** Disable procurement's fire-and-forget preload for isolated cold benchmarks. */
  readonly procurementWarmCache?: boolean;
  /** When set, mounts the authenticated agent surface at /api/v1/agent. */
  readonly agent?: RedesignAgentDeps;
}

export interface RedesignApp {
  readonly app: FastifyInstance;
  readonly kernel: Kernel;
}

/** True for http(s) origins whose host is a loopback address. */
const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
};

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

  // ── CORS ─────────────────────────────────────────────────────────────────────
  // The browser client calls /api/v1/graphql + /api/v1/mcp cross-origin, so the
  // API must answer OPTIONS preflight and set Access-Control-Allow-Origin.
  // Registered before the routes so its onRequest hook is inherited by them.
  //  - No `Origin` header (server-to-server, SSR loaders, curl) → always allowed.
  //  - Development → any localhost origin allowed (client dev server, any port).
  //  - Production  → only the configured client origins (clientBaseUrl + extras).
  const isProduction = process.env['NODE_ENV'] === 'production';
  const allowedOrigins = new Set<string>(
    [deps.clientBaseUrl, ...(deps.corsAllowedOrigins ?? [])]
      .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
      .map((o) => o.trim())
  );
  await app.register(corsPlugin, {
    origin: (origin, cb) => {
      if (origin === undefined || origin === '') {
        cb(null, true);
        return;
      }
      if (!isProduction && isLocalhostOrigin(origin)) {
        cb(null, true);
        return;
      }
      cb(null, allowedOrigins.has(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'accept',
      'mcp-session-id',
      'last-event-id',
    ],
    exposedHeaders: ['content-type', 'mcp-session-id', 'Mcp-Session-Id'],
    credentials: true,
  });

  const kernel = await registerRedesignSurface(app, deps);

  return { app, kernel };
};

/**
 * Registers the redesign kernel surface (GraphQL + MCP + health/ready) onto an
 * EXISTING Fastify scope. Does NOT create the Fastify instance and does NOT
 * register CORS — the caller owns those.
 *
 * Two callers:
 *  - `buildRedesignApp` (above): standalone redesign server — creates the app +
 *    its own CORS, then calls this.
 *  - legacy `buildApp`: mounts this on an encapsulated child scope so the
 *    redesign GraphQL/MCP is served on the SAME port as the legacy API, reusing
 *    the legacy app's global CORS. Mount with `enableGraphiQL: false` to avoid a
 *    duplicate `GET /graphiql` route (legacy Mercurius already declares it).
 *
 * The kernel's `onClose` hook is added to the passed scope, so it closes when
 * the owning app closes.
 */
export const registerRedesignSurface = async (
  app: FastifyInstance,
  deps: BuildRedesignAppDeps
): Promise<Kernel> => {
  const kernel = await makeKernel(deps.kernelConfig);

  // Release the kernel (pg pool + clients) when the owning scope closes.
  // Registered right after creation — BEFORE the wiring below — so that if any
  // step throws (the legacy mount catches it and continues legacy-only), the pool
  // is still owned by this scope and freed on `app.close()` rather than leaking.
  app.addHook('onClose', async () => {
    await kernel.close();
  });

  // ── Source modules (built on the kernel) ─────────────────────────────────────
  // Each module augments ProdDatabase, contributes a GraphQL slice + MCP tools,
  // and registers a SourceContributor. Order is data-independent EXCEPT parliament,
  // which reads the legal-registered `legalActLoader` for its bill↔act link — so
  // parliament is wired AFTER legal (it degrades to null if legal is disabled).
  // legal is wired before parliament + judicial (both read the legal-registered
  // `legalActLoader`); judicial's SDL references LegalAct, so legal must be in the
  // set whenever judicial is.
  const enabledModules =
    deps.modules ??
    ([
      'pnrr',
      'reference',
      'budget',
      'companies',
      'legal',
      'parliament',
      'judicial',
      'procurement',
      'primarii-transparency',
    ] as const);
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

  if (enabledModules.includes('primarii-transparency')) {
    // Local-government transparency QA registry. Reuses the kernel identity hub for
    // CUI resolution + per-entity territory (`territoryForCui`). Geographic FILTERS
    // (region/siruta/isUat/population) compile through the kernel cui→territory
    // builder, so they are enabled here (the join is stable core schema).
    const primarii = makePrimariiTransparencyModule({
      db: kernel.db,
      identityRepo: kernel.identityRepo,
      registry: kernel.contributors,
      territoryFilterAvailable: true,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(primarii.contributor);
    moduleSlices.push(primarii.graphqlSlice);
    moduleResolvers.push(primarii.graphqlResolvers);
    moduleMcpTools.push(...primarii.mcpTools);
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

  if (enabledModules.includes('procurement')) {
    const windowEnv = Number(process.env['PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS']);
    // DEV list-search switch: resolve the `q` facet through the chronos
    // OpenSearch proto indices (via port-forward). DEDICATED variable —
    // deliberately not the kernel-wide PROD_OPENSEARCH_URL, so existing
    // environments can never enable this path implicitly. Unset = SQL ILIKE.
    // Format of PROCUREMENT_Q_OPENSEARCH_INDEXES: `grain:index,...`.
    // TLS: PROCUREMENT_Q_OPENSEARCH_CA_FILE pins the private CA and
    // PROCUREMENT_Q_OPENSEARCH_TLS_SERVERNAME must be a cert SAN (the
    // port-forward host is localhost, which the node cert does not carry).
    const qOpensearchUrl = process.env['PROCUREMENT_Q_OPENSEARCH_URL'];
    const qOpensearchCaFile = process.env['PROCUREMENT_Q_OPENSEARCH_CA_FILE'];
    const qOpensearchIndexes = Object.fromEntries(
      (
        process.env['PROCUREMENT_Q_OPENSEARCH_INDEXES'] ??
        'procedures:proto_procurement_procedures_v0,contracts:proto_procurement_contracts_v0,direct_acquisitions:proto_procurement_da_v0'
      )
        .split(',')
        .map((pair) => pair.split(':').map((s) => s.trim()))
        .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== '' && kv[1] !== '')
    );
    const procurement = makeProcurementModule({
      db: kernel.db,
      logger: app.log,
      ...(qOpensearchUrl !== undefined &&
        qOpensearchUrl !== '' && {
          opensearch: {
            url: qOpensearchUrl,
            indexes: qOpensearchIndexes,
            ...(process.env['PROCUREMENT_Q_OPENSEARCH_USERNAME'] !== undefined && {
              username: process.env['PROCUREMENT_Q_OPENSEARCH_USERNAME'],
            }),
            ...(process.env['PROCUREMENT_Q_OPENSEARCH_PASSWORD'] !== undefined && {
              password: process.env['PROCUREMENT_Q_OPENSEARCH_PASSWORD'],
            }),
            ...(qOpensearchCaFile !== undefined &&
              qOpensearchCaFile !== '' && {
                caCert: readFileSync(qOpensearchCaFile, 'utf8'),
              }),
            ...(process.env['PROCUREMENT_Q_OPENSEARCH_TLS_SERVERNAME'] !== undefined && {
              tlsServername: process.env['PROCUREMENT_Q_OPENSEARCH_TLS_SERVERNAME'],
            }),
          },
        }),
      ...(deps.procurementWarmCache !== undefined && { warmCache: deps.procurementWarmCache }),
      ...(Number.isFinite(windowEnv) &&
        windowEnv > 0 && { daListMaxWindowDays: Math.floor(windowEnv) }),
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    moduleSlices.push(procurement.graphqlSlice);
    moduleResolvers.push(procurement.graphqlResolvers);
    moduleMcpTools.push(...procurement.mcpTools);
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

  if (enabledModules.includes('legal')) {
    // The legal module embeds queries with the nomic model + `search_query:`
    // prefix; discover the model id from the synthetic client (env override wins).
    const embedRes = await kernel.clients.syntheticClient.discoverEmbeddingModel();
    const embeddingModel = embedRes.isOk() ? embedRes.value : 'nomic-embed-text-v1.5';
    const legal = await makeLegalModule({
      db: kernel.db,
      meiliClient: kernel.clients.meiliClient,
      openSearchClient: kernel.clients.openSearchClient,
      synthetic: kernel.clients.syntheticClient,
      capabilities: kernel.searchCapabilities,
      cache: kernel.cache,
      registry: kernel.contributors,
      identity: kernel.identityRepo,
      embeddingModel,
      logger: app.log,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    // The legal acts area registers NO contributor in v1 (§4); 06's MO area will.
    for (const c of legal.contributors) kernel.contributors.register(c);
    // Parliament (04) + judicial (08) resolve act_id → act through this loader.
    kernel.registerLegalActLoader(legal.legalActLoader);
    moduleSlices.push(legal.graphqlSlice);
    moduleResolvers.push(legal.graphqlResolvers);
    moduleMcpTools.push(...legal.mcpTools);
  }

  if (enabledModules.includes('parliament')) {
    // Wired AFTER legal so the bill↔act loader is registered. The loader is
    // optional — if legal is disabled, `ParliamentBillActLink.legalAct` → null.
    const parliament = makeParliamentModule({
      db: kernel.db,
      registry: kernel.contributors,
      legalActLoader: kernel.legalActLoader(),
      meili: kernel.clients.meiliClient,
      searchEngineUp:
        kernel.searchCapabilities.engines.meili || kernel.searchCapabilities.engines.opensearch,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(parliament.contributor);
    moduleSlices.push(parliament.graphqlSlice);
    moduleResolvers.push(parliament.graphqlResolvers);
    moduleMcpTools.push(...parliament.mcpTools);
  }

  if (enabledModules.includes('judicial')) {
    // PRIVACY-CRITICAL module. Reads the legal-act loader LAZILY (registered above
    // by legal if enabled) — registration order is data-independent.
    const judicial = makeJudicialModule({
      db: kernel.db,
      registry: kernel.contributors,
      legalActLoader: () => kernel.legalActLoader(),
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(judicial.contributor);
    moduleSlices.push(judicial.graphqlSlice);
    moduleResolvers.push(judicial.graphqlResolvers);
    moduleMcpTools.push(...judicial.mcpTools);
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

  const isProduction = process.env['NODE_ENV'] === 'production';

  await app.register(mercuriusPlugin, {
    schema,
    path: '/api/v1/graphql',
    graphiql: deps.enableGraphiQL ?? !isProduction,
    allowBatchedQueries: false,
    validationRules: makeGraphQLValidationRules(isProduction),
    errorFormatter: makeGraphQLErrorFormatter(isProduction),
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

  // ── Agent (optional, authenticated) ──────────────────────────────────────────
  // Consumes the SAME tool definitions as /api/v1/mcp (shared registry, spec
  // §2.4). Dynamic import keeps the AI SDK out of the standalone server graph.
  if (deps.agent !== undefined) {
    const { makeAgentModule } = await import('../modules/agent/index.js');
    const agent = makeAgentModule({
      tools: [...kernel.mcpTools, ...moduleMcpTools],
      userDb: deps.agent.userDb,
      redis: deps.agent.redis,
      authProvider: deps.agent.authProvider,
      config: deps.agent.config,
    });
    if (agent.configuredProviders.length === 0) {
      app.log.warn(
        'Agent surface mounted with NO LLM provider key — /api/v1/agent/chat will return 503'
      );
    }
    await app.register(agent.routesPlugin, { prefix: '/api/v1/agent' });
  }

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

  return kernel;
};
