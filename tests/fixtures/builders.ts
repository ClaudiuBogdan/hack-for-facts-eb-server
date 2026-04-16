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
      trustProxy: undefined,
    },
    logger: {
      level: 'silent',
      pretty: false,
    },
    database: {
      budgetUrl: 'postgresql://test:test@localhost:5432/test',
      insUrl: 'postgresql://test:test@localhost:5432/test-ins',
      userUrl: 'postgresql://test:test@localhost:5432/test-user',
      ssl: false,
      sslRejectUnauthorized: true,
    },
    redis: {
      url: undefined,
      password: undefined,
      prefix: undefined,
    },
    cache: {
      backend: 'memory',
      defaultTtlMs: 60 * 24 * 60 * 60 * 1000,
      memoryMaxEntries: 1000,
      l1MaxEntries: 500,
      redisUrl: undefined,
      redisPassword: undefined,
      keyPrefix: 'transparenta',
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
      clerkWebhookSigningSecret: undefined,
      enabled: false,
    },
    rateLimit: {
      max: 300,
      window: '1 minute',
      specialHeader: undefined,
      specialKey: undefined,
      specialMax: 6000,
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
      funkyFromAddress: 'campaign@test.example.com',
      funkyFromAddressCcRecipients: ['review@test.example.com'],
      funkyReplyToAddress: 'debate@transparenta.test',
      previewEnabled: false,
      maxRps: 2,
      enabled: false,
    },
    jobs: {
      redisUrl: undefined,
      redisPassword: undefined,
      concurrency: 5,
      prefix: 'test:jobs',
      notificationRecoverySweepIntervalMinutes: 15,
      notificationStuckSendingThresholdMinutes: 15,
    },
    notifications: {
      triggerApiKey: undefined,
      platformBaseUrl: 'https://test.example.com',
      apiBaseUrl: 'https://api.transparenta.eu',
      unsubscribeHmacSecret: 'h'.repeat(32),
      enabled: false,
    },
    learningProgress: {
      campaignAdminEnabledCampaigns: [],
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
    cache: { ...defaults.cache, ...overrides.cache },
    cors: { ...defaults.cors, ...overrides.cors },
    auth: { ...defaults.auth, ...overrides.auth },
    rateLimit: { ...defaults.rateLimit, ...overrides.rateLimit },
    mcp: { ...defaults.mcp, ...overrides.mcp },
    gpt: { ...defaults.gpt, ...overrides.gpt },
    email: { ...defaults.email, ...overrides.email },
    jobs: { ...defaults.jobs, ...overrides.jobs },
    notifications: { ...defaults.notifications, ...overrides.notifications },
    learningProgress: { ...defaults.learningProgress, ...overrides.learningProgress },
    telemetry: { ...defaults.telemetry, ...overrides.telemetry },
  };
};
