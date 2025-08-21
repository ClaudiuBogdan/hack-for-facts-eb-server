import Fastify from "fastify";
import config from "./config";
import { registerHelmet } from "./plugins/helmet";
import { registerCors } from "./plugins/cors";
import { registerRateLimit } from "./plugins/rateLimit";
import { registerSwagger } from "./plugins/swagger";
import { registerMercurius } from "./plugins/mercurius";
import applicationRoutes from "./routes";

export async function buildServer() {
	const fastify = Fastify({
		logger: {
			level: config.nodeEnv === "development" ? "info" : "error",
		},
		bodyLimit: 1_000_000,
		maxParamLength: 200,
		trustProxy: true,
	});

	await registerHelmet(fastify);
	await registerCors(fastify);
	await registerRateLimit(fastify);
	await registerMercurius(fastify);
	await registerSwagger(fastify);
	await fastify.register(applicationRoutes);

	return fastify;
}

export async function startServer() {
	const fastify = await buildServer();
	try {
		await fastify.listen({ port: config.port, host: "0.0.0.0" });
		fastify.log.info(`🚀 Server is running on port ${config.port}`);
		fastify.log.info(`GraphQL endpoint: http://localhost:${config.port}/graphql`);
		if (config.nodeEnv === "development") {
			fastify.log.info(`GraphiQL playground: http://localhost:${config.port}/graphiql`);
		}
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}

	const gracefulShutdown = async (signal: string) => {
		fastify.log.info(`Received ${signal}. Shutting down gracefully...`);
		await fastify.close();
		process.exit(0);
	};

	process.on("SIGINT", () => gracefulShutdown("SIGINT"));
	process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

// If this module is executed directly, start the server
if (require.main === module) {
	startServer();
}


