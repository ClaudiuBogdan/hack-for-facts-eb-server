/**
 * Companies analytics — the dedicated read-only ClickHouse HTTP reader.
 *
 * Talks to the `companies_reader` user only (never procurement's connection).
 * That user is `readonly=1` with a server-side profile (4 threads, 1 GiB,
 * 10 s, 6 concurrent queries, cancel on client close), so this client sends
 * NO settings — a readonly user would reject them. It adds the client half:
 *
 *  - every value is a typed query parameter (`{p0:String}` + `param_p0`);
 *    the SQL text holds only whitelisted identifiers and code constants;
 *  - at most 3 requests in flight per process (2 replicas share the user's
 *    server-wide limit of 6), a bounded wait queue, and a hard 12 s abort
 *    (the server stops at 10 s); `close()` aborts everything;
 *  - redirects are refused (credentials travel in headers and must never
 *    follow a redirect); credentials, URLs, SQL and raw transport/server error
 *    text are never logged or returned — only a coded reason;
 *  - JSONCompact responses are validated column by column against a TypeBox
 *    row schema before anything reads them;
 *  - identical concurrent statements share one request, and successful
 *    results over the immutable release tables are cached (bounded).
 */

import { Type, type Static, type TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  createCache,
  databaseError,
  serviceUnavailable,
  timeoutError,
  upstreamError,
  type ApiError,
  type Logger,
} from '@/modules/shared/index.js';

export interface CompaniesClickhouseConfig {
  /** Bare http(s) origin of the ClickHouse HTTP interface. */
  readonly url: string;
  /** Always `companies_analytics` (validated by the entrypoint config). */
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export type ClickhouseParamType = 'String' | 'UInt16' | 'Int64' | 'Decimal(18,2)' | 'Array(String)';

/** Collects typed parameters while a statement is built. */
export interface QueryParams {
  /** Bind a value and return its placeholder, e.g. `{p3:String}`. */
  bind(type: ClickhouseParamType, value: string | readonly string[]): string;
  readonly entries: () => readonly (readonly [string, string])[];
}

const escapeText = (value: string): string =>
  value.replace(/\\/gu, '\\\\').replace(/\t/gu, '\\t').replace(/\n/gu, '\\n');
const quoteArrayItem = (value: string): string =>
  `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;

export const makeQueryParams = (): QueryParams => {
  const values: [string, string][] = [];
  return {
    bind(type, value) {
      const name = `p${String(values.length)}`;
      const encoded =
        typeof value === 'string' ? escapeText(value) : `[${value.map(quoteArrayItem).join(',')}]`;
      values.push([name, encoded]);
      return `{${name}:${type}}`;
    },
    entries: () => values,
  };
};

export interface ClickhouseReader {
  query<S extends TObject>(
    sql: string,
    params: QueryParams,
    rowSchema: S,
    options?: { readonly cache?: boolean }
  ): Promise<Result<readonly Static<S>[], ApiError>>;
  /** Abort in-flight requests and refuse new ones (app shutdown). */
  close(): void;
}

/**
 * Per process. `companies_reader` allows 6 concurrent queries server-wide and
 * Chronos runs 2 API replicas: 2 × 3 never exceeds the server limit.
 */
export const CLICKHOUSE_MAX_CONCURRENT = 3;
/** Waiters beyond the in-flight slots; more are refused at once as "busy". */
export const CLICKHOUSE_MAX_QUEUED = 24;
export const CLICKHOUSE_QUEUE_WAIT_MS = 5_000;
export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 12_000;
const RESULT_CACHE_TTL_MS = 10 * 60_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
const RESULT_CACHE_MAX_ROWS = 5_000;

const CompactResponseSchema = Type.Object({
  meta: Type.Array(Type.Object({ name: Type.String(), type: Type.String() })),
  data: Type.Array(Type.Array(Type.Unknown())),
});

const compactRows = <S extends TObject>(
  payload: unknown,
  rowSchema: S
): Result<readonly Static<S>[], ApiError> => {
  if (!Value.Check(CompactResponseSchema, payload))
    return err(databaseError('companies analytics engine returned an invalid response'));
  const names = payload.meta.map((column) => column.name);
  const expected = Object.keys(rowSchema.properties);
  if (
    new Set(names).size !== names.length ||
    names.length !== expected.length ||
    expected.some((name) => !names.includes(name))
  )
    return err(databaseError('companies analytics engine returned unexpected columns'));
  const rows: Static<S>[] = [];
  for (const values of payload.data) {
    if (values.length !== names.length)
      return err(databaseError('companies analytics engine returned a malformed row'));
    const row: unknown = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    if (!Value.Check(rowSchema, row))
      return err(databaseError('companies analytics engine returned an invalid row'));
    rows.push(row);
  }
  return ok(rows);
};

/** ClickHouse error codes the reader distinguishes (all others are generic). */
const TIMEOUT_CODES = new Set(['159', '160', '394']);
const BUSY_CODES = new Set(['202', '203', '241', '252']);

const mapServerError = (code: string | null): ApiError => {
  if (code !== null && TIMEOUT_CODES.has(code))
    return timeoutError('companies analytics query exceeded its time budget');
  if (code !== null && BUSY_CODES.has(code))
    return serviceUnavailable(
      'companies analytics is busy or the question exceeded its resource budget; retry or narrow the scope'
    );
  return databaseError('companies analytics query failed');
};

const errorCodeOf = async (response: Response): Promise<string | null> => {
  const header = response.headers.get('x-clickhouse-exception-code');
  // Drain the body (frees the socket) and read only the numeric code prefix.
  const body = await response.text().catch(() => '');
  if (header !== null && /^\d{1,4}$/u.test(header)) return header;
  return /^Code: (\d{1,4})\./u.exec(body.slice(0, 32))?.[1] ?? null;
};

export const makeClickhouseReader = (
  config: CompaniesClickhouseConfig,
  logger?: Logger
): ClickhouseReader => {
  const closing = new AbortController();
  let active = 0;
  /** Waiters for a slot; `settle(true)` hands over the releasing request's slot. */
  const queue: { settle: (granted: boolean) => void }[] = [];
  const inFlight = new Map<string, Promise<Result<readonly unknown[], ApiError>>>();
  const cache = createCache({ ttlMs: RESULT_CACHE_TTL_MS, maxEntries: RESULT_CACHE_MAX_ENTRIES });

  const acquire = (): Promise<boolean> => {
    if (closing.signal.aborted) return Promise.resolve(false);
    if (active < CLICKHOUSE_MAX_CONCURRENT) {
      active++;
      return Promise.resolve(true);
    }
    if (queue.length >= CLICKHOUSE_MAX_QUEUED) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = {
        settle: (granted: boolean) => {
          clearTimeout(timer);
          resolve(granted);
        },
      };
      const timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        resolve(false);
      }, CLICKHOUSE_QUEUE_WAIT_MS);
      queue.push(entry);
    });
  };

  const releaseSlot = (): void => {
    const next = queue.shift();
    if (next !== undefined) next.settle(true);
    else active--;
  };

  const execute = async <S extends TObject>(
    sql: string,
    params: QueryParams,
    rowSchema: S
  ): Promise<Result<readonly Static<S>[], ApiError>> => {
    if (!(await acquire()))
      return err(serviceUnavailable('companies analytics is busy; retry shortly'));
    const startedAt = performance.now();
    const elapsedMs = (): number => Math.round(performance.now() - startedAt);
    const timeout = AbortSignal.timeout(CLICKHOUSE_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(config.url);
      url.searchParams.set('database', config.database);
      for (const [name, value] of params.entries()) url.searchParams.set(`param_${name}`, value);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-ClickHouse-User': config.user,
          'X-ClickHouse-Key': config.password,
        },
        body: `${sql} FORMAT JSONCompact`,
        redirect: 'error',
        signal: AbortSignal.any([timeout, closing.signal]),
      });
      if (!response.ok || response.headers.get('x-clickhouse-exception-code') !== null) {
        const code = await errorCodeOf(response);
        logger?.warn(
          { status: response.status, clickhouseCode: code, elapsedMs: elapsedMs() },
          'companies analytics query failed'
        );
        return err(mapServerError(code));
      }
      const payload: unknown = await response.json();
      const rows = compactRows(payload, rowSchema);
      if (rows.isErr()) {
        logger?.warn({ elapsedMs: elapsedMs() }, 'companies analytics response rejected');
        return rows;
      }
      logger?.debug(
        { elapsedMs: elapsedMs(), rows: rows.value.length },
        'companies analytics query completed'
      );
      return rows;
    } catch (error) {
      if (closing.signal.aborted)
        return err(serviceUnavailable('companies analytics is shutting down'));
      if (timeout.aborted) {
        logger?.warn(
          { reason: 'timeout', elapsedMs: elapsedMs() },
          'companies analytics query aborted'
        );
        return err(timeoutError('companies analytics query exceeded its time budget'));
      }
      const reason = error instanceof SyntaxError ? 'invalid_json' : 'transport';
      logger?.warn({ reason, elapsedMs: elapsedMs() }, 'companies analytics query failed');
      return err(
        reason === 'invalid_json'
          ? databaseError('companies analytics engine returned an invalid response')
          : upstreamError('companies analytics engine is unreachable', 'clickhouse')
      );
    } finally {
      releaseSlot();
    }
  };

  return {
    query<S extends TObject>(
      sql: string,
      params: QueryParams,
      rowSchema: S,
      options: { readonly cache?: boolean } = {}
    ): Promise<Result<readonly Static<S>[], ApiError>> {
      const key = JSON.stringify([sql, params.entries()]);
      const useCache = options.cache !== false;
      if (useCache) {
        const hit = cache.get(key) as readonly Static<S>[] | undefined;
        if (hit !== undefined) return Promise.resolve(ok(hit));
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending as Promise<Result<readonly Static<S>[], ApiError>>;
      const started = execute(sql, params, rowSchema)
        .then((result) => {
          if (useCache && result.isOk() && result.value.length <= RESULT_CACHE_MAX_ROWS)
            cache.set(key, result.value);
          return result;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, started);
      return started;
    },
    close() {
      closing.abort();
      for (const entry of queue.splice(0)) entry.settle(false);
    },
  };
};
