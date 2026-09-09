import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { BudgetDatabase } from './budget/types.js';
import type { UserDatabase } from './user/types.js';
import type { AppConfig } from '../config/env.js';

const { Pool: PG_POOL } = pg;

export type BudgetDbClient = Kysely<BudgetDatabase>;
export type UserDbClient = Kysely<UserDatabase>;

export interface DatabaseClients {
  budgetDb: BudgetDbClient;
  userDb: UserDbClient;
}

/**
 * Pool-level statement bound for the legacy (Phoenix) pools. The repos call
 * `setStatementTimeout(this.db, …)` on a non-transaction instance, where
 * `SET LOCAL` is a no-op, so this is the only bound that actually applies.
 * It is the largest per-repo value in use (uat-analytics / county-analytics
 * request 45 s; everything else 10–30 s).
 */
export const LEGACY_STATEMENT_TIMEOUT_MS = 45_000;

/** pg Pool options shared by the three legacy pools (exported for the unit test). */
export const legacyPoolConfig = (
  connectionString: string,
  ssl: boolean,
  sslRejectUnauthorized: boolean
): pg.PoolConfig => ({
  connectionString,
  max: 10,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 60_000,
  statement_timeout: LEGACY_STATEMENT_TIMEOUT_MS,
  ...(ssl ? { ssl: { rejectUnauthorized: sslRejectUnauthorized } } : {}),
});

/**
 * Attach the listeners that keep a dropped connection from killing the
 * process. pg-pool removes its own idle error listener while a client is
 * checked out, and an idle client dropped by the network (a port-forward
 * especially) emits 'error' on the pool; without a listener Node treats it as
 * an unhandled 'error' event. pg has already discarded the client, so log and
 * continue. Never log the error/client objects: they can carry the connection
 * config.
 */
export const attachPoolErrorListeners = (
  pool: pg.Pool,
  name: string,
  // The message only, never the error object (it can carry the connection config).
  log: (message: string) => void = (message) => {
    console.error(message);
  }
): pg.Pool => {
  pool.on('connect', (client) => {
    client.on('error', () => {
      log(`[${name} pool] connection lost; active queries will fail`);
    });
  });
  pool.on('error', (error) => {
    log(`[${name} pool] idle client error (recovered): ${error.message}`);
  });
  return pool;
};

/**
 * Create a Kysely instance for a specific database URL
 */
const createClient = <T>(
  name: string,
  connectionString: string,
  ssl: boolean,
  sslRejectUnauthorized: boolean
): Kysely<T> => {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: attachPoolErrorListeners(
        new PG_POOL(legacyPoolConfig(connectionString, ssl, sslRejectUnauthorized)),
        name
      ),
    }),
  });
};

/**
 * Initialize database clients
 */
export const initDatabases = (config: AppConfig): DatabaseClients => {
  const { database } = config;

  // Determine connection strings
  // Prioritize specific URLs, fallback to generic DATABASE_URL, or throw if missing
  const { budgetUrl, userUrl, ssl, sslRejectUnauthorized } = database;

  const budgetDb = createClient<BudgetDatabase>('budget-db', budgetUrl, ssl, sslRejectUnauthorized);
  const userDb = createClient<UserDatabase>('user-db', userUrl, ssl, sslRejectUnauthorized);

  return {
    budgetDb,
    userDb,
  };
};

// Re-export types
export * from './budget/types.js';
export type {
  ShortLinks,
  Notifications,
  NotificationOutbox,
  NotificationEvents,
  NotificationSourceWatermarks,
  NotificationSubscriptions,
  NotificationGlobalPreferences,
  NotificationChannelPreferences,
  LogicalNotifications,
  NotificationChannelDestinations,
  NotificationDeliveries,
  NotificationDeliveryAttempts,
  NotificationDigestBatches,
  NotificationDigestMembers,
  NotificationAuditLog,
  UserDataAnonymizationAudit,
  UserDataEvents,
  UserDataIdempotencyReceipts,
  UserDataRecords,
  UserDatabase,
} from './user/types.js';
