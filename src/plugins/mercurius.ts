import type { FastifyInstance, FastifyRequest } from "fastify";
import mercurius from "mercurius";
import { getAuthContext } from "../utils/auth";

// Import your centralized configuration and GraphQL schema
import config from "../config";
import { schema } from "../graphql/schemas";
import depthLimit from "graphql-depth-limit";
import { NoSchemaIntrospectionCustomRule } from "graphql";

/**
 * Registers the Mercurius GraphQL plugin with the Fastify instance,
 * using simple JWT token verification to extract userId.
 * @param fastify The Fastify server instance.
 */

export async function registerMercurius(fastify: FastifyInstance) {
	await fastify.register(mercurius, {
		schema,
		graphiql: config.nodeEnv !== "production",
		ide: false,
		path: "/graphql",
		validationRules:
			config.nodeEnv === "production"
				? [depthLimit(8), NoSchemaIntrospectionCustomRule]
				: [depthLimit(8)],
		allowBatchedQueries: false,
		context: async (request) => {
			const auth = await getAuthContext(request);
			return { auth };
		},
	});
}