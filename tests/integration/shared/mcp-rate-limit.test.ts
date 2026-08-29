/**
 * `/api/v1/mcp` is anonymous until per-user MCP auth lands, so the route sits
 * behind the kernel's per-IP token bucket (namespaced `mcp:` key). This proves
 * the flow: requests inside the bucket pass, a burst past it gets 429 with a
 * Retry-After, and the JSON-RPC-shaped error body names the condition.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

import type { FastifyInstance } from 'fastify';

describe('MCP route rate limiting', () => {
  let app: FastifyInstance;

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
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const toolsList = async (id: number) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
    });

  it('serves requests inside the bucket, then 429s a burst past it', async () => {
    const first = await toolsList(1);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ jsonrpc: '2.0', id: 1 });

    // The kernel bucket holds 30 tokens/minute per IP; inject() shares one IP,
    // so a 40-request burst must trip it (refill during the burst is < 1 token).
    const statuses: number[] = [];
    for (let i = 2; i <= 41; i += 1) {
      const res = await toolsList(i);
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.headers['retry-after']).toMatch(/^\d+$/);
        expect(res.json()).toMatchObject({
          jsonrpc: '2.0',
          error: { code: -32000 },
        });
        break;
      }
    }
    expect(statuses).toContain(429);
  });
});
