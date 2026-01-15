/**
 * Test data builders/factories
 * Provides sensible defaults for test entities
 */

import type { AppConfig } from '@/infra/config/env.js';
import type { HealthCheckResult, HealthChecker } from '@/modules/health/index.js';

/**
 * Create a health check result with defaults
 */
export const makeHealthCheckResult = (
  overrides: Partial<HealthCheckResult> = {}
): HealthCheckResult => ({
  name: 'test-check',
  status: 'healthy',
  ...overrides,
});

/**
 * Create a health checker function that returns a fixed result
 */
export const makeHealthChecker = (result: Partial<HealthCheckResult> = {}): HealthChecker => {
  const fullResult = makeHealthCheckResult(result);
  return async () => fullResult;
};

/**
 * Create a health checker that simulates latency
 */
export const makeSlowHealthChecker = (
  delayMs: number,
  result: Partial<HealthCheckResult> = {}
): HealthChecker => {
  const fullResult = makeHealthCheckResult(result);
  return async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ...fullResult,
      latencyMs: Date.now() - start,
    };
  };
};

/**
 * Create a health checker that throws an error
 */
export const makeFailingHealthChecker = (errorMessage: string): HealthChecker => {
  return async () => {
    throw new Error(errorMessage);
  };
};

/**
 * Create a test configuration with defaults
 */
export const makeTestConfig = (overrides: Partial<AppConfig> = {}): AppConfig => {
  const defaults: AppConfig = {
    server: {
      port: 3000,
      host: '0.0.0.0',
      isDevelopment: true,
      isProduction: false,
      isTest: true,
    },
    logger: {
      level: 'silent',
      pretty: false,
    },
    database: {
      budgetUrl: 'postgresql://test:test@localhost:5432/test',
      userUrl: 'postgresql://test:test@localhost:5432/test-user',
    },
    redis: {
      url: undefined,
      password: undefined,
      prefix: undefined,
    },
    cors: {
      allowedOrigins: undefined,
      clientBaseUrl: undefined,
      publicClientBaseUrl: undefined,
    },
    auth: {
      clerkSecretKey: undefined,
      clerkJwtKey: undefined,
      clerkAuthorizedParties: undefined,
      enabled: false,
    },
    shortLinks: {
      dailyLimit: 100,
      cacheTtlSeconds: 86400,
    },
    mcp: {
      enabled: false,
      authRequired: false,
      apiKey: undefined,
      sessionTtlSeconds: 3600,
      clientBaseUrl: '',
    },
    gpt: {
      apiKey: undefined,
    },
    email: {
      apiKey: undefined,
      webhookSecret: undefined,
      fromAddress: 'noreply@test.example.com',
      previewEnabled: false,
      maxRps: 2,
      enabled: false,
    },
    jobs: {
      enabled: false,
      concurrency: 5,
      prefix: 'test:jobs',
      processRole: 'both' as const,
    },
    notifications: {
      triggerApiKey: undefined,
      platformBaseUrl: 'https://test.example.com',
      enabled: false,
    },
    telemetry: {
      endpoint: undefined,
      headers: undefined,
      serviceName: 'transparenta-eu-server',
      disabled: true, // Disabled by default in tests
      sampleRate: undefined,
      resourceAttributes: undefined,
    },
  };

  return {
    ...defaults,
    ...overrides,
    server: { ...defaults.server, ...overrides.server },
    logger: { ...defaults.logger, ...overrides.logger },
    database: { ...defaults.database, ...overrides.database },
    redis: { ...defaults.redis, ...overrides.redis },
    cors: { ...defaults.cors, ...overrides.cors },
    auth: { ...defaults.auth, ...overrides.auth },
    mcp: { ...defaults.mcp, ...overrides.mcp },
    gpt: { ...defaults.gpt, ...overrides.gpt },
    email: { ...defaults.email, ...overrides.email },
    jobs: { ...defaults.jobs, ...overrides.jobs },
    notifications: { ...defaults.notifications, ...overrides.notifications },
    telemetry: { ...defaults.telemetry, ...overrides.telemetry },
  };
};
