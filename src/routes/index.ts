import { FastifyInstance } from "fastify";
import healthzRoutes from "./healthz";
import mcpRoutes from "./mcp";
import aiBasicRoutes from "./ai/entity-details";

export default async function applicationRoutes(fastify: FastifyInstance) {
    fastify.register(healthzRoutes);
    fastify.register(mcpRoutes);
    fastify.register(aiBasicRoutes);
}