// eslint-disable-next-line import-x/no-unresolved -- wildcard exports (./*) in SDK package.json not supported by eslint resolver
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import createFastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  makeMcpRoutes,
  type McpConfig,
  type McpSession,
  type McpSessionStore,
} from '@/modules/mcp/index.js';

const MCP_HEADERS = {
  accept: 'application/json, text/event-stream',
};

const MCP_PROTOCOL_HEADERS = {
  ...MCP_HEADERS,
  'mcp-protocol-version': '2025-06-18',
};

const makeInitializePayload = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {
      name: 'vitest',
      version: '1.0.0',
    },
  },
});

const makeToolsListPayload = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/list',
});

const makeConfig = (): McpConfig => ({
  authRequired: false,
  allowJwt: false,
  sessionTtlSeconds: 3600,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 60,
  clientBaseUrl: '',
});

class TestSessionStore implements McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();

  get(sessionId: string): Promise<McpSession | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  set(session: McpSession): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  touch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.lastAccessedAt = Date.now();
    }
    return Promise.resolve();
  }
}

const makeTestMcpServer = (name: string, mcpServerCtor: typeof McpServer): McpServer => {
  const server = new mcpServerCtor({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.registerTool(
    'ping',
    {
      description: 'Test ping tool',
      inputSchema: {},
    },
    () => ({
      content: [{ type: 'text', text: 'pong' }],
    })
  );

  return server;
};

describe('MCP HTTP routes', () => {
  it('creates a fresh MCP server for each initialized HTTP session', async () => {
    const app = createFastify();
    let createCount = 0;

    await app.register(makeMcpRoutes, {
      createMcpServer: (): McpServer => {
        createCount += 1;
        return makeTestMcpServer(`test-mcp-${String(createCount)}`, McpServer);
      },
      sessionStore: new TestSessionStore(),
      config: makeConfig(),
    });

    const first = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: makeInitializePayload(1),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: makeInitializePayload(2),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers['mcp-session-id']).toEqual(expect.any(String));
    expect(second.headers['mcp-session-id']).toEqual(expect.any(String));
    expect(second.headers['mcp-session-id']).not.toBe(first.headers['mcp-session-id']);
    expect(createCount).toBe(2);

    await app.close();
  });

  it('reuses the session transport for follow-up requests and delegates deletion', async () => {
    const app = createFastify();
    let createCount = 0;

    await app.register(makeMcpRoutes, {
      createMcpServer: (): McpServer => {
        createCount += 1;
        return makeTestMcpServer(`test-mcp-${String(createCount)}`, McpServer);
      },
      sessionStore: new TestSessionStore(),
      config: makeConfig(),
    });

    const initialized = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: MCP_HEADERS,
      payload: makeInitializePayload(1),
    });
    const sessionId = initialized.headers['mcp-session-id'];

    expect(typeof sessionId).toBe('string');

    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...MCP_PROTOCOL_HEADERS,
        'mcp-session-id': sessionId,
      },
      payload: makeToolsListPayload(2),
    });

    expect(tools.statusCode).toBe(200);
    expect(tools.body).toContain('"name":"ping"');
    expect(createCount).toBe(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: {
        'mcp-session-id': sessionId,
      },
    });

    expect(deleted.statusCode).toBe(200);

    const afterDelete = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...MCP_PROTOCOL_HEADERS,
        'mcp-session-id': sessionId,
      },
      payload: makeToolsListPayload(3),
    });

    expect(afterDelete.statusCode).toBe(409);

    await app.close();
  });
});
