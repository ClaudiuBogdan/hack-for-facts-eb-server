import { FastifyInstance } from "fastify";
import healthzRoutes from "./healthz";
import filterGeneratorRoutes from "./filterGenerator";
import mcpRoutes from "./mcp";
import aiBasicRoutes from "./ai-basic";
import aiAdvancedRoutes from "./ai-advanced";

export default async function applicationRoutes(fastify: FastifyInstance) {
    fastify.register(healthzRoutes);
    fastify.register(filterGeneratorRoutes);
    fastify.register(mcpRoutes);
    fastify.register(aiBasicRoutes);
    fastify.register(aiAdvancedRoutes);
}