/**
 * Shared Kernel — Prod DB pool + Kysely instance (foundation §3).
 *
 * One read-tuned `pg.Pool` against `transparenta_prod`, wrapped in a single
 * Kysely instance typed over `ProdDatabase`. No write path.
 *
 * The int8 (bigint) type parser is overridden to return STRINGS so org_id /
 * flow_id never lose precision (§14.1). `numeric` already returns strings by
 * default in node-postgres, preserving money precision.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { ProdDatabase } from './types.js';

const { Pool, types } = pg;

// OID 20 = int8 (bigint): return as string, not the lossy JS number.
types.setTypeParser(20, (value) => value);

export interface ProdDbConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly ssl?: boolean;
  readonly sslRejectUnauthorized?: boolean;
}

export interface ProdDb {
  readonly db: Kysely<ProdDatabase>;
  readonly pool: pg.Pool;
}

/**
 * Decide the pg `ssl` option from the URL's `sslmode` (node-postgres now treats
 * `require` as verify-full, which rejects the CNPG self-signed tunnel cert). For
 * `require`/`prefer` we encrypt but do not verify (`rejectUnauthorized: false`),
 * matching libpq `require` semantics over the prod-DB SSH tunnel.
 */
const sslOptionFor = (config: ProdDbConfig): pg.PoolConfig['ssl'] => {
  if (config.ssl === true) return { rejectUnauthorized: config.sslRejectUnauthorized ?? false };
  const mode = /[?&]sslmode=([a-z-]+)/iu.exec(config.connectionString)?.[1]?.toLowerCase();
  if (mode === undefined || mode === 'disable') return undefined;
  if (mode === 'verify-full' || mode === 'verify-ca') {
    return { rejectUnauthorized: config.sslRejectUnauthorized ?? true };
  }
  // require / prefer / allow → encrypt, do not verify (self-signed tunnel cert).
  return { rejectUnauthorized: false };
};

/** Strip `sslmode` from the URL so our explicit `ssl` object is authoritative. */
const stripSslmode = (connectionString: string): string =>
  connectionString.replace(/([?&])sslmode=[a-z-]+&?/iu, '$1').replace(/[?&]$/u, '');

export const createProdDb = (config: ProdDbConfig): ProdDb => {
  const ssl = sslOptionFor(config);
  const pool = new Pool({
    connectionString: stripSslmode(config.connectionString),
    max: config.max ?? 15,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    // Read-only default; per-query class timeouts are set in repos (§5.5).
    statement_timeout: 15_000,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  const db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  return { db, pool };
};
