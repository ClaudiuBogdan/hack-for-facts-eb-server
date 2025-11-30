import { describe, it, expect } from 'vitest';

import { evaluateReadiness, mapCheckResults } from './logic.js';
import { type HealthCheckResult } from './types.js';

describe('Health Core Logic', () => {
  describe('mapCheckResults', () => {
    it('returns values for fulfilled promises', () => {
      const input: PromiseSettledResult<HealthCheckResult>[] = [
        { status: 'fulfilled', value: { name: 'db', status: 'healthy' } },
        { status: 'fulfilled', value: { name: 'redis', status: 'unhealthy' } },
      ];
      const result = mapCheckResults(input);
      expect(result).toEqual([
        { name: 'db', status: 'healthy' },
        { name: 'redis', status: 'unhealthy' },
      ]);
    });

    it('maps rejected promises to unhealthy results', () => {
      const input: PromiseSettledResult<HealthCheckResult>[] = [
        { status: 'rejected', reason: new Error('Connection timed out') },
      ];
      const result = mapCheckResults(input);
      expect(result).toEqual([
        {
          name: 'unknown',
          status: 'unhealthy',
          message: 'Connection timed out',
        },
      ]);
    });
  });

  describe('evaluateReadiness', () => {
    const timestamp = '2023-01-01T00:00:00Z';
    const uptime = 100;

    it('returns ok when all checks are healthy', () => {
      const checks: HealthCheckResult[] = [
        { name: 'db', status: 'healthy' },
        { name: 'redis', status: 'healthy' },
      ];

      const result = evaluateReadiness(checks, uptime, timestamp);

      expect(result.status).toBe('ok');
      expect(result.checks).toEqual(checks);
    });

    it('returns unhealthy when any check is unhealthy', () => {
      const checks: HealthCheckResult[] = [
        { name: 'db', status: 'healthy' },
        { name: 'redis', status: 'unhealthy' },
      ];

      const result = evaluateReadiness(checks, uptime, timestamp);

      expect(result.status).toBe('unhealthy');
    });

    it('includes version if provided', () => {
      const result = evaluateReadiness([], uptime, timestamp, '1.0.0');
      expect(result.version).toBe('1.0.0');
    });
  });
});
