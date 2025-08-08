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
    // Allow server-to-server or same-origin requests
    if (!origin) return cb(null, true);
    // Allow everything in non-prod
    if (config.nodeEnv !== "production") return cb(null, true);

    const allowedRaw = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_BASE_URL || process.env.PUBLIC_CLIENT_BASE_URL || "").trim();
    if (!allowedRaw) return cb(new Error("CORS origin not allowed"), false);
    const allowedList = allowedRaw.split(",").map((s) => s.trim()).filter(Boolean);

    try {
      const originUrl = new URL(origin);
      const isAllowed = allowedList.some((allowed) => {
        try {
          const allowedUrl = new URL(allowed);
          const hostMatch = originUrl.hostname === allowedUrl.hostname;
          const protoMatch = originUrl.protocol === allowedUrl.protocol;
          const portMatch = allowedUrl.port ? originUrl.port === allowedUrl.port : true;
          return hostMatch && protoMatch && portMatch;
        } catch {
          return false;
        }
      });
      if (isAllowed) return cb(null, true);
    } catch {
      // fallthrough to deny
    }
    cb(new Error("CORS origin not allowed"), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "content-type",
    "x-requested-with",
    "authorization",
    "x-api-key",
    "accept",
  ],
  exposedHeaders: ["content-length"],
  credentials: true,
});
fastify.register(rateLimit, {
  max: (req, _res) => {
    const headerName = config.specialRateLimitHeader;
    const provided = String(req.headers[headerName] || "").trim();
    if (provided && config.specialRateLimitKey && provided === config.specialRateLimitKey) {
      return config.specialRateLimitMax;
    }
    return config.rateLimitMax;
  },
  timeWindow: config.rateLimitTimeWindow,
  keyGenerator: (req) => {
    // Prefer API key identity when present; fallback to IP
    const headerName = config.specialRateLimitHeader;
    const provided = String(req.headers[headerName] || "").trim();
    if (provided) return `apiKey:${provided}`;
    return req.ip;
  },
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
