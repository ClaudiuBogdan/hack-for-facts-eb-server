import type { FastifyInstance, FastifyRequest } from "fastify";
import mercurius from "mercurius";
import { verifyToken } from "@clerk/backend";

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

// Extract JWT token from request headers or cookies
function extractToken(request: FastifyRequest): string | null {
	// Try Authorization header first
	const authHeader = request.headers.authorization;
	if (authHeader?.startsWith('Bearer ')) {
		return authHeader.substring(7);
	}

	// Try __session cookie
	const sessionCookie = request.headers.cookie?.split(';')
		.find(c => c.trim().startsWith('__session='));
	if (sessionCookie) {
		return sessionCookie.split('=')[1];
	}

	return null;
}

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
			let auth: { userId: string | null } = { userId: null };

			// Only attempt verification if JWT key is configured
			if (!config.clerkJwtKey) {
				return { auth };
			}

			const token = extractToken(request);
			if (!token) {
				return { auth };
			}

			try {
				// Verify token networklessly using JWT public key
				const payload = await verifyToken(token, {
					jwtKey: config.clerkJwtKey,
					authorizedParties: config.clerkAuthorizedParties?.length
						? config.clerkAuthorizedParties
						: undefined,
				});

				// Extract userId from the verified token
				if (payload.sub) {
					auth = { userId: payload.sub };
				}
			} catch (error: any) {
				request.log.debug({ error: error.message }, 'JWT verification failed');
			}

			return { auth };
		},
	});
}