import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import pool from "../db/connection";

export default async function healthzRoutes(fastify: FastifyInstance) {
  fastify.get("/healthz", {
    schema: {
      tags: ["Health"],
      description: "Liveness and DB connectivity probe.",
      response: {
        200: { type: "string", example: "OK" },
        503: { type: "string", example: "Service Unavailable" },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check database connection
      await pool.query("SELECT 1");
      reply.code(200).send("OK");
    } catch (error) {
      fastify.log.error("Health check failed");
      fastify.log.error(error, "Error details:");
      reply.code(503).send("Service Unavailable");
    }
  });
} 