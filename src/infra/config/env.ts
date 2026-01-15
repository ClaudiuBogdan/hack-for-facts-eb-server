/**
 * Environment configuration with validation
 * Uses TypeBox for runtime type checking
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Environment variable schema
 */
export const EnvSchema = Type.Object({
  // Server
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('production'), Type.Literal('test')],
    { default: 'development' }
  ),
  PORT: Type.Number({ default: 3000, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: '0.0.0.0' }),

  // Logging
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' }
  ),

  BUDGET_DATABASE_URL: Type.String(),
  USER_DATABASE_URL: Type.String(),
  REDIS_URL: Type.Optional(Type.String()),
  REDIS_PASSWORD: Type.Optional(Type.String()),
  REDIS_PREFIX: Type.Optional(Type.String()),

  // CORS
  ALLOWED_ORIGINS: Type.Optional(Type.String()),
  CLIENT_BASE_URL: Type.Optional(Type.String()),
  PUBLIC_CLIENT_BASE_URL: Type.Optional(Type.String()),

  // Auth (Clerk)
  CLERK_SECRET_KEY: Type.Optional(Type.String()),
  CLERK_JWT_KEY: Type.Optional(Type.String()),
  CLERK_AUTHORIZED_PARTIES: Type.Optional(Type.String()),

  // Short Links
  SHORT_LINK_DAILY_LIMIT: Type.Optional(Type.Number({ minimum: 1, default: 100 })),
  SHORT_LINK_CACHE_TTL: Type.Optional(Type.Number({ minimum: 0, default: 86400 })),

  // MCP (Model Context Protocol)
  MCP_ENABLED: Type.Optional(Type.Boolean({ default: false })),
  // SECURITY: SEC-004 - Default to true for fail-closed security
  MCP_AUTH_REQUIRED: Type.Optional(Type.Boolean({ default: true })),
  // SECURITY: Minimum 32 characters for sufficient entropy
  MCP_API_KEY: Type.Optional(Type.String({ minLength: 32 })),
  MCP_SESSION_TTL_SECONDS: Type.Optional(Type.Number({ minimum: 60, default: 3600 })),

  // GPT REST API
  // SECURITY: Minimum 32 characters for sufficient entropy
  GPT_API_KEY: Type.Optional(Type.String({ minLength: 32 })),

  // Email (Resend)
  /** Resend API key for sending emails */
  RESEND_API_KEY: Type.Optional(Type.String({ minLength: 20 })),
  /** Resend webhook secret for verifying webhook signatures */
  RESEND_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  /** Email from address for outbound emails */
  EMAIL_FROM_ADDRESS: Type.Optional(Type.String({ default: 'noreply@transparenta.eu' })),
  /** Whether email preview API is enabled (dev only) */
  EMAIL_PREVIEW_ENABLED: Type.Optional(Type.Boolean({ default: false })),
  /** Resend rate limit (requests per second) */
  RESEND_MAX_RPS: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 10 })),

  // Jobs (BullMQ)
  /** Whether BullMQ job processing is enabled */
  JOBS_ENABLED: Type.Optional(Type.Boolean({ default: false })),
  /** Number of concurrent workers per queue */
  JOBS_CONCURRENCY: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 50 })),
  /** BullMQ prefix for queue keys (NOT ioredis keyPrefix) */
  BULLMQ_PREFIX: Type.Optional(Type.String({ default: 'transparenta:jobs' })),
  /** Process role for deployment (api, worker, or both) */
  PROCESS_ROLE: Type.Optional(
    Type.Union([Type.Literal('api'), Type.Literal('worker'), Type.Literal('both')], {
      default: 'both',
    })
  ),

  // Notifications
  /** API key for triggering notification jobs */
  NOTIFICATION_TRIGGER_API_KEY: Type.Optional(Type.String({ minLength: 32 })),
  /** Platform base URL for building unsubscribe links */
  PLATFORM_BASE_URL: Type.Optional(Type.String()),

  // OpenTelemetry / SigNoz
  /** OTLP endpoint for SigNoz (Cloud: https://ingest.eu.signoz.cloud:443, Self-hosted: http://localhost:4318) */
  OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String()),
  /** OTLP headers (format: key=value,key2=value2). For SigNoz Cloud: signoz-ingestion-key=<your-key> */
  OTEL_EXPORTER_OTLP_HEADERS: Type.Optional(Type.String()),
  /** Service name for identification in SigNoz */
  OTEL_SERVICE_NAME: Type.Optional(Type.String({ default: 'transparenta-eu-server' })),
  /** Master switch to disable telemetry (set to 'true' to disable) */
  OTEL_SDK_DISABLED: Type.Optional(Type.Boolean({ default: false })),
  /** Trace exporter type ('none' to disable traces, 'console' for debug) */
  OTEL_TRACES_EXPORTER: Type.Optional(Type.String()),
  /** Metrics exporter type ('none' to disable metrics) */
  OTEL_METRICS_EXPORTER: Type.Optional(Type.String()),
  /** Logs exporter type ('none' to disable logs) */
  OTEL_LOGS_EXPORTER: Type.Optional(Type.String()),
  /** Trace sampling rate (0.0 - 1.0, where 1.0 = 100%) */
  OTEL_TRACES_SAMPLER_ARG: Type.Optional(Type.String()),
  /** Resource attributes (format: key=value,key2=value2) */
  OTEL_RESOURCE_ATTRIBUTES: Type.Optional(Type.String()),
});

export type Env = Static<typeof EnvSchema>;

/**
 * Parse and validate environment variables
 */
export const parseEnv = (env: NodeJS.ProcessEnv): Env => {
  const rawEnv = {
    NODE_ENV: env['NODE_ENV'] ?? 'development',
    PORT: env['PORT'] != null && env['PORT'] !== '' ? Number.parseInt(env['PORT'], 10) : 3000,
    HOST: env['HOST'] ?? '0.0.0.0',
    LOG_LEVEL: env['LOG_LEVEL'] ?? 'info',
    BUDGET_DATABASE_URL: env['BUDGET_DATABASE_URL'],
    USER_DATABASE_URL: env['USER_DATABASE_URL'],
    REDIS_URL: env['REDIS_URL'],
    REDIS_PASSWORD: env['REDIS_PASSWORD'],
    REDIS_PREFIX: env['REDIS_PREFIX'],
    ALLOWED_ORIGINS: env['ALLOWED_ORIGINS'],
    CLIENT_BASE_URL: env['CLIENT_BASE_URL'],
    PUBLIC_CLIENT_BASE_URL: env['PUBLIC_CLIENT_BASE_URL'],
    CLERK_SECRET_KEY: env['CLERK_SECRET_KEY'],
    CLERK_JWT_KEY: env['CLERK_JWT_KEY'],
    CLERK_AUTHORIZED_PARTIES: env['CLERK_AUTHORIZED_PARTIES'],
    SHORT_LINK_DAILY_LIMIT:
      env['SHORT_LINK_DAILY_LIMIT'] != null && env['SHORT_LINK_DAILY_LIMIT'] !== ''
        ? Number.parseInt(env['SHORT_LINK_DAILY_LIMIT'], 10)
        : 100,
    SHORT_LINK_CACHE_TTL:
      env['SHORT_LINK_CACHE_TTL'] != null && env['SHORT_LINK_CACHE_TTL'] !== ''
        ? Number.parseInt(env['SHORT_LINK_CACHE_TTL'], 10)
        : 86400,
    MCP_ENABLED: env['MCP_ENABLED'] === 'true',
    // SECURITY: SEC-004 - Default to true, only disable if explicitly set to 'false'
    MCP_AUTH_REQUIRED: env['MCP_AUTH_REQUIRED'] !== 'false',
    MCP_API_KEY: env['MCP_API_KEY'],
    MCP_SESSION_TTL_SECONDS:
      env['MCP_SESSION_TTL_SECONDS'] != null && env['MCP_SESSION_TTL_SECONDS'] !== ''
        ? Number.parseInt(env['MCP_SESSION_TTL_SECONDS'], 10)
        : 3600,
    // GPT REST API
    GPT_API_KEY: env['GPT_API_KEY'],
    // Email (Resend)
    RESEND_API_KEY: env['RESEND_API_KEY'],
    RESEND_WEBHOOK_SECRET: env['RESEND_WEBHOOK_SECRET'],
    EMAIL_FROM_ADDRESS: env['EMAIL_FROM_ADDRESS'] ?? 'noreply@transparenta.eu',
    EMAIL_PREVIEW_ENABLED: env['EMAIL_PREVIEW_ENABLED'] === 'true',
    RESEND_MAX_RPS:
      env['RESEND_MAX_RPS'] != null && env['RESEND_MAX_RPS'] !== ''
        ? Number.parseInt(env['RESEND_MAX_RPS'], 10)
        : 2,
    // Jobs (BullMQ)
    JOBS_ENABLED: env['JOBS_ENABLED'] === 'true',
    JOBS_CONCURRENCY:
      env['JOBS_CONCURRENCY'] != null && env['JOBS_CONCURRENCY'] !== ''
        ? Number.parseInt(env['JOBS_CONCURRENCY'], 10)
        : 5,
    BULLMQ_PREFIX: env['BULLMQ_PREFIX'] ?? 'transparenta:jobs',
    PROCESS_ROLE: (env['PROCESS_ROLE'] as 'api' | 'worker' | 'both' | undefined) ?? 'both',
    // Notifications
    NOTIFICATION_TRIGGER_API_KEY: env['NOTIFICATION_TRIGGER_API_KEY'],
    PLATFORM_BASE_URL: env['PLATFORM_BASE_URL'],
    // OpenTelemetry / SigNoz
    OTEL_EXPORTER_OTLP_ENDPOINT: env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    OTEL_EXPORTER_OTLP_HEADERS: env['OTEL_EXPORTER_OTLP_HEADERS'],
    OTEL_SERVICE_NAME: env['OTEL_SERVICE_NAME'] ?? 'transparenta-eu-server',
    OTEL_SDK_DISABLED: env['OTEL_SDK_DISABLED'] === 'true',
    OTEL_TRACES_EXPORTER: env['OTEL_TRACES_EXPORTER'],
    OTEL_METRICS_EXPORTER: env['OTEL_METRICS_EXPORTER'],
    OTEL_LOGS_EXPORTER: env['OTEL_LOGS_EXPORTER'],
    OTEL_TRACES_SAMPLER_ARG: env['OTEL_TRACES_SAMPLER_ARG'],
    OTEL_RESOURCE_ATTRIBUTES: env['OTEL_RESOURCE_ATTRIBUTES'],
  };

  // Validate against schema
  if (!Value.Check(EnvSchema, rawEnv)) {
    const errors = [...Value.Errors(EnvSchema, rawEnv)];
    const errorMessages = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    throw new Error(`Invalid environment configuration: ${errorMessages}`);
  }

  return rawEnv;
};

/**
 * Create a typed configuration object from environment
 */
export const createConfig = (env: Env) => ({
  server: {
    port: env.PORT,
    host: env.HOST,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },
  logger: {
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV !== 'production',
  },
  database: {
    budgetUrl: env.BUDGET_DATABASE_URL,
    userUrl: env.USER_DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
    password: env.REDIS_PASSWORD,
    prefix: env.REDIS_PREFIX,
  },
  cors: {
    allowedOrigins: env.ALLOWED_ORIGINS,
    clientBaseUrl: env.CLIENT_BASE_URL,
    publicClientBaseUrl: env.PUBLIC_CLIENT_BASE_URL,
  },
  auth: {
    /** Clerk secret key for server-side verification */
    clerkSecretKey: env.CLERK_SECRET_KEY,
    /** Clerk JWT public key (JWKS) for local verification */
    clerkJwtKey: env.CLERK_JWT_KEY,
    /** Comma-separated list of authorized parties (audience claim) */
    clerkAuthorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Whether auth is enabled (true if any Clerk config is set) */
    enabled:
      env.CLERK_SECRET_KEY !== undefined ||
      env.CLERK_JWT_KEY !== undefined ||
      env.CLERK_AUTHORIZED_PARTIES !== undefined,
  },
  shortLinks: {
    /** Maximum short links per user per 24 hours */
    dailyLimit: env.SHORT_LINK_DAILY_LIMIT ?? 100,
    /** Cache TTL in seconds for resolved links (0 = no caching) */
    cacheTtlSeconds: env.SHORT_LINK_CACHE_TTL ?? 86400,
  },
  mcp: {
    /** Whether MCP endpoints are enabled */
    enabled: env.MCP_ENABLED ?? false,
    /** Whether API key authentication is required for MCP (default: true for security) */
    authRequired: env.MCP_AUTH_REQUIRED ?? true,
    /** API key for MCP authentication (if authRequired is true) */
    apiKey: env.MCP_API_KEY,
    /** Session TTL in seconds */
    sessionTtlSeconds: env.MCP_SESSION_TTL_SECONDS ?? 3600,
    /** Client base URL for building shareable links (uses cors.clientBaseUrl as fallback) */
    clientBaseUrl: env.CLIENT_BASE_URL ?? '',
  },
  gpt: {
    /** API key for GPT REST API authentication */
    apiKey: env.GPT_API_KEY,
  },
  email: {
    /** Resend API key for sending emails */
    apiKey: env.RESEND_API_KEY,
    /** Resend webhook secret for verifying signatures */
    webhookSecret: env.RESEND_WEBHOOK_SECRET,
    /** From address for outbound emails */
    fromAddress: env.EMAIL_FROM_ADDRESS ?? 'noreply@transparenta.eu',
    /** Whether preview API is enabled */
    previewEnabled: env.EMAIL_PREVIEW_ENABLED ?? false,
    /** Rate limit (requests per second) */
    maxRps: env.RESEND_MAX_RPS ?? 2,
    /** Whether email is enabled (API key is set) */
    enabled: env.RESEND_API_KEY !== undefined,
  },
  jobs: {
    /** Whether BullMQ job processing is enabled */
    enabled: env.JOBS_ENABLED ?? false,
    /** Number of concurrent workers per queue */
    concurrency: env.JOBS_CONCURRENCY ?? 5,
    /** BullMQ prefix for queue keys */
    prefix: env.BULLMQ_PREFIX ?? 'transparenta:jobs',
    /** Process role for deployment */
    processRole: env.PROCESS_ROLE ?? 'both',
  },
  notifications: {
    /** API key for triggering notification jobs */
    triggerApiKey: env.NOTIFICATION_TRIGGER_API_KEY,
    /** Platform base URL for unsubscribe links */
    platformBaseUrl: env.PLATFORM_BASE_URL ?? env.CLIENT_BASE_URL ?? '',
    /** Whether notifications are enabled */
    enabled:
      env.RESEND_API_KEY !== undefined &&
      env.JOBS_ENABLED === true &&
      env.NOTIFICATION_TRIGGER_API_KEY !== undefined,
  },
  telemetry: {
    /** OTLP endpoint for SigNoz */
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    /** OTLP headers (includes ingestion key for SigNoz Cloud) */
    headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    /** Service name for identification */
    serviceName: env.OTEL_SERVICE_NAME ?? 'transparenta-eu-server',
    /** Whether telemetry is disabled */
    disabled: env.OTEL_SDK_DISABLED ?? false,
    /** Trace sampling rate */
    sampleRate: env.OTEL_TRACES_SAMPLER_ARG,
    /** Resource attributes */
    resourceAttributes: env.OTEL_RESOURCE_ATTRIBUTES,
  },
});

export type AppConfig = ReturnType<typeof createConfig>;
