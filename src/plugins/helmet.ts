import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import config from "../config";

export async function registerHelmet(fastify: FastifyInstance) {
	// Allow GraphiQL to load in development
	const helmetConfig = config.nodeEnv !== "production"
		? {
				contentSecurityPolicy: {
					directives: {
						defaultSrc: ["'self'"],
						scriptSrc: ["'self'", "https://unpkg.com"],
						connectSrc: ["'self'", "https://unpkg.com"],
						// Add other directives if needed (e.g., styleSrc for CSS if GraphiQL loads styles)
					},
				},
			}
		: {};

	await fastify.register(helmet, helmetConfig as any);
}


