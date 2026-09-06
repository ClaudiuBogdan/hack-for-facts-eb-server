import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { UserDatabase } from './user/types.js';

interface UserDataClientConfig {
  readonly url: string;
  readonly caFile: string;
  readonly tlsServername?: string;
}

export const makeUserDataPool = (
  config: UserDataClientConfig,
  reportConnectionFailure: () => void = () => {
    console.error('User database connection failed');
  }
): pg.Pool => {
  let target: URL;
  try {
    target = new URL(config.url);
  } catch {
    throw new Error('Invalid user-data database URL');
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search !== '')
    throw new Error('User-data database requires a PostgreSQL URL without connection overrides');
  // pg overwrites SNI for DNS hosts; a separate name is supported only for IP tunnels.
  if (
    config.tlsServername !== undefined &&
    config.tlsServername !== target.hostname &&
    isIP(target.hostname.replace(/^\[|\]$/gu, '')) === 0
  )
    throw new Error('User-data TLS name must match the database host or use an IP tunnel');
  const pool = new pg.Pool({
    connectionString: config.url,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    ssl: {
      ca: readFileSync(config.caFile, 'utf8'),
      rejectUnauthorized: true,
      servername: config.tlsServername ?? target.hostname,
    },
  });
  // Keep listeners while clients are checked out as well as idle. pg still
  // rejects affected queries and evicts broken connections. Never log error/client objects.
  pool.on('connect', (client) => {
    client.on('error', () => {
      reportConnectionFailure();
    });
  });
  pool.on('error', () => {
    reportConnectionFailure();
  });
  return pool;
};

/** Dedicated writable user-data pool; never initializes a serving or legacy database. */
export const makeUserDataClient = (config: UserDataClientConfig): Kysely<UserDatabase> =>
  new Kysely<UserDatabase>({ dialect: new PostgresDialect({ pool: makeUserDataPool(config) }) });
