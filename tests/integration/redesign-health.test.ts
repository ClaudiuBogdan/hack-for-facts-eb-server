/**
 * Probe contract of the standalone (Chronos) entrypoint:
 *  - `/api/v1/live` answers without touching any dependency, so kubelet
 *    startup/liveness probes never restart a process because Postgres,
 *    Meilisearch or the user DB is slow or down;
 *  - `/api/v1/health` always answers 200 with the dependency report;
 *  - `/api/v1/ready` answers 503 while the serving DB is unreachable.
 *
 * The pool points at a closed port, so every dependency check fails fast.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

import type { Kernel } from '@/modules/shared/index.js';
import type { FastifyInstance } from 'fastify';

describe('redesign health probes', () => {
  let app: FastifyInstance | undefined;
  let kernel: Kernel | undefined;

  beforeAll(async () => {
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules: [],
      kernelConfig: {
        prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
    });
    app = built.app;
    kernel = built.kernel;
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const inject = async (url: string) => {
    if (app === undefined) throw new Error('app not built');
    return app.inject({ method: 'GET', url });
  };

  it('answers /api/v1/live without acquiring a database connection', async () => {
    if (kernel === undefined) throw new Error('kernel not built');
    const res = await inject('/api/v1/live');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    // No dependency was consulted: the pool never tried to open a socket.
    expect(kernel.pool.totalCount).toBe(0);
  });

  it('reports dependencies on /api/v1/health with 200 even when the serving DB is down', async () => {
    const res = await inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ postgres: { status: string; reason?: string; error?: string } }>();
    expect(body.postgres.status).toBe('error');
    // The public body carries a coded reason, never the driver message (X/F14).
    expect(body.postgres.reason).toMatch(/^(error|timeout)$/u);
    expect(body.postgres.error).toBeUndefined();
  });

  it('gates /api/v1/ready on the serving DB', async () => {
    const res = await inject('/api/v1/ready');
    expect(res.statusCode).toBe(503);
    const body = res.json<{
      ready: boolean;
      postgres: { status: string; reason?: string; error?: string };
    }>();
    expect(body.ready).toBe(false);
    expect(body.postgres.status).toBe('error');
    // The public body carries a coded reason, never the driver message (X/F14).
    expect(body.postgres.reason).toMatch(/^(error|timeout)$/u);
    expect(body.postgres.error).toBeUndefined();
  });
});
