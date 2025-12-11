/**
 * Unit tests for database health checker
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
      expect(result.latencyMs).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toBeUndefined();
    });

    it('returns latency measurement', async () => {
      const delayMs = 50;
      const db = makeFakeKyselyDb({ delayMs });
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.status).toBe('healthy');
      // Allow 20% tolerance for timer precision and scheduling variations
      expect(result.latencyMs).toBeGreaterThanOrEqual(delayMs * 0.8);
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
      expect(result.latencyMs).toBeDefined();
    });

    it('returns unhealthy status when query times out', async () => {
      // Create a db that delays longer than the timeout
      const db = makeFakeKyselyDb({ delayMs: 5000 });
      const checker = makeDbHealthChecker(db, {
        name: 'database',
        timeoutMs: 50, // Very short timeout for test
      });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out');
      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
      expect(result.latencyMs).toBeLessThan(5000); // Should not wait for full delay
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
    it('uses default timeout of 3000ms', async () => {
      // This test verifies the default timeout doesn't trigger for fast queries
      const db = makeFakeKyselyDb({ delayMs: 10 });
      const checker = makeDbHealthChecker(db, { name: 'database' });

      const result = await checker();

      expect(result.status).toBe('healthy');
    });

    it('respects custom timeout', async () => {
      const db = makeFakeKyselyDb({ delayMs: 100 });
      const checker = makeDbHealthChecker(db, {
        name: 'database',
        timeoutMs: 50,
      });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out after 50ms');
    });
  });

  describe('critical flag', () => {
    it('always marks result as critical', async () => {
      const healthyDb = makeFakeKyselyDb();
      const unhealthyDb = makeFakeKyselyDb({
        failWithError: new Error('Failed'),
      });

      const healthyResult = await makeDbHealthChecker(healthyDb, { name: 'db' })();
      const unhealthyResult = await makeDbHealthChecker(unhealthyDb, { name: 'db' })();

      expect(healthyResult.critical).toBe(true);
      expect(unhealthyResult.critical).toBe(true);
    });
  });
});
