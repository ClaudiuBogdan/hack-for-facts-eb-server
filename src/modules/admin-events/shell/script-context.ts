import path from 'node:path';

import { createConfig, parseEnv, type AppConfig } from '@/infra/config/index.js';
import { initDatabases, type DatabaseClients } from '@/infra/database/client.js';
import { createLogger } from '@/infra/logger/index.js';
import { makeInstitutionCorrespondenceRepo } from '@/modules/institution-correspondence/index.js';

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
  const correspondenceRepo = makeInstitutionCorrespondenceRepo({
    db: databases.userDb,
    logger,
  });

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
    institutionCorrespondenceRepo: correspondenceRepo,
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
      await Promise.all([
        databases.budgetDb.destroy(),
        databases.insDb.destroy(),
        databases.userDb.destroy(),
      ]);
    },
  };
};
