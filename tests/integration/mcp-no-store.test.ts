/**
 * PROC-VDWQ on MCP: a tool result can carry a direct-acquisition supplier name
 * (a registry or masked name), so every reply of the kernel's MCP route is
 * `Cache-Control: no-store`, whatever the method or outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

import type { FastifyInstance } from 'fastify';

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify(payload),
  });

describe('MCP replies are never cacheable', () => {
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

  it('marks a result, a JSON-RPC error and a notification no-store', async () => {
    const listed = await post(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');

    const unknown = await post(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    expect(unknown.headers['cache-control']).toBe('no-store');

    const notification = await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.statusCode).toBe(202);
    expect(notification.headers['cache-control']).toBe('no-store');

    // A valid JSON body that is not a JSON-RPC request: a top-level JSON-RPC error.
    const invalid = await post(app, { not: 'json-rpc' });
    expect(invalid.json<{ error?: unknown }>().error).toBeDefined();
    expect(invalid.headers['cache-control']).toBe('no-store');
  });

  it('marks replies sent before the handler runs no-store: a body Fastify cannot parse', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { 'content-type': 'application/json' },
      payload: '{"jsonrpc":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['cache-control']).toBe('no-store');
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { 'content-type': 'application/x-unknown' },
      payload: 'x',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.headers['cache-control']).toBe('no-store');
  });

  it('marks the method-not-allowed replies no-store', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/v1/mcp' });
      expect(res.statusCode).toBe(405);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});
