import { describe, it, expect } from 'vitest';

import { getReadiness } from '@/modules/health/core/usecases/get-readiness.js';

import type { HealthChecker } from '@/modules/health/core/ports.js';

describe('getReadiness', () => {
  const timestamp = '2023-01-01T00:00:00Z';
  const uptime = 100;

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

  it('returns unhealthy when any check is unhealthy', async () => {
    const checkers: HealthChecker[] = [
      async () => ({ name: 'db', status: 'healthy' }),
      async () => ({ name: 'redis', status: 'unhealthy' }),
    ];

    const result = await getReadiness({ checkers }, { uptime, timestamp });

    expect(result.status).toBe('unhealthy');
  });

  it('handles rejected checks (crashes)', async () => {
    const checkers: HealthChecker[] = [
      async () => {
        throw new Error('Connection timed out');
      },
    ];

    const result = await getReadiness({ checkers }, { uptime, timestamp });

    expect(result.status).toBe('unhealthy');
    expect(result.checks[0]?.message).toBe('Connection timed out');
    expect(result.checks[0]?.status).toBe('unhealthy');
  });

  it('includes version if provided', async () => {
    const checkers: HealthChecker[] = [];
    const result = await getReadiness({ checkers, version: '1.0.0' }, { uptime, timestamp });
    expect(result.version).toBe('1.0.0');
  });
});
