/**
 * Reconcile pending learning-progress interactions that were missed by the
 * post-sync auto-review reuse hook.
 *
 * Usage:
 *   pnpm learning-progress:auto-review-reuse:reconcile
 *   pnpm learning-progress:auto-review-reuse:reconcile --limit=50
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { createLogger, type LogLevel, type Logger } from '../src/infra/logger/index.js';
import {
  makeLearningProgressRepo,
  reconcileAutoReviewReuse,
} from '../src/modules/learning-progress/index.js';

import type { UserDatabase } from '../src/infra/database/user/types.js';

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const { Pool } = pg;

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const parseBatchLimit = (): number => {
  const limitArg = getArgValue('--limit');
  if (limitArg === undefined) {
    return DEFAULT_BATCH_LIMIT;
  }

  const parsedLimit = Number.parseInt(limitArg, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_BATCH_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${String(MAX_BATCH_LIMIT)}.`);
  }

  return parsedLimit;
};

const parseLogLevel = (): LogLevel => {
  const candidate = process.env['LOG_LEVEL'];
  switch (candidate) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
    case 'silent':
      return candidate;
    default:
      return 'info';
  }
};

const parseBooleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
};

const createUserDb = (): Kysely<UserDatabase> => {
  const connectionString = process.env['USER_DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('USER_DATABASE_URL is required');
  }

  const ssl = parseBooleanEnv('DATABASE_SSL', false);
  const sslRejectUnauthorized = parseBooleanEnv('DATABASE_SSL_REJECT_UNAUTHORIZED', true);

  return new Kysely<UserDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 30_000,
        idleTimeoutMillis: 60_000,
        ...(ssl ? { ssl: { rejectUnauthorized: sslRejectUnauthorized } } : {}),
      }),
    }),
  });
};

const main = async (): Promise<number> => {
  const logger: Logger = createLogger({
    level: parseLogLevel(),
    name: 'learning-progress-auto-review-reuse-reconcile',
  });
  const userDb = createUserDb();
  const repo = makeLearningProgressRepo({
    db: userDb,
    logger,
  });

  try {
    const batchLimit = parseBatchLimit();
    const summaryResult = await reconcileAutoReviewReuse(
      {
        repo,
        onAutoApproved(approval) {
          logger.info(approval, 'Auto-resolved pending interaction from reconciliation');
        },
      },
      {
        batchLimit,
      }
    );

    if (summaryResult.isErr()) {
      throw new Error(summaryResult.error.message);
    }

    logger.info(
      {
        batchLimit,
        ...summaryResult.value,
      },
      'Learning progress auto-review reuse reconciliation completed'
    );
    console.log(JSON.stringify(summaryResult.value, null, 2));

    return summaryResult.value.failures > 0 ? 1 : 0;
  } finally {
    await userDb.destroy();
  }
};

const exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  return 1;
});

process.exit(exitCode);
