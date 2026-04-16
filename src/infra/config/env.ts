/**
 * Environment configuration with validation
 * Uses TypeBox for runtime type checking
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { createCacheConfig } from '../cache/client.js';

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
  INS_DATABASE_URL: Type.String(),
  USER_DATABASE_URL: Type.String(),
  DATABASE_SSL: Type.Optional(Type.Boolean({ default: false })),
  DATABASE_SSL_REJECT_UNAUTHORIZED: Type.Optional(Type.Boolean({ default: true })),
  REDIS_URL: Type.Optional(Type.String()),
  REDIS_PASSWORD: Type.Optional(Type.String()),
  REDIS_PREFIX: Type.Optional(Type.String()),
  CACHE_BACKEND: Type.Union([
    Type.Literal('disabled'),
    Type.Literal('memory'),
    Type.Literal('redis'),
    Type.Literal('multi'),
  ]),
  CACHE_DEFAULT_TTL_MS: Type.Number({ minimum: 0 }),
  CACHE_MEMORY_MAX_ENTRIES: Type.Number({ minimum: 1 }),
  CACHE_L1_MAX_ENTRIES: Type.Number({ minimum: 1 }),
  BULLMQ_REDIS_URL: Type.Optional(Type.String()),
  BULLMQ_REDIS_PASSWORD: Type.Optional(Type.String()),

  // CORS
  ALLOWED_ORIGINS: Type.Optional(Type.String()),
  CLIENT_BASE_URL: Type.Optional(Type.String()),
  PUBLIC_CLIENT_BASE_URL: Type.Optional(Type.String()),

  // Auth (Clerk)
  CLERK_SECRET_KEY: Type.Optional(Type.String()),
  CLERK_JWT_KEY: Type.Optional(Type.String()),
  CLERK_AUTHORIZED_PARTIES: Type.Optional(Type.String()),
  CLERK_WEBHOOK_SIGNING_SECRET: Type.Optional(Type.String({ minLength: 32 })),

  // Short Links
  SHORT_LINK_DAILY_LIMIT: Type.Optional(Type.Number({ minimum: 1, default: 100 })),
  SHORT_LINK_CACHE_TTL: Type.Optional(Type.Number({ minimum: 0, default: 86400 })),

  // Rate Limiting
  RATE_LIMIT_MAX: Type.Optional(Type.Number({ minimum: 1, default: 300 })),
  RATE_LIMIT_WINDOW: Type.Optional(Type.String({ default: '1 minute' })),
  SPECIAL_RATE_LIMIT_HEADER: Type.Optional(Type.String()),
  SPECIAL_RATE_LIMIT_KEY: Type.Optional(Type.String({ minLength: 32 })),
  SPECIAL_RATE_LIMIT_MAX: Type.Optional(Type.Number({ minimum: 1, default: 6000 })),

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
  /** Email from address for outbound emails. Required when Resend sending is enabled. */
  EMAIL_FROM_ADDRESS: Type.Optional(Type.String({ minLength: 1 })),
  /** Campaign email from address used for Funky Citizens campaign emails. */
  FUNKY_EMAIL_FROM_ADDRESS: Type.Optional(Type.String({ minLength: 1 })),
  /** Optional CC recipients for campaign institution emails. */
  FUNKY_EMAIL_FROM_ADDRESS_CC: Type.Optional(Type.String()),
  /** Reply-To address used to capture campaign email replies automatically. */
  FUNKY_EMAIL_REPLY_TO_ADDRESS: Type.Optional(Type.String({ minLength: 1 })),
  /** Whether email preview API is enabled (dev only) */
  EMAIL_PREVIEW_ENABLED: Type.Optional(Type.Boolean({ default: false })),
  /** Resend rate limit (requests per second) */
  RESEND_MAX_RPS: Type.Optional(Type.Number({ default: 2, minimum: 1, maximum: 10 })),

  // Jobs (BullMQ)
  /** Number of concurrent workers per queue */
  JOBS_CONCURRENCY: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 50 })),
  /** BullMQ prefix for queue keys (NOT ioredis keyPrefix) */
  BULLMQ_PREFIX: Type.Optional(Type.String({ default: 'transparenta:jobs' })),
  /** Interval for the stuck-sending recovery sweeper */
  NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES: Type.Optional(
    Type.Number({ default: 15, minimum: 1, maximum: 1440 })
  ),
  /** Threshold after which a sending delivery is considered stuck */
  NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES: Type.Optional(
    Type.Number({ default: 15, minimum: 1, maximum: 1440 })
  ),

  // Notifications
  /** API key for triggering notification jobs */
  NOTIFICATION_TRIGGER_API_KEY: Type.Optional(Type.String({ minLength: 32 })),
  /** API base URL for building unsubscribe/API links in emails */
  API_BASE_URL: Type.String(),
  /** HMAC secret for signing unsubscribe tokens */
  UNSUBSCRIBE_HMAC_SECRET: Type.Optional(Type.String({ minLength: 32 })),

  // Learning Progress Campaign Admin API
  ENABLED_ADMIN_CAMPAIGNS: Type.Optional(Type.String()),

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

  // Proxy
  /** Trust proxy setting for Fastify (e.g., true, false, 1, 'loopback', CIDR range) */
  TRUST_PROXY: Type.Optional(
    Type.Union([Type.Boolean(), Type.Number({ minimum: 0 }), Type.String({ minLength: 1 })])
  ),
});

export type Env = Static<typeof EnvSchema>;

const parseTrustProxy = (value: string | undefined): boolean | number | string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return undefined;
  }

  if (trimmedValue === 'true') {
    return true;
  }

  if (trimmedValue === 'false') {
    return false;
  }

  if (/^\d+$/.test(trimmedValue)) {
    return Number.parseInt(trimmedValue, 10);
  }

  return trimmedValue;
};

/**
 * Parse and validate environment variables
 */
export const parseEnv = (env: NodeJS.ProcessEnv): Env => {
  const cacheConfig = createCacheConfig(env);
  const rawEnv = {
    NODE_ENV: env['NODE_ENV'] ?? 'development',
    PORT: env['PORT'] != null && env['PORT'] !== '' ? Number.parseInt(env['PORT'], 10) : 3000,
    HOST: env['HOST'] ?? '0.0.0.0',
    LOG_LEVEL: env['LOG_LEVEL'] ?? 'info',
    BUDGET_DATABASE_URL: env['BUDGET_DATABASE_URL'],
    INS_DATABASE_URL: env['INS_DATABASE_URL'],
    USER_DATABASE_URL: env['USER_DATABASE_URL'],
    DATABASE_SSL: env['DATABASE_SSL'] === 'true',
    DATABASE_SSL_REJECT_UNAUTHORIZED: env['DATABASE_SSL_REJECT_UNAUTHORIZED'] !== 'false',
    REDIS_URL: env['REDIS_URL'],
    REDIS_PASSWORD: env['REDIS_PASSWORD'],
    REDIS_PREFIX: env['REDIS_PREFIX'],
    CACHE_BACKEND: cacheConfig.backend,
    CACHE_DEFAULT_TTL_MS: cacheConfig.defaultTtlMs,
    CACHE_MEMORY_MAX_ENTRIES: cacheConfig.memoryMaxEntries,
    CACHE_L1_MAX_ENTRIES: cacheConfig.l1MaxEntries,
    BULLMQ_REDIS_URL: env['BULLMQ_REDIS_URL'],
    BULLMQ_REDIS_PASSWORD: env['BULLMQ_REDIS_PASSWORD'],
    ALLOWED_ORIGINS: env['ALLOWED_ORIGINS'],
    CLIENT_BASE_URL: env['CLIENT_BASE_URL'],
    PUBLIC_CLIENT_BASE_URL: env['PUBLIC_CLIENT_BASE_URL'],
    CLERK_SECRET_KEY: env['CLERK_SECRET_KEY'],
    CLERK_JWT_KEY: env['CLERK_JWT_KEY'],
    CLERK_AUTHORIZED_PARTIES: env['CLERK_AUTHORIZED_PARTIES'],
    CLERK_WEBHOOK_SIGNING_SECRET: env['CLERK_WEBHOOK_SIGNING_SECRET'],
    SHORT_LINK_DAILY_LIMIT:
      env['SHORT_LINK_DAILY_LIMIT'] != null && env['SHORT_LINK_DAILY_LIMIT'] !== ''
        ? Number.parseInt(env['SHORT_LINK_DAILY_LIMIT'], 10)
        : 100,
    SHORT_LINK_CACHE_TTL:
      env['SHORT_LINK_CACHE_TTL'] != null && env['SHORT_LINK_CACHE_TTL'] !== ''
        ? Number.parseInt(env['SHORT_LINK_CACHE_TTL'], 10)
        : 86400,
    // Rate Limiting
    RATE_LIMIT_MAX:
      env['RATE_LIMIT_MAX'] != null && env['RATE_LIMIT_MAX'] !== ''
        ? Number.parseInt(env['RATE_LIMIT_MAX'], 10)
        : 300,
    RATE_LIMIT_WINDOW: env['RATE_LIMIT_WINDOW'] ?? '1 minute',
    SPECIAL_RATE_LIMIT_HEADER: env['SPECIAL_RATE_LIMIT_HEADER'],
    SPECIAL_RATE_LIMIT_KEY: env['SPECIAL_RATE_LIMIT_KEY'],
    SPECIAL_RATE_LIMIT_MAX:
      env['SPECIAL_RATE_LIMIT_MAX'] != null && env['SPECIAL_RATE_LIMIT_MAX'] !== ''
        ? Number.parseInt(env['SPECIAL_RATE_LIMIT_MAX'], 10)
        : 6000,
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
    EMAIL_FROM_ADDRESS: env['EMAIL_FROM_ADDRESS'],
    FUNKY_EMAIL_FROM_ADDRESS: env['FUNKY_EMAIL_FROM_ADDRESS'],
    FUNKY_EMAIL_FROM_ADDRESS_CC: env['FUNKY_EMAIL_FROM_ADDRESS_CC'],
    FUNKY_EMAIL_REPLY_TO_ADDRESS: env['FUNKY_EMAIL_REPLY_TO_ADDRESS'],
    EMAIL_PREVIEW_ENABLED: env['EMAIL_PREVIEW_ENABLED'] === 'true',
    RESEND_MAX_RPS:
      env['RESEND_MAX_RPS'] != null && env['RESEND_MAX_RPS'] !== ''
        ? Number.parseInt(env['RESEND_MAX_RPS'], 10)
        : 2,
    // Jobs (BullMQ)
    JOBS_CONCURRENCY:
      env['JOBS_CONCURRENCY'] != null && env['JOBS_CONCURRENCY'] !== ''
        ? Number.parseInt(env['JOBS_CONCURRENCY'], 10)
        : 5,
    BULLMQ_PREFIX: env['BULLMQ_PREFIX'] ?? 'transparenta:jobs',
    NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES:
      env['NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES'] != null &&
      env['NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES'] !== ''
        ? Number.parseInt(env['NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES'], 10)
        : 15,
    NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES:
      env['NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES'] != null &&
      env['NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES'] !== ''
        ? Number.parseInt(env['NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES'], 10)
        : 15,
    // Notifications
    NOTIFICATION_TRIGGER_API_KEY: env['NOTIFICATION_TRIGGER_API_KEY'],
    API_BASE_URL: env['API_BASE_URL'],
    UNSUBSCRIBE_HMAC_SECRET: env['UNSUBSCRIBE_HMAC_SECRET'],
    // Learning Progress Campaign Admin API
    ENABLED_ADMIN_CAMPAIGNS: env['ENABLED_ADMIN_CAMPAIGNS'],
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
    TRUST_PROXY: parseTrustProxy(env['TRUST_PROXY']),
  };

  // Validate against schema
  if (!Value.Check(EnvSchema, rawEnv)) {
    const errors = [...Value.Errors(EnvSchema, rawEnv)];
    const errorMessages = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    throw new Error(`Invalid environment configuration: ${errorMessages}`);
  }

  const emailFromAddress = rawEnv.EMAIL_FROM_ADDRESS?.trim();
  if (
    rawEnv.RESEND_API_KEY !== undefined &&
    (emailFromAddress === undefined || emailFromAddress === '')
  ) {
    throw new Error(
      'Invalid environment configuration: EMAIL_FROM_ADDRESS is required when RESEND_API_KEY is set.'
    );
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
    trustProxy: env.TRUST_PROXY,
  },
  logger: {
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV !== 'production',
  },
  database: {
    budgetUrl: env.BUDGET_DATABASE_URL,
    insUrl: env.INS_DATABASE_URL,
    userUrl: env.USER_DATABASE_URL,
    ssl: env.DATABASE_SSL ?? false,
    sslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? true,
  },
  redis: {
    url: env.REDIS_URL,
    password: env.REDIS_PASSWORD,
    prefix: env.REDIS_PREFIX,
  },
  cache: {
    backend: env.CACHE_BACKEND,
    defaultTtlMs: env.CACHE_DEFAULT_TTL_MS,
    memoryMaxEntries: env.CACHE_MEMORY_MAX_ENTRIES,
    l1MaxEntries: env.CACHE_L1_MAX_ENTRIES,
    redisUrl: env.REDIS_URL,
    redisPassword: env.REDIS_PASSWORD,
    keyPrefix: env.REDIS_PREFIX ?? 'transparenta',
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
    /** Clerk webhook signing secret for verifying inbound Svix deliveries */
    clerkWebhookSigningSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
    /** Whether auth is enabled (true if any Clerk config is set) */
    enabled:
      env.CLERK_SECRET_KEY !== undefined ||
      env.CLERK_JWT_KEY !== undefined ||
      env.CLERK_AUTHORIZED_PARTIES !== undefined,
  },
  rateLimit: {
    /** Maximum requests per time window */
    max: env.RATE_LIMIT_MAX ?? 300,
    /** Time window duration (e.g., '1 minute') */
    window: env.RATE_LIMIT_WINDOW ?? '1 minute',
    /** Header name for identifying service clients with higher limits */
    specialHeader: env.SPECIAL_RATE_LIMIT_HEADER?.toLowerCase(),
    /** Shared secret for identifying trusted service clients */
    specialKey: env.SPECIAL_RATE_LIMIT_KEY,
    /** Maximum requests per window for service clients */
    specialMax: env.SPECIAL_RATE_LIMIT_MAX ?? 6000,
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
    fromAddress: env.EMAIL_FROM_ADDRESS?.trim(),
    /** From address for campaign emails */
    funkyFromAddress: env.FUNKY_EMAIL_FROM_ADDRESS?.trim(),
    /** Optional CC recipients for campaign institution emails */
    funkyFromAddressCcRecipients:
      env.FUNKY_EMAIL_FROM_ADDRESS_CC?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
    /** Reply-To address for campaign institution emails */
    funkyReplyToAddress: env.FUNKY_EMAIL_REPLY_TO_ADDRESS?.trim(),
    /** Whether preview API is enabled */
    previewEnabled: env.EMAIL_PREVIEW_ENABLED ?? false,
    /** Rate limit (requests per second) */
    maxRps: env.RESEND_MAX_RPS ?? 2,
    /** Whether email is enabled (API key is set) */
    enabled: env.RESEND_API_KEY !== undefined,
  },
  jobs: {
    /** Dedicated Redis connection URL for BullMQ */
    redisUrl: env.BULLMQ_REDIS_URL,
    /** Dedicated Redis password for BullMQ */
    redisPassword: env.BULLMQ_REDIS_PASSWORD,
    /** Number of concurrent workers per queue */
    concurrency: env.JOBS_CONCURRENCY ?? 5,
    /** BullMQ prefix for queue keys */
    prefix: env.BULLMQ_PREFIX ?? 'transparenta:jobs',
    /** Recovery sweep interval in minutes */
    notificationRecoverySweepIntervalMinutes:
      env.NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES ?? 15,
    /** Stuck-sending threshold in minutes */
    notificationStuckSendingThresholdMinutes:
      env.NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES ?? 15,
  },
  notifications: {
    /** API key for triggering notification jobs */
    triggerApiKey: env.NOTIFICATION_TRIGGER_API_KEY,
    /** Public client base URL for frontend links */
    platformBaseUrl: env.PUBLIC_CLIENT_BASE_URL ?? env.CLIENT_BASE_URL ?? '',
    /** API base URL for unsubscribe and API links in emails */
    apiBaseUrl: env.API_BASE_URL,
    /** HMAC secret for signing unsubscribe tokens */
    unsubscribeHmacSecret: env.UNSUBSCRIBE_HMAC_SECRET,
    /** Whether notifications are enabled */
    enabled: env.RESEND_API_KEY !== undefined && env.NOTIFICATION_TRIGGER_API_KEY !== undefined,
  },
  learningProgress: {
    /** Campaign keys with enabled campaign-admin routes */
    campaignAdminEnabledCampaigns: [
      ...new Set(
        env.ENABLED_ADMIN_CAMPAIGNS?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) ?? []
      ),
    ],
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
