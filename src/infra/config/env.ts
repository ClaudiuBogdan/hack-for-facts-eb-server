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

  // Database (optional for now, will be required later)
  DATABASE_URL: Type.Optional(Type.String()),
  BUDGET_DATABASE_URL: Type.Optional(Type.String()),
  USER_DATABASE_URL: Type.Optional(Type.String()),

  // Redis (optional for now, will be required later)
  REDIS_URL: Type.Optional(Type.String()),
});

export type Env = Static<typeof EnvSchema>;

/**
 * Parse and validate environment variables
 */
export const parseEnv = (env: NodeJS.ProcessEnv = process.env): Env => {
  const rawEnv = {
    NODE_ENV: env['NODE_ENV'] ?? 'development',
    PORT: env['PORT'] != null && env['PORT'] !== '' ? Number.parseInt(env['PORT'], 10) : 3000,
    HOST: env['HOST'] ?? '0.0.0.0',
    LOG_LEVEL: env['LOG_LEVEL'] ?? 'info',
    DATABASE_URL: env['DATABASE_URL'],
    BUDGET_DATABASE_URL: env['BUDGET_DATABASE_URL'],
    USER_DATABASE_URL: env['USER_DATABASE_URL'],
    REDIS_URL: env['REDIS_URL'],
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
    url: env.DATABASE_URL,
    budgetUrl: env.BUDGET_DATABASE_URL,
    userUrl: env.USER_DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
  },
});

export type AppConfig = ReturnType<typeof createConfig>;
