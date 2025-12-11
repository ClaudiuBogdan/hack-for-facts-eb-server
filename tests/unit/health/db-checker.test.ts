/**
 * Unit tests for database health checker
 *
 * These tests focus on behavior rather than exact timing to avoid flakiness.
 */

import { describe, it, expect } from 'vitest';

import { makeDbHealthChecker } from '@/modules/health/shell/checkers/db-checker.js';

import { makeFakeKyselyDb } from '../../fixtures/fakes.js';

describe('makeDbHealthChecker', () => {
  describe('healthy database', () => {
    it('returns healthy status when query succeeds', async () => {
      const db = makeFakeKyselyDb();
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.name).toBe('database');
      expect(result.status).toBe('healthy');
      expect(result.critical).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toBeUndefined();
    });

    it('measures latency for slow queries', async () => {
      // Use a delay large enough to be reliably measurable
      const db = makeFakeKyselyDb({ delayMs: 100 });
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.status).toBe('healthy');
      // Just verify latency is positive and meaningful (> 50ms for a 100ms delay)
      // We don't check exact values due to timer precision variations
      expect(result.latencyMs).toBeGreaterThan(50);
    });

    it('uses custom name', async () => {
      const db = makeFakeKyselyDb();
      const checker = makeDbHealthChecker(db, { name: 'user-database' });

      const result = await checker();

      expect(result.name).toBe('user-database');
    });
  });

  describe('unhealthy database', () => {
    it('returns unhealthy status when query fails', async () => {
      const db = makeFakeKyselyDb({
        failWithError: new Error('Connection refused'),
      });
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.name).toBe('database');
      expect(result.status).toBe('unhealthy');
      expect(result.critical).toBe(true);
      expect(result.message).toBe('Connection refused');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns unhealthy status when query times out', async () => {
      // Create a db with a very long delay that will definitely exceed timeout
      const slowDelayMs = 5000;
      const timeoutMs = 100;
      const db = makeFakeKyselyDb({ delayMs: slowDelayMs });
      const checker = makeDbHealthChecker(db, {
        name: 'database',
        timeoutMs,
      });

      const result = await checker();

      // Verify timeout behavior
      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out');
      expect(result.message).toContain(String(timeoutMs));

      // Verify we didn't wait for the full slow delay
      // The latency should be much less than the slow query delay
      expect(result.latencyMs).toBeLessThan(slowDelayMs / 2);
    });

    it('handles non-Error exceptions', async () => {
      const db = makeFakeKyselyDb();
      // Override the executor's executeQuery to throw a non-Error
      const executor = db.getExecutor();
      (executor as unknown as { executeQuery: () => never }).executeQuery = () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
        throw 'string error';
      };
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('Unknown database error');
    });
  });

  describe('timeout configuration', () => {
    it('does not timeout for fast queries within default timeout', async () => {
      // Fast query should complete well within the default 3000ms timeout
      const db = makeFakeKyselyDb({ delayMs: 10 });
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.status).toBe('healthy');
    });

    it('triggers timeout when query exceeds custom timeout', async () => {
      // Query takes 200ms but timeout is 50ms
      const db = makeFakeKyselyDb({ delayMs: 200 });
      const checker = makeDbHealthChecker(db, {
        name: 'database',
        timeoutMs: 50,
      });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out after 50ms');
    });

    it('succeeds when query completes before timeout', async () => {
      // Query takes 10ms, timeout is 500ms - should succeed
      const db = makeFakeKyselyDb({ delayMs: 10 });
      const checker = makeDbHealthChecker(db, {
        name: 'database',
        timeoutMs: 500,
      });

      const result = await checker();

      expect(result.status).toBe('healthy');
    });
  });

  describe('critical flag', () => {
    it('always marks result as critical for healthy db', async () => {
      const db = makeFakeKyselyDb();
      const result = await makeDbHealthChecker(db, { name: 'db' })();

      expect(result.critical).toBe(true);
    });

    it('always marks result as critical for unhealthy db', async () => {
      const db = makeFakeKyselyDb({ failWithError: new Error('Failed') });
      const result = await makeDbHealthChecker(db, { name: 'db' })();

      expect(result.critical).toBe(true);
    });
  });
});
