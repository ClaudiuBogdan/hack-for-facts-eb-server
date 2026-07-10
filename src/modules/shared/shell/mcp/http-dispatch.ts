/**
 * Shared Kernel — MCP HTTP dispatch (foundation §6.3).
 *
 * The SDK's `StreamableHTTPServerTransport` routes through `@hono/node-server`,
 * which schedules a delayed `forceClose` that calls `socket.destroySoon()` —
 * absent on Fastify's `reply.raw` socket (and on the inject() dummy socket),
 * crashing the process with "socket.destroySoon is not a function".
 *
 * Instead each HTTP request gets a FRESH `McpServer` + in-process transport
 * (MCP lifecycle/`initialize` state is per-session, so a single shared server
 * would let one client's protocol state leak into another's). We feed the
 * request's JSON-RPC message in, capture the matching response, tear the server
 * down, and return. No sockets, no hono bridge — works under a real listen and
 * Fastify `inject()` alike.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

interface DispatchTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

/** Factory for a freshly-built MCP server (kernel + module tools registered). */
export type McpServerFactory = () => McpServer;

export interface McpHttpDispatcher {
  /** Dispatch one JSON-RPC request and return the response (or null for notifications). */
  dispatch(message: unknown): Promise<JsonRpcMessage | null>;
  close(): Promise<void>;
}

/** True only for a JSON-RPC RESPONSE (has result/error, no method). */
const isResponse = (m: JsonRpcMessage): boolean =>
  m.method === undefined && (m.result !== undefined || m.error !== undefined);

const invalidRequest = (): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32_600, message: 'Invalid Request' },
});

const isJsonRpcRequest = (raw: unknown): raw is JsonRpcMessage => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const message = raw as JsonRpcMessage;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.method === '') {
    return false;
  }
  return (
    message.id === undefined ||
    typeof message.id === 'string' ||
    (typeof message.id === 'number' && Number.isFinite(message.id))
  );
};

/**
 * Build the per-request dispatcher. Each `dispatch` spins up a fresh server +
 * transport, runs one request to completion, and disposes the server — so MCP
 * session state never crosses requests. Notifications (no `id`) resolve to null.
 */
export const createMcpHttpDispatcher = (makeServer: McpServerFactory): McpHttpDispatcher => {
  let closed = false;

  return {
    async dispatch(raw: unknown): Promise<JsonRpcMessage | null> {
      if (closed)
        return { jsonrpc: '2.0', id: null, error: { code: -32_000, message: 'dispatcher closed' } };

      if (!isJsonRpcRequest(raw)) return invalidRequest();

      const message = raw;
      const clientId = message.id;
      const server = makeServer();

      let resolveOnce: ((m: JsonRpcMessage | null) => void) | undefined;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (messageToSend: JsonRpcMessage | null): void => {
        const resolve = resolveOnce;
        if (resolve === undefined) return;
        resolveOnce = undefined;
        if (responseTimer !== undefined) {
          clearTimeout(responseTimer);
          responseTimer = undefined;
        }
        resolve(messageToSend);
      };

      const transport: DispatchTransport = {
        start: () => Promise.resolve(),
        close: () => Promise.resolve(),
        // Capture the FIRST response for this request id (ignore server-
        // originated requests/notifications, which carry a method).
        send: (out) => {
          if (isResponse(out) && out.id === clientId) {
            settle(out);
          }
          return Promise.resolve();
        },
      };

      try {
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

        // Notification: fire and forget, no response expected.
        if (clientId === undefined) {
          transport.onmessage?.(message);
          return null;
        }

        return await new Promise<JsonRpcMessage | null>((resolve) => {
          resolveOnce = resolve;
          responseTimer = setTimeout(() => {
            settle({
              jsonrpc: '2.0',
              id: clientId,
              error: { code: -32_000, message: 'MCP request timed out' },
            });
          }, 30_000);
          responseTimer.unref();
          transport.onmessage?.(message);
        });
      } finally {
        if (responseTimer !== undefined) clearTimeout(responseTimer);
        await server.close();
      }
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
  };
};
