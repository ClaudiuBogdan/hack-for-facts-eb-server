import { describe, it, expect } from 'vitest';

import { getReadiness } from '@/modules/health/core/usecases/get-readiness.js';

import type { HealthChecker } from '@/modules/health/core/ports.js';

describe('getReadiness', () => {
  const timestamp = '2023-01-01T00:00:00Z';
  const uptime = 100;

  describe('basic status', () => {
    it('returns ok when all checks are healthy', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'healthy' }),
        async () => ({ name: 'redis', status: 'healthy' }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('ok');
      expect(result.checks).toHaveLength(2);
      expect(result.checks[0]?.name).toBe('db');
      expect(result.checks[0]?.status).toBe('healthy');
    });

    it('returns ok when no checkers are configured', async () => {
      const result = await getReadiness({ checkers: [] }, { uptime, timestamp });

      expect(result.status).toBe('ok');
      expect(result.checks).toHaveLength(0);
    });

    it('includes version if provided', async () => {
      const checkers: HealthChecker[] = [];
      const result = await getReadiness({ checkers, version: '1.0.0' }, { uptime, timestamp });
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('critical checks (default behavior)', () => {
    it('returns unhealthy when any critical check is unhealthy', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'healthy', critical: true }),
        async () => ({ name: 'redis', status: 'unhealthy', critical: true }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
    });

    it('treats checks without critical flag as critical (default)', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'healthy' }), // No critical flag
        async () => ({ name: 'redis', status: 'unhealthy' }), // No critical flag
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
    });

    it('handles rejected checks as critical failures', async () => {
      const checkers: HealthChecker[] = [
        async () => {
          throw new Error('Connection timed out');
        },
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
      expect(result.checks[0]?.message).toBe('Connection timed out');
      expect(result.checks[0]?.status).toBe('unhealthy');
      expect(result.checks[0]?.critical).toBe(true);
    });
  });

  describe('non-critical checks (degraded status)', () => {
    it('returns degraded when only non-critical checks are unhealthy', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'healthy', critical: true }),
        async () => ({ name: 'cache', status: 'unhealthy', critical: false }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('degraded');
    });

    it('returns ok when all non-critical checks are healthy', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'healthy', critical: true }),
        async () => ({ name: 'cache', status: 'healthy', critical: false }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('ok');
    });

    it('returns unhealthy over degraded when both critical and non-critical fail', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'db', status: 'unhealthy', critical: true }),
        async () => ({ name: 'cache', status: 'unhealthy', critical: false }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
    });
  });

  describe('mixed critical and non-critical checks', () => {
    it('handles complex scenarios with multiple check types', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'budget-db', status: 'healthy', critical: true }),
        async () => ({ name: 'user-db', status: 'healthy', critical: true }),
        async () => ({ name: 'redis', status: 'unhealthy', critical: false }),
        async () => ({ name: 'external-api', status: 'healthy', critical: false }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('degraded');
      expect(result.checks).toHaveLength(4);
    });

    it('prioritizes critical failures over non-critical', async () => {
      const checkers: HealthChecker[] = [
        async () => ({ name: 'budget-db', status: 'healthy', critical: true }),
        async () => ({ name: 'user-db', status: 'unhealthy', critical: true }), // Critical failure
        async () => ({ name: 'redis', status: 'unhealthy', critical: false }), // Non-critical failure
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
    });
  });

  describe('error handling', () => {
    it('handles non-Error exceptions from checkers', async () => {
      const checkers: HealthChecker[] = [
        async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
          throw 'string error'; // Non-Error exception
        },
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.status).toBe('unhealthy');
      expect(result.checks[0]?.message).toBe('Check failed');
      expect(result.checks[0]?.name).toBe('unknown');
    });

    it('continues processing when one checker fails', async () => {
      const checkers: HealthChecker[] = [
        async () => {
          throw new Error('DB failed');
        },
        async () => ({ name: 'cache', status: 'healthy', critical: false }),
      ];

      const result = await getReadiness({ checkers }, { uptime, timestamp });

      expect(result.checks).toHaveLength(2);
      expect(result.checks[0]?.status).toBe('unhealthy');
      expect(result.checks[1]?.status).toBe('healthy');
    });
  });
});
