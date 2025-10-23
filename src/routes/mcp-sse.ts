import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer, mcpDefinition } from "../mcp/server";

interface PostMessageBody {
  sessionId?: string;
  message?: unknown;
}

interface PostMessageQuery {
  sessionId?: string;
}

export default async function mcpSseRoutes(fastify: FastifyInstance) {
  const requireApiKey = Boolean(process.env.MCP_API_KEY);
  const sessions = new Map<string, { server: ReturnType<typeof createMcpServer>; transport: SSEServerTransport }>();

  // Optional auth preHandler; off by default
  fastify.addHook("preHandler", async (req, reply) => {
    if (!requireApiKey) return;
    const key = req.headers["x-api-key"] as string | undefined;
    if (!key || key !== process.env.MCP_API_KEY) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  // SSE stream: establishes a session and returns the endpoint for POST messages
  fastify.get("/mcp/sse", (request: FastifyRequest, reply: FastifyReply) => {
    const nodeRes = reply.raw;
    reply.hijack();

    const server = createMcpServer();
    const transport = new SSEServerTransport("/mcp/messages", nodeRes);
    let sessionId: string | undefined;

    const cleanup = async () => {
      if (sessionId) {
        sessions.delete(sessionId);
      }
      try {
        await transport.close();
      } catch {
        /* swallow */
      }
      try {
        await server.close();
      } catch {
        /* swallow */
      }
    };

    nodeRes.on("close", () => {
      void cleanup();
    });

    void (async () => {
      try {
        await server.connect(transport);
        await transport.start();
        sessionId = transport.sessionId;
        sessions.set(sessionId, { server, transport });
      } catch (error) {
        await cleanup();
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "content-type": "application/json" });
          nodeRes.end(
            JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "SSE connection failed" })
          );
        } else {
          nodeRes.end();
        }
      }
    })();
  });

  // POST messages: client -> server JSON-RPC
  fastify.post(
    "/mcp/messages",
    async (
      request: FastifyRequest<{ Body: PostMessageBody; Querystring: PostMessageQuery }>,
      reply: FastifyReply
    ) => {
      const body = (request.body || {}) as PostMessageBody;
      const query = (request.query || {}) as PostMessageQuery;
      const sessionId = body.sessionId ?? query.sessionId;
      if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId is required" });

      const session = sessions.get(sessionId);
      if (!session) return reply.code(404).send({ ok: false, error: "session not found" });

      try {
        await session.transport.handleMessage(body.message);
      } catch (error) {
        return reply
          .code(400)
          .send({ ok: false, error: error instanceof Error ? error.message : "invalid message" });
      }

      return reply.code(202).send({ ok: true });
    }
  );

  // Human-inspectable definition
  fastify.get("/mcp/definition", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ ok: true, data: mcpDefinition });
  });

  return fastify;
}


