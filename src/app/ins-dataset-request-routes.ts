import rateLimit from '@fastify/rate-limit';

import { addEmbeddedScopeAuth } from './embedded-scope-auth.js';
import { registerUserRouteErrorHandler } from './user-route-error-handler.js';
import {
  makeInsDatasetRequestRepo,
  makeInsDatasetRequestRoutes,
  makeInsNativeDatasetCatalogReader,
  type InsReadSession,
} from '../modules/ins-native/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { AuthProvider } from '../modules/auth/index.js';
import type { FastifyInstance } from 'fastify';

export interface InsDatasetRequestRoutesDeps {
  readonly userDb: UserDbClient;
  readonly authProvider?: AuthProvider;
  /** Whether the embedder's Clerk `user.deleted` receiver is wired (see the route). */
  readonly userDeletionHandlerConfigured: boolean;
  readonly createInsReadSession: () => InsReadSession;
  readonly installRateLimit?: boolean;
}

export async function registerInsDatasetRequestRoutes(
  app: FastifyInstance,
  deps: InsDatasetRequestRoutesDeps
): Promise<void> {
  await app.register(async (scope) => {
    if (deps.installRateLimit === true) {
      await scope.register(rateLimit, { global: false });
      registerUserRouteErrorHandler(scope);
    }
    // The endpoint is public by contract; this hook attaches a verified caller
    // (or refuses a garbage bearer) so an authenticated submission can carry its
    // Clerk user id. On api.js the legacy root auth hook runs after it too and
    // re-verifies the same bearer (a cache hit) — the scope hook is what makes
    // the route self-sufficient on a server without that root hook.
    addEmbeddedScopeAuth(scope, deps.authProvider, () => false);
    await scope.register(
      makeInsDatasetRequestRoutes({
        datasetRequestRepo: makeInsDatasetRequestRepo(deps.userDb),
        datasetCatalog: makeInsNativeDatasetCatalogReader(deps.createInsReadSession),
        userDeletionHandlerConfigured: deps.userDeletionHandlerConfigured,
      })
    );
  });
}
