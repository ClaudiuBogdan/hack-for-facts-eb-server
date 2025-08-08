import Fastify from "fastify";
import mercurius from "mercurius";
import fastifyCors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import depthLimit from "graphql-depth-limit";
import { NoSchemaIntrospectionCustomRule } from "graphql";
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
  bodyLimit: 1_000_000, // ~1MB
  maxParamLength: 200,
  trustProxy: true,
});

// Register plugins
fastify.register(helmet);
fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    // Allow in dev; restrict to configured client base in prod
    if (!origin) return cb(null, true);
    const isDev = config.nodeEnv !== "production";
    if (isDev) return cb(null, true);
    const allowed = (process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "").replace(/\/$/, "");
    if (allowed && origin.startsWith(allowed)) return cb(null, true);
    cb(new Error("CORS origin not allowed"), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
});
fastify.register(rateLimit, {
  max: 300, // per timeWindow per ip
  timeWindow: "1 minute",
});

// Register Mercurius GraphQL
fastify.register(mercurius, {
  schema,
  graphiql: config.nodeEnv !== "production",
  ide: false,
  path: "/graphql",
  validationRules: config.nodeEnv === "production" ? [depthLimit(8), NoSchemaIntrospectionCustomRule] : [depthLimit(8)],
  allowBatchedQueries: false,
  queryDepth: 8,
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

if (config.nodeEnv !== "production") {
  fastify.register(fastifySwaggerUI, {
    routePrefix: "/docs",
    staticCSP: true,
  });
}

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
