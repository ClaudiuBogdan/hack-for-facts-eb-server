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
import { loadRedesignConfig } from './infra/config/redesign-env.js';
import { initDatabases } from './infra/database/client.js';
import { createLogger } from './infra/logger/index.js';
import { makeJWTAdapter, makeCachedAuthProvider, type AuthProvider } from './modules/auth/index.js';
import { createDatasetRepo } from './modules/datasets/index.js';
import { NormalizationService } from './modules/normalization/index.js';

import type { HealthChecker } from './modules/health/index.js';
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
    importSPKI: importSPKI,
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
  // The app configures Postgres SSL explicitly via DATABASE_SSL / per-pool options
  // and never connects through bare libpq PG* vars. Strip the ambient libpq
  // `PGSSLMODE` so it can't silently flip `ssl` on the pg clients — e.g. when a dev
  // has sourced `.claude/redesign-psql.env` (griffin psql tooling, PGSSLMODE=require)
  // into the shell that runs `pnpm dev`, which would otherwise force SSL onto the
  // plain phoenix-dev DB forwards. Deployed servers never set PGSSLMODE, so this is
  // a no-op there.
  delete process.env['PGSSLMODE'];

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

  let isDraining = false;
  let shutdownStarted = false;

  const markDraining = (signal: string): void => {
    if (!isDraining) {
      logger.info({ signal }, 'Marking pod unready for shutdown drain');
    }
    isDraining = true;
  };

  const shutdownReadinessChecker: HealthChecker = () =>
    Promise.resolve({
      name: 'shutdown-drain',
      status: isDraining ? 'unhealthy' : 'healthy',
      critical: true,
      ...(isDraining ? { message: 'Pod is draining connections' } : {}),
    });

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

  // Optionally resolve the redesign kernel config (griffin-prod) so the redesign
  // GraphQL/MCP surface can be mounted on this same port (/api/v1/*). The flag
  // defaults off and is only set for local dev — deployed legacy servers skip this
  // entirely. Wrapped so a missing/invalid redesign env can never crash the server.
  let redesignKernelConfig: ReturnType<typeof loadRedesignConfig>['kernel'] | undefined;
  let redesignClientBaseUrl: string | undefined;
  if (config.redesignSurface.enabled) {
    try {
      const redesign = loadRedesignConfig(process.env);
      redesignKernelConfig = redesign.kernel;
      redesignClientBaseUrl = redesign.kernel.clientBaseUrl;
      logger.info('Redesign surface enabled — mounting /api/v1/graphql on the legacy port');
    } catch (error) {
      logger.warn(
        { err: error },
        'REDESIGN_SURFACE_ENABLED is set but the redesign env is missing/invalid — starting the legacy API only'
      );
    }
  }

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
      disableRequestLogging: true,
      // Configurable via TRUST_PROXY env var (true, false, hop count, named proxy, or CIDR).
      trustProxy: config.server.trustProxy ?? true,
    },
    deps: {
      healthCheckers: [shutdownReadinessChecker],
      budgetDb,
      insDb,
      userDb,
      datasetRepo,
      config,
      ...(authProvider !== undefined && { authProvider }),
      ...(redesignKernelConfig !== undefined && { redesignKernelConfig }),
      ...(redesignClientBaseUrl !== undefined && { redesignClientBaseUrl }),
    },
    version: getVersion(),
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shutdownStarted = true;
    markDraining(signal);
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await app.close();
      await Promise.all([budgetDb.destroy(), insDb.destroy(), userDb.destroy()]);
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
  process.on('SIGUSR2', () => {
    markDraining('SIGUSR2');
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
