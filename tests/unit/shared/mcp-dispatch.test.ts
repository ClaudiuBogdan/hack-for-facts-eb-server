/**
 * MCP HTTP dispatcher: id-correlation, concurrent same-client-id isolation,
 * notification handling. Uses a stub McpServer that echoes via the transport.
 */

import { describe, expect, it } from 'vitest';

import { createMcpHttpDispatcher } from '@/modules/shared/shell/mcp/http-dispatch.js';

interface StubTransport {
  onmessage?: (m: Record<string, unknown>) => void;
  send: (m: Record<string, unknown>) => Promise<void>;
}

/**
 * A stub MCP server: on connect it captures the transport, and for each
 * incoming message it (asynchronously) sends back a response echoing the id
 * with a deterministic result derived from the params — modeling the real
 * server's id round-trip.
 */
const makeStubServer = (delayMs = 0) => {
  let transport: StubTransport | undefined;
  return {
    connect: (t: StubTransport) => {
      transport = t;
      t.onmessage = (msg) => {
        const params = msg['params'] as { tag?: string } | undefined;
        setTimeout(() => {
          void transport?.send({
            jsonrpc: '2.0',
            id: msg['id'],
            result: { echoedTag: params?.tag ?? null },
          });
        }, delayMs);
      };
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
};

describe('createMcpHttpDispatcher', () => {
  it('correlates a response to its request and restores the client id', async () => {
    const dispatcher = createMcpHttpDispatcher(() => makeStubServer() as never);
    const res = (await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { tag: 'A' },
    })) as { id: number; result: { echoedTag: string } };
    expect(res.id).toBe(7);
    expect(res.result.echoedTag).toBe('A');
    await dispatcher.close();
  });

  it('isolates concurrent requests with a fresh server each (no cross-talk)', async () => {
    // Per-request server: each request gets its own server + transport, so two
    // requests reusing client id:1 never collide on protocol/pending state.
    const dispatcher = createMcpHttpDispatcher(() => makeStubServer(10) as never);
    const results = (await Promise.all([
      dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { tag: 'first' } }),
      dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { tag: 'second' } }),
    ])) as { id: number; result: { echoedTag: string } }[];
    const a = results[0];
    const b = results[1];
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(1);
    expect(new Set([a?.result.echoedTag, b?.result.echoedTag])).toEqual(new Set(['first', 'second']));
    await dispatcher.close();
  });

  it('ignores server-originated messages that carry a method (only resolves on responses)', async () => {
    // A server that emits a notification (with method) before the response must
    // not resolve the request early.
    const serverFactory = (): never => {
      let t: StubTransport | undefined;
      return {
        connect: (transport: StubTransport) => {
          t = transport;
          transport.onmessage = (msg) => {
            // Server-originated notification (has method) — must be ignored.
            void t?.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
            // Then the real response.
            void t?.send({ jsonrpc: '2.0', id: msg['id'], result: { ok: true } });
          };
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      } as never;
    };
    const dispatcher = createMcpHttpDispatcher(serverFactory);
    const res = (await dispatcher.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/list' })) as {
      id: number;
      result: { ok: boolean };
    };
    expect(res.id).toBe(5);
    expect(res.result.ok).toBe(true);
    await dispatcher.close();
  });

  it('returns null for a notification (no id)', async () => {
    const dispatcher = createMcpHttpDispatcher(() => makeStubServer() as never);
    const res = await dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
    await dispatcher.close();
  });
});
