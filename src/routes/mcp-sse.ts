import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer, mcpDefinition } from "../mcp/server";

interface PostMessageBody {
  sessionId?: string;
  message?: unknown;
}

export default async function mcpSseRoutes(fastify: FastifyInstance) {
  const requireApiKey = Boolean(process.env.MCP_API_KEY);
  const connections = new Map<string, ReturnType<typeof createMcpServer>>();
  const transports = new Map<string, SSEServerTransport>();

  // Optional auth preHandler; off by default
  fastify.addHook("preHandler", async (req, reply) => {
    if (!requireApiKey) return;
    const key = req.headers["x-api-key"] as string | undefined;
    if (!key || key !== process.env.MCP_API_KEY) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  // SSE stream: establishes a session and returns the endpoint for POST messages
  fastify.get("/mcp/sse", async (request: FastifyRequest, reply: FastifyReply) => {
    const server = createMcpServer();
    const nodeRes = reply.raw;
    const transport = new SSEServerTransport("/mcp/messages", nodeRes);
    await server.connect(transport);
    await transport.start();
    const sessionId = transport.sessionId;
    connections.set(sessionId, server);
    transports.set(sessionId, transport);

    nodeRes.on("close", async () => {
      try {
        await server.close();
      } catch {}
      connections.delete(sessionId);
      transports.delete(sessionId);
    });
    return reply.hijack();
  });

  // POST messages: client -> server JSON-RPC
  fastify.post("/mcp/messages", async (request: FastifyRequest<{ Body: PostMessageBody }>, reply: FastifyReply) => {
    const { sessionId, message } = (request.body || {}) as PostMessageBody;
    if (!sessionId) return reply.code(400).send({ ok: false, error: "sessionId is required" });
    const transport = transports.get(sessionId);
    if (!transport) return reply.code(404).send({ ok: false, error: "session not found" });

    await transport.handleMessage(message);
    return reply.code(202).send({ ok: true });
  });

  // Human-inspectable definition
  fastify.get("/mcp/definition", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ ok: true, data: mcpDefinition });
  });

  return fastify;
}


