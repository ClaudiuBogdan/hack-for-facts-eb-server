/**
 * Shared Kernel — public API (foundation §2, §10).
 *
 * `makeKernel(deps)` wires the DB pool, kernel repos, clients, middleware,
 * cross-source usecases, the contributor registry, the GraphQL base slice +
 * merge helper, the MCP tools, and the per-domain search capabilities. Every
 * source module depends ONLY on this surface (+ infra), never on another module.
 */

import { type Entity360Deps } from './core/usecases/entity-360.js';
import { type GlobalSearchDeps } from './core/usecases/global-search.js';
import { createContributorRegistry } from './core/usecases/registry.js';
import { resolveCapabilities } from './shell/clients/capabilities.js';
import { makeMeiliClient } from './shell/clients/meili-client.js';
import { makeOpenSearchClient } from './shell/clients/opensearch-client.js';
import { makeSyntheticClient } from './shell/clients/synthetic-client.js';
import { createProdDb, type ProdDb } from './shell/db/pool.js';
import { makeKernelLoaders, type KernelLoaders } from './shell/graphql/dataloaders.js';
import { mergeGraphqlSlices, type GraphqlSlice } from './shell/graphql/merge.js';
import { makeKernelResolvers } from './shell/graphql/resolvers.js';
import { baseTypeDefs } from './shell/graphql/typedefs.js';
import { createMcpHttpDispatcher, type McpHttpDispatcher } from './shell/mcp/http-dispatch.js';
import { createKernelMcpServer } from './shell/mcp/server.js';
import { makeKernelMcpTools } from './shell/mcp/tools.js';
import { createCache, type KernelCache } from './shell/middleware/cache.js';
import { createRateLimiter, type RateLimiter } from './shell/middleware/rate-limiter.js';
import { makeDocumentRepo } from './shell/repo/document-repo.js';
import { makeFlowsRepo } from './shell/repo/flows-repo.js';
import { makeIdentityRepo } from './shell/repo/identity-repo.js';
import { makeSearchRepo } from './shell/repo/search-repo.js';
import { makeTerritoryRepo } from './shell/repo/territory-repo.js';

import type {
  CapabilityResolver,
  ContributorRegistry,
  DocumentRepo,
  FlowsRepo,
  IdentityRepo,
  LegalActByIdLoader,
  MeiliClient,
  OpenSearchClient,
  SearchRepo,
  SyntheticClient,
  TerritoryRepo,
} from './core/ports.js';
import type { HealthReport, ServiceStatus } from './core/types.js';
import type { KernelMcpTool } from './shell/mcp/types.js';

export interface KernelConfig {
  readonly prodDatabaseUrl: string;
  readonly poolMax?: number;
  readonly dbSsl?: boolean;
  readonly meiliHost: string;
  readonly meiliApiKey: string;
  /** Search-only Meili key; falls back to `meiliApiKey` when unset. */
  readonly meiliSearchApiKey?: string;
  readonly opensearchUrl: string;
  readonly syntheticBaseUrl?: string;
  readonly syntheticApiKey?: string;
  readonly embeddingModel?: string;
  readonly chatModel?: string;
  readonly clientBaseUrl?: string;
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
  /** Meili indexes the global search queries by default. */
  readonly meiliIndexes?: readonly string[];
  /** Optional structured logger for boot-time warnings (e.g. Meili host unset). */
  readonly logger?: Logger;
}

export interface KernelClients {
  readonly meiliClient: MeiliClient;
  readonly openSearchClient: OpenSearchClient;
  readonly syntheticClient: SyntheticClient;
}

export interface Kernel {
  readonly db: ProdDb['db'];
  readonly pool: ProdDb['pool'];
  readonly identityRepo: IdentityRepo;
  readonly territoryRepo: TerritoryRepo;
  readonly flowsRepo: FlowsRepo;
  readonly searchRepo: SearchRepo;
  readonly documentRepo: DocumentRepo;
  readonly clients: KernelClients;
  readonly cache: KernelCache;
  readonly rateLimiter: RateLimiter;
  readonly contributors: ContributorRegistry;
  readonly searchCapabilities: CapabilityResolver;
  /** Register the legal module's act loader (kernel-owned port, §15.4). */
  registerLegalActLoader(loader: LegalActByIdLoader): void;
  legalActLoader(): LegalActByIdLoader | undefined;
  /** Per-request GraphQL DataLoaders keyed by CUI. */
  makeLoaders(): KernelLoaders;
  readonly entity360Deps: Entity360Deps;
  readonly globalSearchDeps: GlobalSearchDeps;
  readonly chatModel: string;
  /** Build the merged GraphQL SDL + resolvers from the base + module slices. */
  buildGraphql(slices: readonly GraphqlSlice[]): { typeDefs: string; resolvers: Record<string, unknown> };
  /** Build the MCP server from kernel + module-contributed tools. */
  buildMcpServer(moduleTools: readonly KernelMcpTool[]): ReturnType<typeof createKernelMcpServer>;
  /**
   * Build an HTTP JSON-RPC dispatcher over the MCP server (kernel + module
   * tools). Per-request server lifecycle; avoids the SDK's hono/socket bridge;
   * safe under Fastify + inject().
   */
  buildMcpDispatcher(moduleTools: readonly KernelMcpTool[]): McpHttpDispatcher;
  readonly mcpTools: readonly KernelMcpTool[];
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}

// The global entity search queries the single `entities` index (the scrapper's
// entity-grade contract). The legacy `['organizations','documents']` default is
// retired — `entities` is the prod toggle (search module plan, item 1).
const DEFAULT_MEILI_INDEXES = ['entities'] as const;

export const makeKernel = async (config: KernelConfig): Promise<Kernel> => {
  const { db, pool } = createProdDb({
    connectionString: config.prodDatabaseUrl,
    ...(config.poolMax !== undefined && { max: config.poolMax }),
    ...(config.dbSsl !== undefined && { ssl: config.dbSsl }),
  });

  const identityRepo = makeIdentityRepo(db);
  const territoryRepo = makeTerritoryRepo(db);
  const flowsRepo = makeFlowsRepo(db);
  const searchRepo = makeSearchRepo(db);
  const documentRepo = makeDocumentRepo(db);

  // Prefer the search-only key (read paths shouldn't carry the master key);
  // fall back to the general Meili key when no dedicated search key is set.
  if (config.meiliHost === '') {
    const log = config.logger ?? console;
    log.warn(
      { component: 'kernel.meili' },
      'PROD_MEILI_HOST is empty — global search will degrade to the Postgres fallback'
    );
  }
  const meiliClient = makeMeiliClient({
    host: config.meiliHost,
    apiKey: config.meiliSearchApiKey ?? config.meiliApiKey,
  });
  const openSearchClient = makeOpenSearchClient({ url: config.opensearchUrl });
  const syntheticClient = makeSyntheticClient({
    baseUrl: config.syntheticBaseUrl ?? '',
    apiKey: config.syntheticApiKey ?? '',
    ...(config.embeddingModel !== undefined && { embeddingModelOverride: config.embeddingModel }),
    ...(config.chatModel !== undefined && { chatModelOverride: config.chatModel }),
  });
  const clients: KernelClients = { meiliClient, openSearchClient, syntheticClient };

  const cache = createCache({
    ttlMs: config.cacheTtlMs ?? 60_000,
    maxEntries: config.cacheMaxEntries ?? 5_000,
  });
  const rateLimiter = createRateLimiter({ maxTokens: 30, windowMs: 60_000 });

  const contributors = createContributorRegistry();
  const searchCapabilities = await resolveCapabilities({ meiliClient, openSearchClient });

  let legalActLoader: LegalActByIdLoader | undefined;

  const entity360Deps: Entity360Deps = { identityRepo, flowsRepo, searchRepo, registry: contributors };
  const globalSearchDeps: GlobalSearchDeps = {
    meiliClient,
    identityRepo,
    searchRepo,
    meiliIndexes: config.meiliIndexes ?? [...DEFAULT_MEILI_INDEXES],
  };

  const chatModel = config.chatModel ?? 'auto';

  const mcpTools = makeKernelMcpTools({
    identityRepo,
    entity360Deps,
    clientBaseUrl: config.clientBaseUrl ?? 'https://transparenta.eu',
  });

  const health = async (): Promise<HealthReport> => {
    // Bound the whole probe so a hung dependency can't stall the liveness check.
    const withTimeout = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<ServiceStatus> => {
      const start = Date.now();
      const r = await Promise.race([
        fn(),
        new Promise<{ ok: boolean; error?: string }>((resolve) =>
          setTimeout(() => { resolve({ ok: false, error: 'health probe timeout' }); }, 4000)
        ),
      ]);
      const latencyMs = Date.now() - start;
      return r.ok ? { status: 'ok', latencyMs } : { status: 'error', latencyMs, error: r.error ?? '' };
    };
    const disabled: ServiceStatus = { status: 'disabled' };
    const configured = (v: string | undefined): boolean => v !== undefined && v !== '';

    const [postgres, meilisearch, opensearch, synthetic] = await Promise.all([
      withTimeout(async () => {
        try {
          await pool.query('select 1');
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'db error' };
        }
      }),
      configured(config.meiliHost)
        ? withTimeout(async () => {
            const r = await meiliClient.healthCheck();
            return r.isOk() ? { ok: true } : { ok: false, error: r.error.message };
          })
        : Promise.resolve(disabled),
      configured(config.opensearchUrl)
        ? withTimeout(async () => {
            const r = await openSearchClient.healthCheck();
            return r.isOk() ? { ok: true } : { ok: false, error: r.error.message };
          })
        : Promise.resolve(disabled),
      configured(config.syntheticBaseUrl)
        ? withTimeout(async () => {
            const r = await syntheticClient.healthCheck();
            return r.isOk() ? { ok: true } : { ok: false, error: r.error.message };
          })
        : Promise.resolve(disabled),
    ]);

    // Liveness: only postgres is critical (§14.11). Any CONFIGURED aux service
    // erroring → degraded; disabled aux services do not degrade.
    const auxDown = [meilisearch, opensearch, synthetic].some((s) => s.status === 'error');
    const overall: HealthReport['overall'] =
      postgres.status === 'ok' && !auxDown ? 'healthy' : 'degraded';

    return { overall, postgres, meilisearch, opensearch, synthetic };
  };

  return {
    db,
    pool,
    identityRepo,
    territoryRepo,
    flowsRepo,
    searchRepo,
    documentRepo,
    clients,
    cache,
    rateLimiter,
    contributors,
    searchCapabilities,
    registerLegalActLoader(loader: LegalActByIdLoader): void {
      legalActLoader = loader;
    },
    legalActLoader(): LegalActByIdLoader | undefined {
      return legalActLoader;
    },
    makeLoaders(): KernelLoaders {
      return makeKernelLoaders(identityRepo);
    },
    entity360Deps,
    globalSearchDeps,
    chatModel,
    buildGraphql(slices: readonly GraphqlSlice[]) {
      const merged = mergeGraphqlSlices(baseTypeDefs, slices);
      const resolvers = makeKernelResolvers({
        entity360Deps,
        globalSearchDeps,
        identityRepo,
        flowsRepo,
        searchRepo,
        registry: contributors,
        health,
        cache,
        rateLimiter,
      });
      return { typeDefs: merged.typeDefs, resolvers };
    },
    buildMcpDispatcher(moduleTools: readonly KernelMcpTool[]) {
      // Per-request server factory (MCP session state must not cross requests).
      return createMcpHttpDispatcher(() => createKernelMcpServer([...mcpTools, ...moduleTools]));
    },
    buildMcpServer(moduleTools: readonly KernelMcpTool[]) {
      return createKernelMcpServer([...mcpTools, ...moduleTools]);
    },
    mcpTools,
    health,
    async close(): Promise<void> {
      await db.destroy();
    },
  };
};

// Re-export the kernel public types modules depend on.
export * from './core/errors.js';
export * from './core/types.js';
export * from './core/pagination.js';
export * from './core/ports.js';
export * from './core/filters/index.js';
export { createContributorRegistry } from './core/usecases/registry.js';
export { makeEntity360, makeEntityProfileSlice, type Entity360, type Entity360Deps } from './core/usecases/entity-360.js';
export { makeGlobalSearch, type GlobalSearchDeps, type GlobalSearchResult } from './core/usecases/global-search.js';
export { makeAsk, type AskDeps, type AskInput, type AskResult } from './core/usecases/ask.js';
export type { ProdDatabase } from './shell/db/types.js';
export { mergeGraphqlSlices, KERNEL_BASE_TYPES, type GraphqlSlice } from './shell/graphql/merge.js';
export { baseTypeDefs } from './shell/graphql/typedefs.js';
export { scalarResolvers, scalarTypeDefs } from './shell/graphql/scalars.js';
export { makeBatchLoader, type BatchLoader } from './shell/graphql/dataloaders.js';
export type { KernelMcpTool, McpToolOutput } from './shell/mcp/types.js';
export { createMcpHttpDispatcher, type McpHttpDispatcher } from './shell/mcp/http-dispatch.js';
export { type KernelCache } from './shell/middleware/cache.js';
export { type RateLimiter } from './shell/middleware/rate-limiter.js';
// Diacritic folding (§15.7) — re-exported so modules don't reach into shell/repo.
export { foldDiacritics } from './shell/repo/fold.js';

/**
 * The minimal structured-logger contract modules accept (a pino `Logger` and
 * Fastify's `app.log` both satisfy it). Kernel-owned so each module doesn't
 * declare its own (legal's `LegalModuleLogger` can adopt this).
 */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}
