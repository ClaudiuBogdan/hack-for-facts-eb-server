import { FastifyInstance } from "fastify";
import healthzRoutes from "./healthz";
import aiBasicRoutes from "./ai/entity-details";
import shortLinkRoutes from "./short-links";
import notificationRoutes from "./notifications";
import mcpRoutes from "./mcp";

export default async function applicationRoutes(fastify: FastifyInstance) {
    fastify.register(healthzRoutes);
    fastify.register(mcpRoutes);
    fastify.register(aiBasicRoutes);
    fastify.register(shortLinkRoutes);
    fastify.register(notificationRoutes);
}
