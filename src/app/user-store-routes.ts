import rateLimit from '@fastify/rate-limit';

import { addEmbeddedScopeAuth } from './embedded-scope-auth.js';
import { registerUserRouteErrorHandler } from './user-route-error-handler.js';
import { makeUnsubscribeTokenSigner } from '../infra/unsubscribe/token.js';
import {
  makeDeliveriesRepo,
  makeNotificationRoutes,
  makeNotificationsRepo,
  sha256Hasher,
} from '../modules/notifications/index.js';
import {
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_DAILY_LIMIT,
  cryptoHasher,
  makeShareRoutes,
  makeShortLinkRepo,
  noopCache,
} from '../modules/share/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { AuthProvider } from '../modules/auth/index.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

interface UserStoreRoutesDeps {
  readonly db: UserDbClient;
  readonly authProvider: AuthProvider | undefined;
  readonly publicClientUrl?: string;
  readonly allowedOrigins: readonly string[];
  readonly unsubscribeHmacSecret?: string;
}

export async function registerUserStoreRoutes(
  app: FastifyInstance,
  deps: UserStoreRoutesDeps
): Promise<void> {
  const { db, authProvider, unsubscribeHmacSecret, publicClientUrl } = deps;
  const logger = app.log as Logger;
  await app.register(async (scope) => {
    registerUserRouteErrorHandler(scope);
    addEmbeddedScopeAuth(scope, authProvider, (method, url) => {
      const path = url.split('?', 1)[0] ?? '';
      return (
        path.startsWith('/api/v1/notifications/unsubscribe/') ||
        ((method === 'GET' || method === 'HEAD') && path.startsWith('/api/v1/short-links/'))
      );
    });
    await scope.register(rateLimit, { max: 300, timeWindow: '1 minute' });

    if (publicClientUrl !== undefined) {
      await scope.register(
        makeShareRoutes({
          shortLinkRepo: makeShortLinkRepo({ db, logger }),
          cache: noopCache,
          hasher: cryptoHasher,
          config: {
            allowedOrigins: [...deps.allowedOrigins],
            publicBaseUrl: publicClientUrl,
            dailyLimit: DEFAULT_DAILY_LIMIT,
            cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
          },
        })
      );
    }

    if (unsubscribeHmacSecret !== undefined) {
      await scope.register(
        makeNotificationRoutes({
          notificationsRepo: makeNotificationsRepo({ db, logger }),
          deliveriesRepo: makeDeliveriesRepo({ db, logger }),
          tokenSigner: makeUnsubscribeTokenSigner(unsubscribeHmacSecret),
          hasher: sha256Hasher,
        })
      );
    }
  });
}
