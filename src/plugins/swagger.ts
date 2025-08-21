import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import config from "../config";

export async function registerSwagger(fastify: FastifyInstance) {
	await fastify.register(fastifySwagger, {
		openapi: {
			info: {
				title: "Hack for Facts - Public Spending API",
				description:
					"REST endpoints designed for AI agents and tools to fetch Romanian public spending data in a compact, structured format.",
				version: "1.0.0",
			},
			servers: [{ url: process.env.OPENAPI_SERVER_URL?.replace(/\/$/, "") || "/" }],
			tags: [
				{ name: "AI", description: "AI-friendly simplified and aggregated endpoints" },
				{ name: "Health", description: "Health check endpoints" },
			],
		},
	});

	if (config.nodeEnv !== "production") {
		await fastify.register(fastifySwaggerUI, {
			routePrefix: "/docs",
			staticCSP: true,
		});
	}
}


