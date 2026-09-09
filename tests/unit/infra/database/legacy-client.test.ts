/**
 * The three legacy (Phoenix) pools: a pool-level statement bound and the
 * error listeners that keep a dropped connection from killing the process.
 *
 * `setStatementTimeout` on a non-transaction instance is a no-op, so the pool
 * bound is the only one that applies to the legacy repos. And without a
 * `pool.on('error')` listener, an idle client dropped by the network (a
 * port-forward especially) is an unhandled 'error' event — the tunnel-drop
 * crash. No connection is ever opened here.
 */

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  LEGACY_STATEMENT_TIMEOUT_MS,
  attachPoolErrorListeners,
  legacyPoolConfig,
} from '@/infra/database/client.js';

const { Pool: PG_POOL } = pg;

describe('legacy pool configuration', () => {
  it('bounds every statement at the largest per-repo timeout in use', () => {
    const config = legacyPoolConfig('postgres://unused:unused@127.0.0.1:1/unused', false, true);
    expect(config.statement_timeout).toBe(LEGACY_STATEMENT_TIMEOUT_MS);
    expect(LEGACY_STATEMENT_TIMEOUT_MS).toBe(45_000);
    expect(config.ssl).toBeUndefined();
  });

  it('passes the TLS verification choice through only when ssl is on', () => {
    const config = legacyPoolConfig('postgres://unused:unused@127.0.0.1:1/unused', true, false);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('survives an idle client error instead of crashing the process', async () => {
    const pool = attachPoolErrorListeners(
      new PG_POOL(legacyPoolConfig('postgres://unused:unused@127.0.0.1:1/unused', false, true)),
      'test-db'
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Without a listener this throws synchronously (unhandled 'error' event).
      expect(() =>
        pool.emit('error', new Error('connection terminated unexpectedly'))
      ).not.toThrow();
      expect(stderr).toHaveBeenCalledWith(
        '[test-db pool] idle client error (recovered): connection terminated unexpectedly'
      );
      // The message, never the error object (it can carry the connection config).
      expect(stderr.mock.calls.flat().some((arg) => arg instanceof Error)).toBe(false);
    } finally {
      stderr.mockRestore();
      await pool.end();
    }
  });
});
