/** Existing map lifecycle, isolated user storage and native-only source adapters. */
import {
  defaultAdvancedMapAnalyticsIdGenerator,
  makeAdvancedMapAnalyticsRepo,
  makeAdvancedMapAnalyticsRoutes,
  makeAdvancedMapAnalyticsGroupedSeriesRoutes,
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

import type { UserDbClient } from '../infra/database/client.js';
import type { InsReadSession } from '../modules/ins-native/index.js';
import type { ProdDatabase, RateLimiter } from '../modules/shared/index.js';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

export interface NativeMapRoutesDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly rateLimiter: RateLimiter;
  readonly userDb: UserDbClient;
  readonly authProvider: AuthProvider;
  readonly clerkSecretKey?: string;
  readonly budget: BudgetMapDeps;
  readonly createInsReadSession: () => InsReadSession;
}

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
  const groupedSeriesProvider = makeNativeMapSeriesProvider({
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
  });
  // Uploads can contain either supported keyspace; the selected view never rolls up arbitrary units.
  const uploadTerritories = async () => [
    ...(await territoryLookup('UAT')()),
    ...(await territoryLookup('County')()),
  ];
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      const limit = deps.rateLimiter.consume(`maps:${request.ip}`);
      if (!limit.allowed)
        await reply
          .code(429)
          .header('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))))
          .send({ ok: false, error: 'RateLimited', message: 'Too many map requests' });
    });
    scope.addHook('preHandler', makeAuthMiddleware({ authProvider: deps.authProvider }));
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
