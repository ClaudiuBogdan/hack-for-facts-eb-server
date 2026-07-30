/**
 * Shared Kernel — Prod DB pool + Kysely instance (foundation §3).
 *
 * One read-tuned `pg.Pool` against `transparenta_prod`, wrapped in a single
 * Kysely instance typed over `ProdDatabase`. No write path.
 *
 * TYPE PARSING (per-pool, NOT process-global). We hand the Pool a `types`
 * override object so node-pg uses it for THIS pool's clients only — the redesign
 * pool never mutates the global `pg.types` registry (which legacy code shares):
 *   - int8 (OID 20, bigint): returned as STRINGS so org_id / flow_id never lose
 *     precision (§14.1).
 *   - date (1082) / timestamp (1114) / timestamptz (1184): returned as STRINGS so
 *     repos no longer need the fleet-wide `::text` cast. The string is node-pg's
 *     DEFAULT text wire format, which is byte-identical to what a `<col>::text`
 *     cast produces under the same server/session (date → `YYYY-MM-DD`; timestamp →
 *     `YYYY-MM-DD HH:MM:SS[.ffffff]`; timestamptz → the same with a `+00` offset).
 *     Existing `::text` casts therefore keep working unchanged (their result column
 *     is already `text`/OID 25, untouched by this override).
 * `numeric` already returns strings by default in node-postgres, preserving money
 * precision.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { ProdDatabase } from './types.js';

const { Pool, types } = pg;

/**
 * OIDs returned as the raw wire string instead of a coerced JS value. `types`
 * here is node-pg's re-export of `pg-types`; we only READ its default parsers +
 * builtins OID map (never `setTypeParser`, so global state is untouched).
 */
const STRING_OIDS = new Set<number>([
  types.builtins.INT8, // 20   — bigint: avoid lossy JS number (§14.1)
  types.builtins.DATE, // 1082 — 'YYYY-MM-DD' (matches `::text`)
  types.builtins.TIMESTAMP, // 1114 — 'YYYY-MM-DD HH:MM:SS[.ffffff]' (matches `::text`)
  types.builtins.TIMESTAMPTZ, // 1184 — '… +00' under UTC (matches `::text`)
]);

const identity = (value: string): string => value;

/** The OIDs this pool returns as the raw wire string (exported for the unit test). */
export const PROD_STRING_PARSED_OIDS: ReadonlySet<number> = STRING_OIDS;

/**
 * Does this pool return OID `oid` (in text format) as the raw wire string rather
 * than a coerced JS value? Pure — exported so the unit test asserts OID selection
 * (int8/date/timestamp[tz] → string; everything else → default) without a DB.
 */
export const prodReturnsStringFor = (oid: number, format: 'text' | 'binary' = 'text'): boolean =>
  format === 'text' && STRING_OIDS.has(oid);

/**
 * A per-pool node-pg `types` override: identity (string) parser for the OIDs in
 * `STRING_OIDS`, otherwise the library default. node-pg calls `getTypeParser(oid,
 * format)` for every result column, so this never mutates global pg state.
 */
type PgTextParser = (value: string) => unknown;

const prodTypeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary'): PgTextParser {
    const fmt = format ?? 'text';
    if (prodReturnsStringFor(oid, fmt)) return identity;
    // node-pg types `getTypeParser` as returning `any`; narrow to our parser shape.
    return types.getTypeParser(oid, fmt) as PgTextParser;
  },
};

export interface ProdDbConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly min?: number;
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
  const max = config.max ?? 15;
  // pg-pool does not preconnect `min` clients; after real traffic it retains
  // this bounded floor instead of paying a new TLS tunnel handshake after idle.
  const min = Math.min(config.min ?? 4, max);
  const ssl = sslOptionFor(config);
  const pool = new Pool({
    connectionString: stripSslmode(config.connectionString),
    max,
    min,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    // Read-only default; per-query class timeouts are set in repos (§5.5).
    statement_timeout: 15_000,
    // Per-pool type parsers (string-typed int8/date/timestamp[tz]) — never global.
    types: prodTypeParsers,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  // An idle client dropped by the network (dev port-forwards especially)
  // emits 'error' on the pool; without a listener Node treats it as an
  // unhandled 'error' event and kills the process. The client is already
  // discarded by pg — log and continue.
  pool.on('error', (error) => {
    console.error('[prod-db pool] idle client error (recovered):', error.message);
  });

  const db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  return { db, pool };
};
