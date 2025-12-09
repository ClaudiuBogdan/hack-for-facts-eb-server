/**
 * MCP HTTP Routes
 *
 * Provides HTTP endpoints for MCP protocol communication.
 * Supports session management via StreamableHTTPServerTransport.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McpSessionStore, McpRateLimiter } from '../../core/ports.js';
import type { McpConfig, McpSession } from '../../core/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeMcpRoutesDeps {
  mcpServer: McpServer;
  sessionStore: McpSessionStore;
  rateLimiter?: McpRateLimiter;
  config: McpConfig;
}

// In-memory transport registry (transports are not serializable)
const transports = new Map<string, StreamableHTTPServerTransport>();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a unique session ID.
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `mcp-${timestamp}-${random}`;
}

/**
 * Verifies API key if configured.
 */
function verifyApiKey(request: FastifyRequest, config: McpConfig): boolean {
  const configuredApiKey = config.apiKey;
  if (configuredApiKey === undefined || configuredApiKey === '') {
    return true; // No API key configured, allow all
  }
  const providedKey = request.headers['x-api-key'];
  return providedKey === configuredApiKey;
}

/**
 * Sends an MCP JSON-RPC error response.
 */
function sendMcpError(
  reply: FastifyReply,
  code: number,
  message: string,
  httpStatus: number,
  headers?: Record<string, string>
): void {
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      reply.header(key, value);
    }
  }
  reply.code(httpStatus).type('application/json').send({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates MCP HTTP routes for Fastify.
 */
export async function makeMcpRoutes(
  fastify: FastifyInstance,
  deps: MakeMcpRoutesDeps
): Promise<void> {
  const { mcpServer, sessionStore, rateLimiter, config } = deps;

  // ─────────────────────────────────────────────────────────────────────────
  // POST /mcp - Initialize session or handle MCP requests
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/mcp', async (request, reply) => {
    // Auth check
    if (config.authRequired && !verifyApiKey(request, config)) {
      sendMcpError(reply, -32001, 'Unauthorized', 401);
      return;
    }

    // Rate limit check
    const sessionIdHeader = request.headers['mcp-session-id'] as string | undefined;
    const rateLimitKey = sessionIdHeader ?? request.ip;
    if (rateLimiter !== undefined) {
      const allowed = await rateLimiter.isAllowed(rateLimitKey);
      if (!allowed) {
        sendMcpError(reply, -32003, 'Rate limit exceeded', 429);
        return;
      }
      await rateLimiter.recordRequest(rateLimitKey);
    }

    const body = request.body as Record<string, unknown>;
    let transport = sessionIdHeader !== undefined ? transports.get(sessionIdHeader) : undefined;

    // Check if this is an initialize request
    if (transport === undefined) {
      if (!isInitializeRequest(body)) {
        // Session required but not found
        sendMcpError(
          reply,
          -32002,
          'MCP connection session not found or expired. Please reinitialize.',
          409,
          { 'Mcp-Reinit-Required': 'true' }
        );
        return;
      }

      // Create new session and transport
      const sessionId = generateSessionId();
      const session: McpSession = {
        id: sessionId,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id: string) => {
          transports.set(id, newTransport);
          void sessionStore.set(session);
        },
      });

      newTransport.onclose = () => {
        const id = newTransport.sessionId;
        if (id !== undefined) {
          transports.delete(id);
          void sessionStore.delete(id);
        }
      };

      transport = newTransport;

      // Connect to MCP server
      await mcpServer.connect(transport);
    } else {
      // Update session access time
      if (sessionIdHeader !== undefined) {
        await sessionStore.touch(sessionIdHeader);
      }
    }

    // Hijack the response and let transport handle it
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, body);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /mcp - Handle SSE streaming for existing session
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/mcp', async (request, reply) => {
    // Auth check
    if (config.authRequired && !verifyApiKey(request, config)) {
      sendMcpError(reply, -32001, 'Unauthorized', 401);
      return;
    }

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (sessionId === undefined) {
      sendMcpError(reply, -32002, 'Session ID required', 409, { 'Mcp-Reinit-Required': 'true' });
      return;
    }

    const transport = transports.get(sessionId);
    if (transport === undefined) {
      sendMcpError(reply, -32002, 'Session not found or expired', 409, {
        'Mcp-Reinit-Required': 'true',
      });
      return;
    }

    // Update session access time
    await sessionStore.touch(sessionId);

    // Hijack and handle streaming
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /mcp - Terminate session
  // ─────────────────────────────────────────────────────────────────────────

  fastify.delete('/mcp', async (request, reply) => {
    // Auth check
    if (config.authRequired && !verifyApiKey(request, config)) {
      sendMcpError(reply, -32001, 'Unauthorized', 401);
      return;
    }

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (sessionId === undefined) {
      reply.code(400).send({ error: 'Session ID required' });
      return;
    }

    const transport = transports.get(sessionId);
    if (transport !== undefined) {
      await transport.close();
      transports.delete(sessionId);
    }
    await sessionStore.delete(sessionId);

    reply.code(204).send();
  });
}
