import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "../mcp/server";

const mcpServer = createMcpServer();
const transports: Record<string, StreamableHTTPServerTransport> = {};

function verifyApiKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const configuredApiKey = (process.env.MCP_API_KEY || "").trim();
  if (!configuredApiKey) return true;
  const providedKey = String(request.headers["x-api-key"] || "");
  if (providedKey !== configuredApiKey) {
    reply.code(401).type("application/json").send({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return false;
  }
  return true;
}

export default async function mcpRoutes(fastify: FastifyInstance) {
  fastify.post("/mcp", async (request, reply) => {
    if (!verifyApiKey(request, reply)) return;

    const body = request.body as any;
    const sessionIdHeader = (request.headers["mcp-session-id"] as string | undefined) ?? undefined;
    let transport = sessionIdHeader ? transports[sessionIdHeader] : undefined;

    if (!transport) {
      if (!isInitializeRequest(body)) {
        reply.code(400).type("application/json").send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports[id] = transport!;
        },
      });

      transport.onclose = () => {
        const id = transport!.sessionId;
        if (id && transports[id]) delete transports[id];
      };

      await mcpServer.connect(transport);
    }

    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, body);
  });

  const handleSession = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyApiKey(request, reply)) return;

    const sessionId = String(request.headers["mcp-session-id"] || "");
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      reply.code(400).send("Invalid or missing session ID");
      return;
    }

    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
  };

  fastify.get("/mcp", handleSession);
  fastify.delete("/mcp", handleSession);

  return fastify;
}


