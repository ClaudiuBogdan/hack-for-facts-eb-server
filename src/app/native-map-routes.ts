/** Existing map lifecycle, isolated user storage and native-only source adapters. */
import { createKeyBuilder } from '../infra/cache/index.js';
import {
  defaultAdvancedMapAnalyticsIdGenerator,
  makeAdvancedMapAnalyticsRepo,
  makeAdvancedMapAnalyticsRoutes,
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
  makeCachedGroupedSeriesProvider,
  makeNativeMapTerritoryLookup,
  makeNativeMapSeriesProvider,
} from '../modules/advanced-map-analytics/index.js';
import {
  defaultAdvancedMapDatasetIdGenerator,
  makeAdvancedMapDatasetsRepo,
  makeAdvancedMapDatasetRoutes,
  makeClerkAdvancedMapDatasetWritePermissionChecker,
} from '../modules/advanced-map-datasets/index.js';
import { makeAuthMiddleware, type AuthProvider } from '../modules/auth/index.js';
import {
  commitmentsMapValues,
  makeCommitmentsMapRepo,
  type BudgetMapDeps,
} from '../modules/budget/index.js';
import {
  createCache,
  createRateLimiter,
  type ProdDatabase,
  type RateLimiter,
  type RateLimiterConfig,
} from '../modules/shared/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { InsReadSession } from '../modules/ins-native/index.js';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

export interface NativeMapRoutesDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly rateLimiter: RateLimiter;
  /** Bucket for anonymous public map reads; defaults to `PUBLIC_MAP_READ_RATE_LIMIT`. */
  readonly publicReadRateLimiter?: RateLimiter;
  readonly userDb: UserDbClient;
  readonly authProvider: AuthProvider;
  readonly clerkSecretKey?: string;
  readonly budget: BudgetMapDeps;
  readonly createInsReadSession: () => InsReadSession;
}

const PUBLIC_MAP_READ_PREFIXES = [
  '/api/v1/advanced-map-analytics/public/',
  '/api/v1/advanced-map-datasets/public/',
] as const;
const PUBLIC_MAP_READ_PATHS = new Set(['/api/v1/advanced-map-datasets/public']);

/**
 * The three anonymous map reads (public dataset list, public dataset, public
 * map): GET/HEAD only, exact path or public prefix, query string ignored.
 * Mirrors the legacy global-auth bypass in build-app.ts for the same routes.
 * Exported for the unit test.
 */
export function isPublicNativeMapRead(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0] ?? url;
  return (
    PUBLIC_MAP_READ_PATHS.has(path) ||
    PUBLIC_MAP_READ_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** Public map reads get their own bucket: a viewer burst must not exhaust the write bucket, and vice versa. */
export const PUBLIC_MAP_READ_RATE_LIMIT: RateLimiterConfig = { maxTokens: 120, windowMs: 60_000 };
/** How long a public map view's grouped-series answer is served from memory. */
export const PUBLIC_MAP_RESULT_TTL_MS = 5 * 60_000;
const PUBLIC_MAP_RESULT_MAX_ENTRIES = 200;

/**
 * Which bucket a map request draws from: anonymous public reads share one
 * per-IP bucket sized for viewers; everything else (writes, owner reads)
 * keeps the kernel's per-IP bucket. Exported for the unit test.
 */
export const mapRateLimitKey = (
  method: string,
  url: string,
  ip: string
): { readonly bucket: 'public-read' | 'default'; readonly key: string } =>
  isPublicNativeMapRead(method, url)
    ? { bucket: 'public-read', key: `maps:public:${ip}` }
    : { bucket: 'default', key: `maps:${ip}` };

export async function registerNativeMapRoutes(
  app: FastifyInstance,
  deps: NativeMapRoutesDeps
): Promise<void> {
  const logger = app.log as Logger;
  const datasetRepo = makeAdvancedMapDatasetsRepo({ db: deps.userDb, logger });
  const repo = makeAdvancedMapAnalyticsRepo({ db: deps.userDb, logger });
  const secretKey = deps.clerkSecretKey?.trim();
  const writePermissionChecker =
    secretKey === undefined || secretKey === ''
      ? { canWrite: () => Promise.resolve(false) }
      : makeClerkAdvancedMapDatasetWritePermissionChecker({
          secretKey,
          permissionName: 'advanced_map:public_write',
          logger,
        });
  const territoryLookup = (granularity: 'UAT' | 'County') =>
    makeNativeMapTerritoryLookup(deps.db, granularity);
  const commitmentsRepo = makeCommitmentsMapRepo(deps.db);
  // Whole-request memo for the (identical-for-everyone) public map views;
  // uploaded-dataset requests bypass it inside the decorator (N/M2).
  const groupedSeriesProvider = makeCachedGroupedSeriesProvider({
    inner: makeNativeMapSeriesProvider({
      territoryLookup,
      datasetRepo,
      budget: deps.budget,
      readCommitments: (series, granularity) =>
        commitmentsMapValues(
          {
            repo: commitmentsRepo,
            factors: deps.budget.factors,
            population: deps.budget.population,
          },
          { filter: series.filter, metric: series.metric, granularity }
        ),
      createInsReadSession: deps.createInsReadSession,
    }),
    cache: createCache({
      ttlMs: PUBLIC_MAP_RESULT_TTL_MS,
      maxEntries: PUBLIC_MAP_RESULT_MAX_ENTRIES,
    }),
    keyBuilder: createKeyBuilder(),
  });
  const publicReadRateLimiter =
    deps.publicReadRateLimiter ?? createRateLimiter(PUBLIC_MAP_READ_RATE_LIMIT);
  // Uploads can contain either supported keyspace; the selected view never rolls up arbitrary units.
  const uploadTerritories = async () => [
    ...(await territoryLookup('UAT')()),
    ...(await territoryLookup('County')()),
  ];
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      const { bucket, key } = mapRateLimitKey(request.method, request.url, request.ip);
      const limit = (bucket === 'public-read' ? publicReadRateLimiter : deps.rateLimiter).consume(
        key
      );
      if (!limit.allowed)
        await reply
          .code(429)
          .header('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))))
          .send({ ok: false, error: 'RateLimited', message: 'Too many map requests' });
    });
    // The public map reads are anonymous by contract (the legacy app exempts
    // exactly these paths from provider verification), so an expired or foreign
    // bearer on them must not turn a public GET into a 401.
    const authenticate = makeAuthMiddleware({ authProvider: deps.authProvider });
    scope.addHook('preHandler', async function (this: FastifyInstance, request, reply) {
      if (isPublicNativeMapRead(request.method, request.url)) return;
      await authenticate.call(this, request, reply);
    });
    await scope.register(
      makeAdvancedMapDatasetRoutes({
        repo: datasetRepo,
        territoryLookup: uploadTerritories,
        idGenerator: defaultAdvancedMapDatasetIdGenerator,
        writePermissionChecker,
      })
    );
    await scope.register(
      makeAdvancedMapAnalyticsRoutes({
        repo,
        datasetRepo,
        groupedSeriesProvider,
        idGenerator: defaultAdvancedMapAnalyticsIdGenerator,
        publicWritePermissionChecker: writePermissionChecker,
      })
    );
    await scope.register(makeAdvancedMapAnalyticsGroupedSeriesRoutes({ groupedSeriesProvider }));
  });
}
