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
  /**
   * `'off'` runs `set jit = off` on every new connection before it is handed
   * out (CQA-22); absent, the pool keeps the server default. For pools of
   * short one-entity reads: the planner's estimate of the company profile's
   * financial statements read crossed `jit_above_cost`, and compiling it took
   * about 1.66 s of a 1.68 s read. A pool whose aggregates may gain from JIT
   * does not ask.
   */
  readonly jit?: 'off';
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

/** What the hook needs of a new connection: a node-pg client, or a plain fake in the unit test. */
interface SessionClient {
  query(text: string): Promise<unknown>;
}

/**
 * pg-pool's `onConnect` of a pool asked for `jit: 'off'` (exported for the
 * unit test). pg-pool awaits it before the new client is handed out, and
 * closes the client when it rejects, so no read runs on a connection that
 * still compiles. A session setting, not the startup `options`: node-pg lets
 * an `options` parameter of the connection URL replace the pool's own, and an
 * explicit `options` switches off its `PGOPTIONS` fallback. The URL is
 * therefore never rewritten for this. Nothing here issues `reset all` or
 * `discard all`, which would undo it; `set local jit` in a transaction ends
 * with that transaction.
 */
export const turnJitOff = async (client: SessionClient): Promise<void> => {
  await client.query('set jit = off');
};

/**
 * `@types/pg` types `onConnect` as returning void, but pg-pool awaits what the
 * hook returns, and that wait is the point: the same function, under the
 * declared type.
 */
const JIT_OFF_ON_CONNECT = turnJitOff as NonNullable<pg.PoolConfig['onConnect']>;

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
    ...(config.jit === 'off' ? { onConnect: JIT_OFF_ON_CONNECT } : {}),
  });

  // pg-pool removes its idle error listener while a connection is checked out.
  // Observe physical-client failures for that interval too: pg still rejects
  // outstanding queries and evicts the non-queryable client on normal release.
  // Never log the client/error object (pool errors can carry connection config).
  pool.on('connect', (client) => {
    client.on('error', () => {
      console.error('[prod-db pool] connection lost; active reads will fail');
    });
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

/**
 * The shared kernel pool's config (exported for the unit test). It asks for
 * `jit: 'off'`: its reads are short and per entity, and compiling one cost the
 * company profile about 1.6 s on every request (CQA-22).
 */
export const kernelPoolConfig = (config: {
  readonly prodDatabaseUrl: string;
  readonly poolMax?: number;
  readonly dbSsl?: boolean;
}): ProdDbConfig => ({
  connectionString: config.prodDatabaseUrl,
  jit: 'off',
  ...(config.poolMax !== undefined && { max: config.poolMax }),
  ...(config.dbSsl !== undefined && { ssl: config.dbSsl }),
});

/** The procurement pool's size: its reads are few and bounded (one module). */
const PROCUREMENT_POOL_MAX = 5;

/**
 * The procurement module's database (PRJ-54YB): its own pool and login when `connectionString`
 * is set, else the kernel's own `db`, the same pool and login as today. `close` destroys only a
 * pool this opened. The URL is never logged. Its own pool does not ask for `jit: 'off'`: its
 * aggregates may gain from JIT, so it keeps the server default (CQA-22).
 */
export const procurementDbFor = (
  kernelDb: Kysely<ProdDatabase>,
  config: { readonly connectionString?: string; readonly ssl?: boolean }
): { readonly db: Kysely<ProdDatabase>; close(): Promise<void> } => {
  if (config.connectionString === undefined) {
    return { db: kernelDb, close: () => Promise.resolve() };
  }
  const { db } = createProdDb({
    connectionString: config.connectionString,
    max: PROCUREMENT_POOL_MAX,
    ...(config.ssl !== undefined && { ssl: config.ssl }),
  });
  return { db, close: () => db.destroy() };
};
