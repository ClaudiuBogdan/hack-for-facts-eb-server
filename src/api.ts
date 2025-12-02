/**
 * API server entry point
 * Starts the Fastify HTTP server
 */

import { buildApp } from './app.js';
import { parseEnv, createConfig } from './infra/config/index.js';
import { initDatabases } from './infra/database/client.js';
import { createLogger } from './infra/logger/index.js';
import { createDatasetRepo } from './modules/datasets/index.js';

// Read package.json for version (optional, won't fail if not available)
const getVersion = (): string | undefined => {
  try {
    // In production, this would be set via environment variable
    return process.env['APP_VERSION'] ?? '0.1.0';
  } catch {
    return undefined;
  }
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
  const { budgetDb } = initDatabases(config);
  const datasetRepo = createDatasetRepo({
    rootDir: './datasets/yaml',
  });

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
      datasetRepo,
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
