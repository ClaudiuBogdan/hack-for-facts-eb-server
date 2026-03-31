import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { BudgetDatabase } from './budget/types.js';
import type { InsDatabase } from './ins/types.js';
import type { UserDatabase } from './user/types.js';
import type { AppConfig } from '../config/env.js';

const { Pool: PG_POOL } = pg;

export type BudgetDbClient = Kysely<BudgetDatabase>;
export type InsDbClient = Kysely<InsDatabase>;
export type UserDbClient = Kysely<UserDatabase>;

export interface DatabaseClients {
  budgetDb: BudgetDbClient;
  insDb: InsDbClient;
  userDb: UserDbClient;
}

/**
 * Create a Kysely instance for a specific database URL
 */
const createClient = <T>(
  connectionString: string,
  ssl: boolean,
  sslRejectUnauthorized: boolean
): Kysely<T> => {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new PG_POOL({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 30_000,
        idleTimeoutMillis: 60_000,
        ...(ssl ? { ssl: { rejectUnauthorized: sslRejectUnauthorized } } : {}),
      }),
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
  const { budgetUrl, insUrl, userUrl, ssl, sslRejectUnauthorized } = database;

  const budgetDb = createClient<BudgetDatabase>(budgetUrl, ssl, sslRejectUnauthorized);
  const insDb = createClient<InsDatabase>(insUrl, ssl, sslRejectUnauthorized);
  const userDb = createClient<UserDatabase>(userUrl, ssl, sslRejectUnauthorized);

  return {
    budgetDb,
    insDb,
    userDb,
  };
};

// Re-export types
export * from './budget/types.js';
export type { InsDatabase } from './ins/types.js';
export type { ShortLinks, Notifications, NotificationOutbox, UserDatabase } from './user/types.js';
