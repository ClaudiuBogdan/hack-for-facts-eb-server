import path from 'node:path';

import { err, ok } from 'neverthrow';

import { CacheNamespace, initCache } from '@/infra/cache/index.js';
import { createConfig, parseEnv, type AppConfig } from '@/infra/config/index.js';
import { initDatabases, type DatabaseClients } from '@/infra/database/client.js';
import { makeEmailClient } from '@/infra/email/client.js';
import { createLogger } from '@/infra/logger/index.js';
import { makeEntityProfileRepo, makeEntityRepo } from '@/modules/entity/index.js';
import {
  makeInstitutionCorrespondenceRepo,
  makePublicDebateTemplateRenderer,
  createDatabaseError as createCorrespondenceDatabaseError,
} from '@/modules/institution-correspondence/index.js';
import {
  makeLearningProgressRepo,
  type ReviewDecision,
} from '@/modules/learning-progress/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  makeNotificationsRepo,
  sha256Hasher,
} from '@/modules/notifications/index.js';
import { prepareApprovedPublicDebateReviewSideEffects } from '@/modules/user-events/index.js';

import { makeLocalAdminEventBundleStore } from './filesystem/bundle-store.js';
import { startAdminEventRuntime } from './queue/runtime.js';
import { makeDefaultAdminEventRegistry } from './registry.js';

import type { AdminEventBundleStore, AdminEventQueuePort } from '../core/ports.js';
import type { AdminEventRegistry } from '../core/registry.js';
import type { Logger } from 'pino';

export interface AdminEventScriptContext {
  config: AppConfig;
  logger: Logger;
  databases: DatabaseClients;
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
  bundleStore: AdminEventBundleStore;
  defaultExportDir: string;
  close(): Promise<void>;
}

export const createAdminEventScriptContext = async (): Promise<AdminEventScriptContext> => {
  const env = parseEnv(process.env);
  const config = createConfig(env);
  const logger = createLogger({
    level: config.logger.level,
    name: 'admin-events-script',
    pretty: config.logger.pretty,
  });
  const databases = initDatabases(config);
  const { cache, keyBuilder, rawCache } = initCache({
    config: config.cache,
    logger,
  });
  const learningProgressRepo = makeLearningProgressRepo({
    db: databases.userDb,
    logger,
  });
  const correspondenceRepo = makeInstitutionCorrespondenceRepo({
    db: databases.userDb,
    logger,
  });

  const notificationsRepo = makeNotificationsRepo({
    db: databases.userDb,
    logger,
    campaignSubscriptionStatsInvalidator: {
      async invalidateCampaign(campaignId) {
        const key = keyBuilder.build(CacheNamespace.CAMPAIGN_SUBSCRIPTION_STATS, campaignId);
        await cache.delete(key);
      },
      async invalidateAll() {
        const prefix = keyBuilder.getPrefix(CacheNamespace.CAMPAIGN_SUBSCRIPTION_STATS);
        await cache.clearByPrefix(prefix);
      },
    },
  });
  const publicDebateSubscriptionService = {
    async ensureSubscribed(userId: string, entityCui: string) {
      const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo,
          hasher: sha256Hasher,
        },
        {
          userId,
          entityCui,
        }
      );

      if (subscriptionResult.isErr()) {
        return err(
          createCorrespondenceDatabaseError(
            'Failed to ensure public debate notification subscriptions',
            subscriptionResult.error
          )
        );
      }

      return ok(undefined);
    },
  };

  const prepareApproveLearningProgressReviews =
    config.email.enabled &&
    config.email.apiKey !== undefined &&
    config.email.apiKey !== '' &&
    config.email.funkyFromAddress !== undefined &&
    config.email.funkyFromAddress !== '' &&
    config.email.funkyReplyToAddress !== undefined &&
    config.email.funkyReplyToAddress !== ''
      ? async (input: { items: readonly ReviewDecision[] }) =>
          prepareApprovedPublicDebateReviewSideEffects(
            {
              learningProgressRepo,
              entityRepo: makeEntityRepo(databases.budgetDb),
              entityProfileRepo: makeEntityProfileRepo(databases.budgetDb),
              repo: correspondenceRepo,
              emailSender: makeEmailClient({
                apiKey: config.email.apiKey ?? '',
                fromAddress: config.email.funkyFromAddress ?? '',
                logger,
              }),
              templateRenderer: makePublicDebateTemplateRenderer(),
              auditCcRecipients: config.email.funkyFromAddressCcRecipients,
              platformBaseUrl: config.notifications.platformBaseUrl,
              captureAddress: config.email.funkyReplyToAddress ?? '',
              subscriptionService: publicDebateSubscriptionService,
            },
            input
          )
      : undefined;

  if (config.jobs.redisUrl === undefined || config.jobs.redisUrl === '') {
    throw new Error('BULLMQ_REDIS_URL is required for admin event scripts.');
  }

  const adminEventRuntime = await startAdminEventRuntime({
    redisUrl: config.jobs.redisUrl,
    bullmqPrefix: config.jobs.prefix,
    logger,
    ...(config.jobs.redisPassword !== undefined
      ? { redisPassword: config.jobs.redisPassword }
      : {}),
  });

  const registry = makeDefaultAdminEventRegistry({
    learningProgressRepo,
    institutionCorrespondenceRepo: correspondenceRepo,
    ...(prepareApproveLearningProgressReviews !== undefined
      ? { prepareApproveLearningProgressReviews }
      : {}),
  });
  const bundleStore = makeLocalAdminEventBundleStore();
  const defaultExportDir = path.resolve('.local/admin-events');

  return {
    config,
    logger,
    databases,
    registry,
    queue: adminEventRuntime.queue,
    bundleStore,
    defaultExportDir,
    async close() {
      await adminEventRuntime.stop();
      await rawCache.close?.();
      await Promise.all([
        databases.budgetDb.destroy(),
        databases.insDb.destroy(),
        databases.userDb.destroy(),
      ]);
    },
  };
};
