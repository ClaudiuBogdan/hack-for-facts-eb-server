import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import pool from "../db/connection";

export default async function healthzRoutes(fastify: FastifyInstance) {
  fastify.get("/healthz", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Check database connection
      await pool.query("SELECT 1");
      reply.code(200).send("OK");
    } catch (error) {
      fastify.log.error("Health check failed:", error);
      reply.code(503).send("Service Unavailable");
    }
  });
} 