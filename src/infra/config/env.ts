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

  // CORS
  ALLOWED_ORIGINS: Type.Optional(Type.String()),
  CLIENT_BASE_URL: Type.Optional(Type.String()),
  PUBLIC_CLIENT_BASE_URL: Type.Optional(Type.String()),

  // Auth (Clerk)
  CLERK_SECRET_KEY: Type.Optional(Type.String()),
  CLERK_JWT_KEY: Type.Optional(Type.String()),
  CLERK_AUTHORIZED_PARTIES: Type.Optional(Type.String()),
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
    ALLOWED_ORIGINS: env['ALLOWED_ORIGINS'],
    CLIENT_BASE_URL: env['CLIENT_BASE_URL'],
    PUBLIC_CLIENT_BASE_URL: env['PUBLIC_CLIENT_BASE_URL'],
    CLERK_SECRET_KEY: env['CLERK_SECRET_KEY'],
    CLERK_JWT_KEY: env['CLERK_JWT_KEY'],
    CLERK_AUTHORIZED_PARTIES: env['CLERK_AUTHORIZED_PARTIES'],
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
    clerkAuthorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(',').filter(Boolean),
    /** Whether auth is enabled (true if any Clerk config is set) */
    enabled:
      env.CLERK_SECRET_KEY !== undefined ||
      env.CLERK_JWT_KEY !== undefined ||
      env.CLERK_AUTHORIZED_PARTIES !== undefined,
  },
});

export type AppConfig = ReturnType<typeof createConfig>;
