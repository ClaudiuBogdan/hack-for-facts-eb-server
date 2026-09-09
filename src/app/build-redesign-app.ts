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

import compressPlugin from '@fastify/compress';
import corsPlugin from '@fastify/cors';
import { makeExecutableSchema } from '@graphql-tools/schema';
import fastifyLib, { type FastifyInstance, type FastifyReply } from 'fastify';
import mercuriusPlugin from 'mercurius';

import { registerInsDatasetRequestRoutes } from './ins-dataset-request-routes.js';
import { makeInsGraphqlLifecycle } from './ins-graphql-session.js';
import { registerNativeMapRoutes } from './native-map-routes.js';
import { publicHealthReport } from './public-health.js';
import {
  makeGraphQLErrorFormatter,
  makeGraphQLValidationRules,
} from '../infra/graphql/security.js';
import { makeGraphQLContext, type AuthProvider } from '../modules/auth/index.js';
import {
  makeBudgetModule,
  makeBudgetMapRepo,
  makeNativeBudgetFactors,
  makeNativeMapPopulation,
  type BudgetMapPopulationSource,
  makeFactorSetSource,
  LEGACY_FACTOR_SET_ID,
  LEGACY_FACTOR_SET_DIGEST,
} from '../modules/budget/index.js';
import { makeClerkUserDeletionRoutes } from '../modules/clerk-webhooks/index.js';
import { makeCompaniesModule } from '../modules/companies/index.js';
import { makeDbHealthChecker } from '../modules/health/index.js';
import { makeInsNativeModule, type InsReadSession } from '../modules/ins-native/index.js';
import { makeJudicialModule } from '../modules/judicial/index.js';
import { makeLegalModule } from '../modules/legal/index.js';
import { makeFactorSetReader } from '../modules/normalization/index.js';
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
  type KernelMcpResource,
  type KernelMcpTool,
  type AnnualPopulationPort,
  type RateLimiter,
} from '../modules/shared/index.js';

import type {
  LegalSearchComposition,
  ProcurementComposition,
} from '../infra/config/redesign-env.js';
import type { TrustProxySetting } from '../infra/config/trust-proxy.js';
import type { UserDatabase } from '../infra/database/user/types.js';
import type { AgentModuleConfig, QuotaRedis } from '../modules/agent/index.js';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

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
   * Source modules to wire into the kernel. The shared defaults (standalone and
   * embedded alike) include native INS. Pass `[]` to boot the bare kernel.
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
    /** The Chronos-reading INS module (program slice 3.2), in the shared defaults. */
    | 'ins-native'
  )[];
  /** Disable procurement's fire-and-forget preload for isolated cold benchmarks. */
  readonly procurementWarmCache?: boolean;
  /** Procurement composition (ClickHouse, record-list search, DA window), validated by the entrypoint. */
  readonly procurement?: ProcurementComposition;
  /** Legal search engine connection, validated by the entrypoint. */
  readonly legalSearch?: LegalSearchComposition;
  /** Fastify `trustProxy` (default true: the process sits behind the gateway). */
  readonly trustProxy?: TrustProxySetting;
  /** When set, mounts the authenticated agent surface at /api/v1/agent. */
  readonly agent?: RedesignAgentDeps;
  /**
   * When set, the GraphQL surface builds an auth context (bearer verification
   * via the auth module) so resolvers can distinguish authenticated callers
   * (first consumer: Company.administrators). The surface STAYS public: an
   * absent or invalid token yields the anonymous context, never a rejection —
   * same rule as the legacy GraphQL. Absent on the standalone redesign server,
   * where every caller is anonymous.
   */
  readonly authProvider?: AuthProvider;
  readonly userData?: {
    readonly db: Kysely<UserDatabase>;
    readonly signingSecret: string;
    readonly clerkSecretKey?: string;
  };
  /**
   * The user store of an EMBEDDING composer that owns the user DB and its Clerk
   * webhook receiver — the legacy `api.js` (slice 1 commits 4–5). The surface
   * registers the user-facing features that read the kernel and write the user
   * DB over it: the native map routes (saved maps, uploaded datasets) and the
   * INS dataset requests. It registers no `user.deleted` receiver (the
   * embedder's `/api/v1/webhooks/clerk` would collide) and no `destroy()` on
   * close (the embedder owns the pool). `userData` implies the map store on the
   * standalone server; when both are given, `embeddedUserStore` wins for the
   * map store and `userData` keeps its receiver. INS dataset requests are
   * registered for the embedder only (slice 2 brings them to the standalone
   * server with its user DB).
   */
  readonly embeddedUserStore?: {
    readonly userDb: Kysely<UserDatabase>;
    readonly clerkSecretKey?: string;
    /** `false` when the embedder's own global limiter is the only owner limit. */
    readonly ownerRateLimiter?: RateLimiter | false;
    /** Whether the embedder's Clerk `user.deleted` receiver is wired. */
    readonly userDeletionHandlerConfigured: boolean;
  };
  readonly mapPopulation?: BudgetMapPopulationSource;
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

// The legacy embedded surface supplies its interim INS roots separately.
const SHARED_DEFAULT_MODULES = [
  'pnrr',
  'reference',
  'budget',
  'companies',
  'legal',
  'parliament',
  'judicial',
  'procurement',
  'primarii-transparency',
  // The INS kernel module is part of every composition since X/F6: `budget`
  // reads population through its port, so a default without it cannot boot.
  'ins-native',
] as const;

export const buildRedesignApp = async (deps: BuildRedesignAppDeps): Promise<RedesignApp> => {
  const app = fastifyLib({
    logger: { level: deps.logLevel ?? 'info' },
    disableRequestLogging: true,
    // Rate limits and logs key on the client IP; behind the gateway that means
    // trusting X-Forwarded-For (X/F15). Off only for a directly exposed process.
    trustProxy: deps.trustProxy ?? true,
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

  try {
    const kernel = await registerRedesignSurface(app, {
      ...deps,
      modules: deps.modules ?? SHARED_DEFAULT_MODULES,
    });
    return { app, kernel };
  } catch (error) {
    // The caller cannot close an app that construction never returned.
    await app.close().catch(() => {
      app.log.error('Failed to close incomplete native app');
    });
    throw error;
  }
};

/**
 * Register response compression app-wide.
 *
 * WHY HERE. Compression belongs at the app layer, not inside a route: it is an
 * `onSend` transform that must apply to every JSON response (a full sitting
 * transcript, a big GraphQL result), negotiate `Accept-Encoding` per request, and
 * leave `ETag` a representation-level validator that stays valid for every encoding.
 * A route that gzipped its own buffer would break both the negotiation and the 304
 * path.
 *
 * `@fastify/compress` is a declared, locked runtime dependency. A missing install
 * must fail the build/boot instead of quietly serving large transcript responses
 * uncompressed.
 *
 * EXPORTED so a test can register the REAL plugin with the REAL options on a bare
 * Fastify scope — proving both that a large response is actually gzipped app-wide and
 * that no route compresses on its own (see
 * `tests/integration/redesign-compression.test.ts`). Booting the whole redesign app
 * would need a live kernel/postgres, which a unit-level gate must not require.
 */
export const registerCompression = async (app: FastifyInstance): Promise<void> => {
  await app.register(compressPlugin, {
    // Compress JSON/text only, and only when it is worth the CPU. 1 KiB is the
    // conventional floor: below it the framing overhead can exceed the saving.
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
    // Never rewrite an already-encoded payload.
    inflateIfDeflated: false,
  });
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
  // Registered FIRST so its onSend hook wraps every route declared below (Fastify
  // hooks are inherited by routes registered after the plugin, not before).
  await registerCompression(app);

  const kernel = await makeKernel(deps.kernelConfig);

  // Release the kernel (pg pool + clients) when the owning scope closes.
  // Registered right after creation — BEFORE the wiring below — so that if any
  // step throws (the legacy mount catches it and continues legacy-only), the pool
  // is still owned by this scope and freed on `app.close()` rather than leaking.
  app.addHook('onClose', async () => {
    await kernel.close();
  });

  const userDataHealth =
    deps.userData === undefined
      ? undefined
      : makeDbHealthChecker(deps.userData.db, { name: 'user-database' });
  if (deps.userData !== undefined) {
    const userDb = deps.userData.db;
    app.addHook('onClose', async () => {
      await userDb.destroy();
    });
    if (deps.authProvider === undefined)
      throw new Error('User data requires configured authentication');
    // Verify required tombstone storage before registering the deletion receiver.
    await userDb.selectFrom('userdataanonymizationaudit').select('user_id_hash').limit(0).execute();
    await app.register(
      makeClerkUserDeletionRoutes({
        db: userDb,
        signingSecret: deps.userData.signingSecret,
        logger: app.log as Logger,
      })
    );
  }

  // ── Source modules (built on the kernel) ─────────────────────────────────────
  // Each module augments ProdDatabase, contributes a GraphQL slice + MCP tools,
  // and registers a SourceContributor. Order is data-independent EXCEPT parliament,
  // which reads the legal-registered `legalActLoader` for its bill↔act link — so
  // parliament is wired AFTER legal (it degrades to null if legal is disabled).
  // legal is wired before parliament + judicial (both read the legal-registered
  // `legalActLoader`); judicial's SDL references LegalAct, so legal must be in the
  // set whenever judicial is.
  const enabledModules = deps.modules ?? SHARED_DEFAULT_MODULES;
  const moduleSlices: GraphqlSlice[] = [];
  const moduleResolvers: Record<string, unknown>[] = [];
  const moduleMcpTools: KernelMcpTool[] = [];
  const moduleMcpResources: KernelMcpResource[] = [];
  let pnrrRestPlugin: import('fastify').FastifyPluginAsync | undefined;
  let parliamentRoutes: import('fastify').FastifyPluginAsync | undefined;
  let legalRoutes: import('fastify').FastifyPluginAsync | undefined;

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
    pnrrRestPlugin = pnrr.restPlugin;
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

  // INS first: its population port is what the budget module's native
  // adapters read through (X/F6). INS context uses the full canonical
  // geographic anchor, including county/NUTS level.
  let createInsSession: (() => InsReadSession) | undefined;
  let insPopulation: AnnualPopulationPort | undefined;
  if (enabledModules.includes('ins-native')) {
    const insNative = makeInsNativeModule({
      db: kernel.db,
      registry: kernel.contributors,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
      territoryForCui: (cui) => kernel.identityRepo.territoryForCui(cui),
    });
    createInsSession = insNative.createReadSession;
    insPopulation = insNative.population;
    kernel.contributors.register(insNative.contributor);
    moduleSlices.push(insNative.graphqlSlice);
    moduleResolvers.push(insNative.graphqlResolvers);
    moduleMcpTools.push(...insNative.mcpTools);
  }
  const nativeBudgetFactors = makeNativeBudgetFactors(kernel.db);
  if (enabledModules.includes('budget')) {
    // The kernel build serves budget ONLY with the native composition: exact-
    // year population through the INS port and the promoted factor set. A
    // budget without `ins-native` would silently fall back to the legacy set-1
    // composition (review N/N6/N7), so it is a configuration error, not a mode.
    if (insPopulation === undefined) {
      throw new Error(
        "module 'budget' requires 'ins-native' on the kernel build: its population port and native factors are mandatory"
      );
    }
    // Normalization Phase A: set 1 is the immutable snapshot of the legacy YAML.
    // Explicit internal pin: promotion/current-pointer changes cannot change
    // legacy calculations before the release policy and parity gates land.
    const legacyFactors = makeFactorSetSource(
      makeFactorSetReader(kernel.db),
      LEGACY_FACTOR_SET_ID,
      LEGACY_FACTOR_SET_DIGEST
    );
    const budget = makeBudgetModule({
      db: kernel.db,
      native: { population: insPopulation, factors: nativeBudgetFactors },
      registry: kernel.contributors,
      legacyFactors,
      logger: app.log,
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(budget.contributor);
    moduleSlices.push(budget.graphqlSlice);
    moduleResolvers.push(budget.graphqlResolvers);
    moduleMcpTools.push(...budget.mcpTools);
    moduleMcpResources.push(...budget.mcpResources);
  }
  const mapStore =
    deps.embeddedUserStore ??
    (deps.userData === undefined
      ? undefined
      : {
          userDb: deps.userData.db,
          ...(deps.userData.clerkSecretKey === undefined
            ? {}
            : { clerkSecretKey: deps.userData.clerkSecretKey }),
        });
  // Auth is optional here: an embedder with authentication disabled still
  // serves the public map reads while the owner-only operations fail closed.
  if (
    mapStore !== undefined &&
    enabledModules.includes('budget') &&
    createInsSession !== undefined
  ) {
    await registerNativeMapRoutes(app, {
      db: kernel.db,
      // Map traffic gets its own buckets (native-map-routes.ts), not the kernel's
      // 30/min search bucket; an embedder may switch the owner bucket off.
      ...(deps.embeddedUserStore?.ownerRateLimiter === undefined
        ? {}
        : { rateLimiter: deps.embeddedUserStore.ownerRateLimiter }),
      userDb: mapStore.userDb,
      ...(deps.authProvider === undefined ? {} : { authProvider: deps.authProvider }),
      ...(mapStore.clerkSecretKey === undefined ? {} : { clerkSecretKey: mapStore.clerkSecretKey }),
      createInsReadSession: createInsSession,
      budget: {
        repo: makeBudgetMapRepo(kernel.db),
        factors: nativeBudgetFactors,
        // Both source pins are rechecked per read; unsupported years remain unavailable.
        population:
          deps.mapPopulation ??
          (insPopulation !== undefined
            ? makeNativeMapPopulation(insPopulation)
            : (() => {
                throw new Error('native map routes require the ins-native population port');
              })()),
      },
    });
  }
  if (deps.embeddedUserStore !== undefined && createInsSession === undefined)
    app.log.warn(
      'embeddedUserStore given without the ins-native module: INS dataset requests and native maps are NOT registered'
    );
  if (deps.embeddedUserStore !== undefined && createInsSession !== undefined) {
    await registerInsDatasetRequestRoutes(app, {
      userDb: deps.embeddedUserStore.userDb,
      ...(deps.authProvider === undefined ? {} : { authProvider: deps.authProvider }),
      userDeletionHandlerConfigured: deps.embeddedUserStore.userDeletionHandlerConfigured,
      createInsReadSession: createInsSession,
    });
  }

  if (enabledModules.includes('procurement')) {
    // Composition settings come validated from the entrypoint (X/F13): the
    // ClickHouse analytics backend, the per-grain OpenSearch index map for
    // record lists, and the DA list window. Nothing here reads process.env.
    const composition = deps.procurement ?? {};
    const procurement = makeProcurementModule({
      db: kernel.db,
      logger: app.log,
      ...(composition.search !== undefined && {
        opensearch: {
          url: composition.search.url,
          indexes: composition.search.indexes,
          ...(composition.search.username !== undefined && {
            username: composition.search.username,
          }),
          ...(composition.search.password !== undefined && {
            password: composition.search.password,
          }),
          ...(composition.search.caFile !== undefined && {
            caCert: readFileSync(composition.search.caFile, 'utf8'),
          }),
          ...(composition.search.tlsServername !== undefined && {
            tlsServername: composition.search.tlsServername,
          }),
        },
      }),
      ...(composition.clickhouse !== undefined && { clickhouse: composition.clickhouse }),
      ...(deps.procurementWarmCache !== undefined && { warmCache: deps.procurementWarmCache }),
      ...(composition.daListMaxWindowDays !== undefined && {
        daListMaxWindowDays: composition.daListMaxWindowDays,
      }),
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    moduleSlices.push(procurement.graphqlSlice);
    moduleResolvers.push(procurement.graphqlResolvers);
    moduleMcpTools.push(...procurement.mcpTools);
    kernel.contributors.register(procurement.contributor);
  }

  if (enabledModules.includes('companies')) {
    const companies = makeCompaniesModule({
      db: kernel.db,
      registry: kernel.contributors,
      flowsRepo: kernel.flowsRepo,
      meili: kernel.clients.meiliClient,
      // Same resolution as the kernel's global search (global-search.ts):
      // first configured index, `entities` by default.
      meiliEntitiesIndex: deps.kernelConfig.meiliIndexes?.[0] ?? 'entities',
      ...(deps.clientBaseUrl !== undefined && { clientBaseUrl: deps.clientBaseUrl }),
    });
    kernel.contributors.register(companies.contributor);
    moduleSlices.push(companies.graphqlSlice);
    moduleResolvers.push(companies.graphqlResolvers);
    moduleMcpTools.push(...companies.mcpTools);
  }

  if (enabledModules.includes('legal')) {
    // The legal search engine connection comes validated from the entrypoint
    // (X/F13); present only when an acts or sections alias is named.
    const legalSearch = deps.legalSearch;
    const embedRes = await kernel.clients.syntheticClient.discoverEmbeddingModel();
    const embeddingModel = embedRes.isOk() ? embedRes.value : 'nomic-embed-text-v1.5';
    const legal = await makeLegalModule({
      db: kernel.db,
      ...(legalSearch !== undefined && {
        searchEngine: {
          url: legalSearch.url,
          ...(legalSearch.actsIndex !== undefined && { actsIndex: legalSearch.actsIndex }),
          ...(legalSearch.sectionsIndex !== undefined && {
            sectionsIndex: legalSearch.sectionsIndex,
          }),
          ...(legalSearch.username !== undefined && { username: legalSearch.username }),
          ...(legalSearch.password !== undefined && { password: legalSearch.password }),
          ...(legalSearch.caFile !== undefined && {
            caCert: readFileSync(legalSearch.caFile, 'utf8'),
          }),
          ...(legalSearch.tlsServername !== undefined && {
            tlsServername: legalSearch.tlsServername,
          }),
        },
      }),
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
    // The cacheable TLDF render routes (ETag / If-None-Match / Cache-Control on
    // a large immutable-per-generation artifact — the parliament-transcript
    // pattern). GraphQL carries only `LegalDocument.render` availability.
    legalRoutes = legal.routesPlugin;
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
    // The ONE REST route on the redesign surface: the cacheable canonical
    // full-transcript read. Registered here (not in the GraphQL/MCP block above)
    // because it needs its own path prefix; it serves the SAME usecase output as the
    // `parliamentStenogramSession` GraphQL root, and adds ETag / If-None-Match / 304
    // + Cache-Control, which a POSTed GraphQL query cannot express. Deferred to the
    // end of the module wiring so a route registration failure cannot prevent the
    // GraphQL slice from being collected.
    parliamentRoutes = parliament.routesPlugin;
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

  const authContext =
    deps.authProvider === undefined
      ? undefined
      : makeGraphQLContext({ authProvider: deps.authProvider });
  const insLifecycle =
    createInsSession === undefined
      ? undefined
      : makeInsGraphqlLifecycle(app, createInsSession, authContext);
  const graphqlContext = insLifecycle?.context ?? authContext;

  await app.register(mercuriusPlugin, {
    schema,
    path: '/api/v1/graphql',
    graphiql: deps.enableGraphiQL ?? !isProduction,
    allowBatchedQueries: false,
    validationRules: makeGraphQLValidationRules(isProduction),
    errorFormatter: makeGraphQLErrorFormatter(isProduction),
    ...(graphqlContext !== undefined && { context: graphqlContext }),
  });
  insLifecycle?.registerHooks();

  if (pnrrRestPlugin !== undefined) {
    await app.register(pnrrRestPlugin, { prefix: '/api/v1/pnrr' });
  }
  // Parliament's only REST route: the cacheable canonical full-transcript read.
  // It serves the SAME usecase output as the `parliamentStenogramSession` GraphQL
  // root and the `get_parliament_stenogram_session` MCP tool, and adds the HTTP
  // caching semantics (ETag / If-None-Match → 304 / Cache-Control) that a POSTed
  // GraphQL query cannot express. Any compression registered on this app applies
  // unchanged — the route sends a plain payload and only sets Vary: Accept-Encoding.
  if (parliamentRoutes !== undefined) {
    await app.register(parliamentRoutes, { prefix: '/api/v1/parliament' });
  }
  // Legal's REST routes: the TLDF render document/chunk reads (same cacheable
  // pattern; the body never travels over GraphQL).
  if (legalRoutes !== undefined) {
    await app.register(legalRoutes, { prefix: '/api/v1/legal' });
  }

  // ── MCP (JSON-RPC over HTTP) ─────────────────────────────────────────────────
  // Direct JSON-RPC dispatch (no SDK hono/socket bridge, which crashes under
  // Fastify with `socket.destroySoon is not a function`). Works under a real
  // listen and inject() alike.
  const mcpDispatcher = kernel.buildMcpDispatcher(
    [...moduleMcpTools, ...(deps.mcpTools ?? [])],
    moduleMcpResources
  );

  // The route is anonymous until per-user MCP auth lands, so it gets the same
  // per-IP token bucket the searchEntities resolver uses (namespaced key, so
  // the budgets don't collide). One host turn is a handful of requests
  // (initialize, tools/list, tools/call, resources/read), well inside the
  // bucket; shared egress IPs (ChatGPT) may need tuning under real traffic.
  app.post('/api/v1/mcp', async (request, reply) => {
    const limit = kernel.rateLimiter.consume(`mcp:${request.ip}`);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))))
        .send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Rate limit exceeded — retry later' },
        });
    }
    const response = await mcpDispatcher.dispatch(request.body);
    if (response === null) return reply.code(202).send();
    return reply.code(200).send(response);
  });

  // Streamable HTTP: a client MAY issue GET (server→client SSE stream) or
  // DELETE (session teardown). A stateless JSON server answers 405, not 404.
  const methodNotAllowed = async (_request: unknown, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send();
  app.get('/api/v1/mcp', methodNotAllowed);
  app.delete('/api/v1/mcp', methodNotAllowed);

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

  const publicUserDataHealth = async () => {
    const check = await userDataHealth?.();
    // Public status excludes the checker's database error message and connection details.
    return check === undefined ? undefined : { status: check.status, latencyMs: check.latencyMs };
  };

  // ── Health / readiness ───────────────────────────────────────────────────────
  // Liveness must not touch a dependency: the kernel probe bounds each check at
  // 4 s and the user-DB checker at 3 s, longer than a kubelet probe timeout, so a
  // hung Meili/OpenSearch or a saturated pool would restart a healthy process.
  // Kubernetes startup/liveness probes point here; `/api/v1/health` stays as the
  // dependency report and `/api/v1/ready` as the traffic gate.
  app.get('/api/v1/live', { logLevel: 'silent' }, async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  // The public bodies carry status + latency + a coded reason; the raw
  // dependency error (driver message, host names, TLS details) goes to the log
  // only (X/F14).
  const publicReport = async () => {
    const [report, userDatabase] = await Promise.all([kernel.health(), publicUserDataHealth()]);
    const { publicReport: sanitized, detail } = publicHealthReport(report);
    if (detail.length > 0) app.log.warn({ dependencies: detail }, 'dependency health errors');
    return { report: sanitized, userDatabase, postgresOk: report.postgres.status === 'ok' };
  };
  app.get('/api/v1/health', async (_request, reply) => {
    const { report, userDatabase } = await publicReport();
    // Dependency report never hard-fails on aux down (§14.11); always 200.
    return reply.code(200).send({ ...report, ...(userDatabase !== undefined && { userDatabase }) });
  });

  app.get('/api/v1/ready', { logLevel: 'silent' }, async (_request, reply) => {
    const { report, userDatabase, postgresOk } = await publicReport();
    const ready = postgresOk && (userDatabase === undefined || userDatabase.status === 'healthy');
    return reply
      .code(ready ? 200 : 503)
      .send({ ready, ...report, ...(userDatabase !== undefined && { userDatabase }) });
  });

  return kernel;
};
