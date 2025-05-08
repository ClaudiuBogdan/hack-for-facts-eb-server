import { FastifyInstance } from "fastify";
import healthzRoutes from "./healthz";
import filterGeneratorRoutes from "./filterGenerator";
import mcpRoutes from "./mcp";

export default async function applicationRoutes(fastify: FastifyInstance) {
    fastify.register(healthzRoutes);
    fastify.register(filterGeneratorRoutes);
    fastify.register(mcpRoutes);
} 