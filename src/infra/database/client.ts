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
 * Create a Kysely instance for a specific database URL
 */
const createClient = <T>(connectionString: string): Kysely<T> => {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new PG_POOL({
        connectionString,
        max: 10, // connection pool size
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
  const budgetUrl = database.budgetUrl ?? database.url;
  const userUrl = database.userUrl ?? database.url; // Fallback to same DB if not specified? Or throw?

  if (budgetUrl === undefined || budgetUrl === '') {
    throw new Error(
      'Missing configuration for Budget Database (BUDGET_DATABASE_URL or DATABASE_URL)'
    );
  }

  // If USER_DATABASE_URL is not provided, we might assume it's on the same DB instance
  // or simply not available. Given the requirement "allow access to different db",
  // we should instantiate it if possible.
  // If userUrl is missing, we can either throw or point to budgetUrl (if meant to be shared)
  // For safety, I'll throw if strictly no URL is found.
  if (userUrl === undefined || userUrl === '') {
    throw new Error('Missing configuration for User Database (USER_DATABASE_URL)');
  }

  const budgetDb = createClient<BudgetDatabase>(budgetUrl);
  const userDb = createClient<UserDatabase>(userUrl);

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
  NotificationDeliveries,
  UnsubscribeTokens,
  UserDatabase,
} from './user/types.js';
