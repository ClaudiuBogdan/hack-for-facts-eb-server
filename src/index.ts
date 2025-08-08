import Fastify from "fastify";
import mercurius from "mercurius";
import fastifyCors from "@fastify/cors";
import { schema } from "./graphql/schemas";
import config from "./config";
import applicationRoutes from "./routes";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";

// Initialize Fastify server
const fastify = Fastify({
  logger: {
    level: config.nodeEnv === "development" ? "info" : "error",
  },
});

// Register plugins
fastify.register(fastifyCors, {
  origin: true, // allow all origins for development
  methods: ["GET", "POST", "OPTIONS"],
});

// Register Mercurius GraphQL
fastify.register(mercurius, {
  schema,
  graphiql: true,  // TODO config.nodeEnv === "development", // Enable GraphiQL in development
  path: "/graphql",
});

// Register Swagger/OpenAPI for REST endpoints
fastify.register(fastifySwagger, {
  openapi: {
    info: {
      title: "Hack for Facts - Public Spending API",
      description: "REST endpoints designed for AI agents and tools to fetch Romanian public spending data in a compact, structured format.",
      version: "1.0.0",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "AI", description: "AI-friendly simplified and aggregated endpoints" },
      { name: "Health", description: "Health check endpoints" },
    ],
  },
});

fastify.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  staticCSP: true,
});

// Register routes
fastify.register(applicationRoutes);

// Start the server
const start = async () => {
  try {
    // Start the server
    // await refreshViews();
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`🚀 Server is running on port ${config.port}`);
    console.log(`GraphQL endpoint: http://localhost:${config.port}/graphql`);
    if (config.nodeEnv === "development") {
      console.log(
        `GraphiQL playground: http://localhost:${config.port}/graphiql`
      );
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Start the server
start();
