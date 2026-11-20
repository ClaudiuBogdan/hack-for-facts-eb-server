/**
 * The procurement ClickHouse reader: one per process, shared by every
 * ClickHouse repo so all reads share the per-pod cap (moved unchanged from
 * clickhouse-analysis-repo.ts). Reads over the cap wait in a bounded queue;
 * ClickHouse's own TOO_MANY_SIMULTANEOUS_QUERIES and a refused wait answer a
 * retryable busy error; ClickHouse text is logged, never returned; identical
 * concurrent SQL is single-flighted.
 */
import { Type, type Static, type TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  busyRetryLater,
  databaseError,
  makeConcurrencyGate,
  type ApiError,
  type ConcurrencyGateOptions,
  type Logger,
} from '@/modules/shared/index.js';

export interface ClickhouseReaderConfig {
  /** Base URL of the ClickHouse HTTP interface, e.g. http://localhost:58123 */
  readonly url: string;
  /** Database holding the wide fact tables (default: proto). */
  readonly database: string;
  readonly user?: string;
  readonly password?: string;
  /** Per-process read cap (defaults below); tests pass small values. */
  readonly concurrency?: ConcurrencyGateOptions;
}

/**
 * Per process. The API's read-only ClickHouse user may run 6 queries at once
 * server-wide (owner decision, 2026-11-20: keep it at 6 and bound the caller),
 * and Chronos dev runs 2 API replicas: 2 × 3 never exceeds the limit. Reads
 * over the cap wait in a bounded FIFO queue instead of being sent and refused
 * with TOO_MANY_SIMULTANEOUS_QUERIES.
 */
export const CLICKHOUSE_CONCURRENCY: ConcurrencyGateOptions = {
  maxConcurrent: 3,
  maxQueued: 48,
  queueWaitMs: 10_000,
};
/** The `Retry-After` a busy refusal suggests. */
export const CLICKHOUSE_RETRY_AFTER_SECONDS = 2;
/** ClickHouse TOO_MANY_SIMULTANEOUS_QUERIES. */
const TOO_MANY_SIMULTANEOUS_QUERIES = '202';

/** Static client text: never carries ClickHouse's own error text. */
const busy = (): ApiError =>
  busyRetryLater('procurement analytics is busy; retry shortly', CLICKHOUSE_RETRY_AFTER_SECONDS);

/** The numeric ClickHouse error code a failed response names, header first. */
const exceptionCodeOf = (header: string | null, body: string): string | null => {
  if (header !== null && /^\d{1,4}$/u.test(header)) return header;
  return /^Code: (\d{1,4})\./u.exec(body.slice(0, 32))?.[1] ?? null;
};

/** Use the same accepted monetary states as the module's public contract. */

const ClickhouseCompactResponseSchema = Type.Object(
  {
    meta: Type.Array(
      Type.Object({
        name: Type.String(),
        type: Type.String(),
      })
    ),
    data: Type.Array(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true }
);

const compactRows = <S extends TObject>(
  payload: unknown,
  rowSchema: S
): Result<readonly Static<S>[], ApiError> => {
  if (!Value.Check(ClickhouseCompactResponseSchema, payload)) {
    return err(databaseError('clickhouse returned an invalid JSONCompact response'));
  }
  const names = payload.meta.map((column) => column.name);
  if (new Set(names).size !== names.length) {
    return err(databaseError('clickhouse returned duplicate JSONCompact column names'));
  }
  const expectedNames = Object.keys(rowSchema.properties);
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name))
  ) {
    return err(databaseError('clickhouse returned unexpected JSONCompact columns'));
  }
  const rows: Static<S>[] = [];
  for (const values of payload.data) {
    if (values.length !== names.length) {
      return err(databaseError('clickhouse returned a malformed JSONCompact row'));
    }
    const row: unknown = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    if (!Value.Check(rowSchema, row)) {
      return err(databaseError('clickhouse returned an invalid JSONCompact row'));
    }
    rows.push(row);
  }
  return ok(rows);
};

export interface ClickhouseReader {
  /** Run one read; rows are validated against `rowSchema`. */
  readonly query: <S extends TObject>(
    sql: string,
    rowSchema: S
  ) => Promise<Result<readonly Static<S>[], ApiError>>;
}

export const makeClickhouseReader = (
  config: ClickhouseReaderConfig,
  logger?: Logger
): ClickhouseReader => {
  const inFlightQueries = new Map<string, Promise<Result<readonly unknown[], ApiError>>>();
  const gate = makeConcurrencyGate(config.concurrency ?? CLICKHOUSE_CONCURRENCY);

  const runQuery = async <S extends TObject>(
    sql: string,
    rowSchema: S
  ): Promise<Result<readonly Static<S>[], ApiError>> => {
    const slot = await gate.acquire();
    if (slot.isErr()) {
      logger?.warn(
        { reason: slot.error, ...gate.stats() },
        'clickhouse read refused by the per-pod cap'
      );
      return err(busy());
    }
    const { waitedMs } = slot.value;
    const startedAt = performance.now();
    try {
      const url = new URL(config.url);
      url.searchParams.set('database', config.database);
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (config.user !== undefined) headers['X-ClickHouse-User'] = config.user;
      if (config.password !== undefined) headers['X-ClickHouse-Key'] = config.password;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: `${sql} FORMAT JSONCompact`,
        signal: AbortSignal.timeout(30_000),
      });
      // ClickHouse may report an exception with status 200 (headers sent first).
      const exceptionHeader = response.headers.get('x-clickhouse-exception-code');
      if (!response.ok || exceptionHeader !== null) {
        // The header is read before the body: an unreadable body never hides a 202.
        const body = await response.text().catch(() => '');
        const code = exceptionCodeOf(exceptionHeader, body);
        if (code === TOO_MANY_SIMULTANEOUS_QUERIES) {
          logger?.warn(
            { status: response.status, clickhouseCode: code, waitedMs, ...gate.stats() },
            'clickhouse refused a read at its concurrency limit'
          );
          return err(busy());
        }
        logger?.error(
          {
            status: response.status,
            clickhouseCode: code,
            // Never the body: rows streamed before an exception, or an
            // exception's own text, may quote a raw title. Its length only.
            bodyChars: body.length,
          },
          'clickhouse query failed'
        );
        // ClickHouse's text names its version, user and settings: log it, never return it.
        return err(
          databaseError(
            `clickhouse HTTP ${String(response.status)}${code === null ? '' : ` (code ${code})`}`
          )
        );
      }
      const parsed: unknown = await response.json();
      const rows = compactRows(parsed, rowSchema);
      if (rows.isOk()) {
        const contentLength = response.headers.get('content-length');
        const parsedContentLength = contentLength === null ? null : Number(contentLength);
        logger?.debug(
          {
            elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
            responseBytes:
              parsedContentLength !== null && Number.isFinite(parsedContentLength)
                ? parsedContentLength
                : null,
            rows: rows.value.length,
            format: 'JSONCompact',
            waitedMs,
          },
          'clickhouse query completed'
        );
      }
      return rows;
    } catch (error) {
      // A parse error quotes the body it failed on (raw row text): neither
      // logged nor returned.
      logger?.error(
        {
          error:
            error instanceof SyntaxError
              ? 'SyntaxError: the response body is not valid JSON (not logged)'
              : String(error),
        },
        'clickhouse query error'
      );
      return err(
        databaseError(
          error instanceof SyntaxError
            ? 'clickhouse returned an invalid response'
            : 'clickhouse is unreachable'
        )
      );
    } finally {
      slot.value.release();
    }
  };

  const query = <S extends TObject>(
    sql: string,
    rowSchema: S
  ): Promise<Result<readonly Static<S>[], ApiError>> => {
    const pending = inFlightQueries.get(sql);
    if (pending !== undefined) {
      return pending as Promise<Result<readonly Static<S>[], ApiError>>;
    }
    const started = runQuery(sql, rowSchema).finally(() => {
      inFlightQueries.delete(sql);
    });
    inFlightQueries.set(sql, started);
    return started;
  };

  return { query };
};
