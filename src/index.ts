import Fastify from "fastify";
import mercurius from "mercurius";
import fastifyCors from "@fastify/cors";
import { schema } from "./graphql/schemas";
import config from "./config";
import filterGeneratorRoutes from "./routes/filterGenerator";
import mcpRoutes from "./routes/mcp";
import applicationRoutes from "./routes";
import { refreshViews } from "./db/seed/view-refresh";

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
