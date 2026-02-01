/**
 * API server entry point
 * Starts the Fastify HTTP server
 */

// IMPORTANT: Import telemetry FIRST to ensure proper instrumentation
// This must be before any other imports to capture all spans
import './infra/telemetry/tracing.js';

import { jwtVerify, importSPKI } from 'jose';

import { buildApp } from './app/build-app.js';
import { parseEnv, createConfig, type AppConfig } from './infra/config/index.js';
import { initDatabases } from './infra/database/client.js';
import { createLogger } from './infra/logger/index.js';
import { makeJWTAdapter, makeCachedAuthProvider, type AuthProvider } from './modules/auth/index.js';
import { createDatasetRepo } from './modules/datasets/index.js';
import { NormalizationService } from './modules/normalization/index.js';

import type { Logger } from 'pino';

// Read package.json for version (optional, won't fail if not available)
const getVersion = (): string | undefined => {
  try {
    // In production, this would be set via environment variable
    return process.env['APP_VERSION'] ?? '0.1.0';
  } catch {
    return undefined;
  }
};

/**
 * Creates an auth provider if Clerk JWT configuration is available.
 * Returns undefined if auth is not configured.
 */
const createAuthProvider = (config: AppConfig, logger: Logger): AuthProvider | undefined => {
  if (config.auth.clerkJwtKey === undefined) {
    // Fail-closed in production if auth appears to be configured but is incomplete.
    if (config.server.isProduction && config.auth.enabled) {
      throw new Error(
        'Auth configuration incomplete: CLERK_JWT_KEY is required in production when Clerk auth variables are set'
      );
    }

    logger.warn('CLERK_JWT_KEY not configured - authentication disabled');
    return undefined;
  }

  logger.info('Creating JWT auth provider');

  // Clerk commonly uses `azp` (authorized party) for scoping tokens to a client/app.
  // We enforce authorized parties in the adapter when configured via CLERK_AUTHORIZED_PARTIES.
  const jwtAdapter = makeJWTAdapter({
    jwtVerify: jwtVerify as unknown as import('./modules/auth/index.js').JWTVerifyFn,
    importSPKI: importSPKI as unknown as import('./modules/auth/index.js').ImportSPKIFn,
    publicKeyPEM: config.auth.clerkJwtKey,
    algorithm: 'RS256',
    ...(config.auth.clerkAuthorizedParties !== undefined &&
      config.auth.clerkAuthorizedParties.length > 0 && {
        authorizedParties: config.auth.clerkAuthorizedParties,
      }),
  });

  // Wrap with caching for performance
  return makeCachedAuthProvider({
    provider: jwtAdapter,
    maxCacheSize: 1000,
    cacheTTLMs: 5 * 60 * 1000, // 5 minutes
  });
};

const main = async (): Promise<void> => {
  // Parse and validate environment
  const env = parseEnv(process.env);
  const config = createConfig(env);

  // Create logger
  const logger = createLogger({
    level: config.logger.level,
    name: 'transparenta-eu-server',
    pretty: config.logger.pretty,
  });

  logger.info({ config: { server: config.server } }, 'Starting API server');

  // Initialize dependencies
  const { budgetDb, insDb, userDb } = initDatabases(config);
  const datasetRepo = createDatasetRepo({
    rootDir: './datasets/yaml',
    logger,
  });

  // Validate required normalization datasets exist
  // This will throw NormalizationDatasetError if any are missing
  logger.info('Validating normalization datasets...');
  await NormalizationService.create(datasetRepo);
  logger.info('Normalization datasets validated successfully');

  // Create auth provider if configured
  const authProvider = createAuthProvider(config, logger);

  // Build application - let Fastify create its own logger based on config
  const app = await buildApp({
    fastifyOptions: {
      logger: {
        level: config.logger.level,
        ...(config.logger.pretty && {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }),
      },
      disableRequestLogging: false,
    },
    deps: {
      healthCheckers: [],
      budgetDb,
      insDb,
      userDb,
      datasetRepo,
      config,
      ...(authProvider !== undefined && { authProvider }),
    },
    version: getVersion(),
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await app.close();
      logger.info('Server closed gracefully');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Start server
  try {
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info({ address }, 'Server listening');
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

// Start the server (top-level await)
await main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
