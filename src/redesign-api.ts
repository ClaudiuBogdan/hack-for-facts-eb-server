/**
 * Redesign server entrypoint (foundation §10).
 *
 * Boots the kernel-only Fastify app and listens on PORT. Does NOT load the
 * legacy modules or require legacy envs. Run via:
 *   tsx watch --env-file=.claude/redesign-prod.env src/redesign-api.ts
 */

import { buildRedesignApp } from './app/build-redesign-app.js';
import { loadRedesignConfig } from './infra/config/redesign-env.js';
import { makeConfiguredJWTProvider } from './modules/auth/index.js';

const main = async (): Promise<void> => {
  const config = loadRedesignConfig(process.env);
  const authProvider =
    config.auth === undefined ? undefined : await makeConfiguredJWTProvider(config.auth);

  const { app, kernel } = await buildRedesignApp({
    kernelConfig: config.kernel,
    ...(authProvider !== undefined && { authProvider }),
    logLevel: config.logLevel,
    corsAllowedOrigins: config.corsAllowedOrigins,
    ...(config.kernel.clientBaseUrl !== undefined && {
      clientBaseUrl: config.kernel.clientBaseUrl,
    }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down redesign server');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    const cap = kernel.searchCapabilities.engines;
    app.log.info(
      { address, meili: cap.meili, opensearch: cap.opensearch },
      'redesign server listening'
    );
  } catch (error) {
    app.log.fatal({ err: error }, 'failed to start redesign server');
    process.exit(1);
  }
};

await main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
