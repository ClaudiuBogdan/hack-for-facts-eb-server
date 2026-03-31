/**
 * Unit tests for configuration module
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { parseEnv, createConfig } from '@/infra/config/index.js';

describe('Configuration', () => {
  const requiredEnv = {
    BUDGET_DATABASE_URL: 'postgres://localhost/test',
    INS_DATABASE_URL: 'postgres://localhost/test-ins',
    USER_DATABASE_URL: 'postgres://localhost/test',
    API_BASE_URL: 'https://api.transparenta.eu',
  };

  describe('parseEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns default values when env is empty', () => {
      const env = parseEnv({ ...requiredEnv });

      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3000);
      expect(env.HOST).toBe('0.0.0.0');
      expect(env.LOG_LEVEL).toBe('info');
      expect(env.CACHE_BACKEND).toBe('memory');
      expect(env.CACHE_DEFAULT_TTL_MS).toBe(60 * 24 * 60 * 60 * 1000);
      expect(env.CACHE_MEMORY_MAX_ENTRIES).toBe(1000);
      expect(env.CACHE_L1_MAX_ENTRIES).toBe(500);
      expect(env.NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES).toBe(15);
      expect(env.NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES).toBe(15);
    });

    it('parses PORT as number', () => {
      const env = parseEnv({ ...requiredEnv, PORT: '8080' });

      expect(env.PORT).toBe(8080);
      expect(typeof env.PORT).toBe('number');
    });

    it('accepts valid NODE_ENV values', () => {
      expect(parseEnv({ ...requiredEnv, NODE_ENV: 'development' }).NODE_ENV).toBe('development');
      expect(parseEnv({ ...requiredEnv, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
      expect(parseEnv({ ...requiredEnv, NODE_ENV: 'test' }).NODE_ENV).toBe('test');
    });

    it('accepts valid LOG_LEVEL values', () => {
      const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

      for (const level of levels) {
        const env = parseEnv({ ...requiredEnv, LOG_LEVEL: level });
        expect(env.LOG_LEVEL).toBe(level);
      }
    });

    it('accepts BUDGET_DATABASE_URL', () => {
      const envWithDb = parseEnv({ ...requiredEnv });
      expect(envWithDb.BUDGET_DATABASE_URL).toBe('postgres://localhost/test');
    });

    it('accepts INS_DATABASE_URL', () => {
      const envWithDb = parseEnv({ ...requiredEnv });
      expect(envWithDb.INS_DATABASE_URL).toBe('postgres://localhost/test-ins');
    });

    it('accepts USER_DATABASE_URL', () => {
      const envWithDb = parseEnv({ ...requiredEnv });
      expect(envWithDb.USER_DATABASE_URL).toBe('postgres://localhost/test');
    });

    it('accepts optional REDIS_URL', () => {
      const envWithRedis = parseEnv({ ...requiredEnv, REDIS_URL: 'redis://localhost:6379' });
      expect(envWithRedis.REDIS_URL).toBe('redis://localhost:6379');
      expect(envWithRedis.CACHE_BACKEND).toBe('redis');

      const envWithoutRedis = parseEnv({ ...requiredEnv });
      expect(envWithoutRedis.REDIS_URL).toBeUndefined();
    });

    it('parses cache env overrides', () => {
      const env = parseEnv({
        ...requiredEnv,
        CACHE_BACKEND: 'multi',
        CACHE_DEFAULT_TTL_MS: '120000',
        CACHE_MEMORY_MAX_ENTRIES: '250',
        CACHE_L1_MAX_ENTRIES: '125',
        REDIS_URL: 'redis://cache.example.test:6379',
        REDIS_PASSWORD: 'secret',
        REDIS_PREFIX: 'custom',
      });

      expect(env.CACHE_BACKEND).toBe('multi');
      expect(env.CACHE_DEFAULT_TTL_MS).toBe(120000);
      expect(env.CACHE_MEMORY_MAX_ENTRIES).toBe(250);
      expect(env.CACHE_L1_MAX_ENTRIES).toBe(125);
      expect(env.REDIS_URL).toBe('redis://cache.example.test:6379');
      expect(env.REDIS_PASSWORD).toBe('secret');
      expect(env.REDIS_PREFIX).toBe('custom');
    });

    it('defaults DATABASE_SSL_REJECT_UNAUTHORIZED to true', () => {
      const env = parseEnv({ ...requiredEnv });

      expect(env.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe(true);
    });

    it('parses DATABASE_SSL_REJECT_UNAUTHORIZED=false', () => {
      const env = parseEnv({
        ...requiredEnv,
        DATABASE_SSL: 'true',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
      });

      expect(env.DATABASE_SSL).toBe(true);
      expect(env.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe(false);
    });

    it('parses notification recovery job settings as numbers', () => {
      const env = parseEnv({
        ...requiredEnv,
        NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES: '30',
        NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES: '45',
      });

      expect(env.NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES).toBe(30);
      expect(env.NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES).toBe(45);
    });

    it('accepts optional LEARNING_PROGRESS_REVIEW_API_KEY', () => {
      const apiKey = 'r'.repeat(32);
      const env = parseEnv({ ...requiredEnv, LEARNING_PROGRESS_REVIEW_API_KEY: apiKey });

      expect(env.LEARNING_PROGRESS_REVIEW_API_KEY).toBe(apiKey);
    });

    it('accepts optional SPECIAL_RATE_LIMIT_KEY', () => {
      const apiKey = 's'.repeat(32);
      const env = parseEnv({ ...requiredEnv, SPECIAL_RATE_LIMIT_KEY: apiKey });

      expect(env.SPECIAL_RATE_LIMIT_KEY).toBe(apiKey);
    });

    it('accepts optional CLERK_WEBHOOK_SIGNING_SECRET', () => {
      const signingSecret = 'whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtMTIzNDU2Nzg5MDEy';
      const env = parseEnv({ ...requiredEnv, CLERK_WEBHOOK_SIGNING_SECRET: signingSecret });

      expect(env.CLERK_WEBHOOK_SIGNING_SECRET).toBe(signingSecret);
    });

    it('parses TRUST_PROXY numeric hop counts as numbers', () => {
      const env = parseEnv({ ...requiredEnv, TRUST_PROXY: '1' });

      expect(env.TRUST_PROXY).toBe(1);
      expect(typeof env.TRUST_PROXY).toBe('number');
    });

    it('parses TRUST_PROXY false as a boolean', () => {
      const env = parseEnv({ ...requiredEnv, TRUST_PROXY: 'false' });

      expect(env.TRUST_PROXY).toBe(false);
      expect(typeof env.TRUST_PROXY).toBe('boolean');
    });

    it('keeps TRUST_PROXY named proxies as strings', () => {
      const env = parseEnv({ ...requiredEnv, TRUST_PROXY: 'loopback' });

      expect(env.TRUST_PROXY).toBe('loopback');
      expect(typeof env.TRUST_PROXY).toBe('string');
    });

    it('rejects short LEARNING_PROGRESS_REVIEW_API_KEY values', () => {
      expect(() =>
        parseEnv({
          ...requiredEnv,
          LEARNING_PROGRESS_REVIEW_API_KEY: 'local-key',
        })
      ).toThrow(
        'Invalid environment configuration: /LEARNING_PROGRESS_REVIEW_API_KEY: Expected string length greater or equal to 32'
      );
    });

    it('throws on invalid PORT (non-numeric)', () => {
      expect(() => parseEnv({ ...requiredEnv, PORT: 'invalid' })).toThrow(
        'Invalid environment configuration'
      );
    });

    it('throws when BUDGET_DATABASE_URL is missing', () => {
      expect(() =>
        parseEnv({
          INS_DATABASE_URL: 'postgres://localhost/test-ins',
          USER_DATABASE_URL: 'postgres://localhost/test',
          API_BASE_URL: 'https://api.transparenta.eu',
        })
      ).toThrow('Invalid environment configuration');
    });

    it('throws when INS_DATABASE_URL is missing', () => {
      expect(() =>
        parseEnv({
          BUDGET_DATABASE_URL: 'postgres://localhost/test',
          USER_DATABASE_URL: 'postgres://localhost/test',
          API_BASE_URL: 'https://api.transparenta.eu',
        })
      ).toThrow('Invalid environment configuration');
    });

    it('throws when USER_DATABASE_URL is missing', () => {
      expect(() =>
        parseEnv({
          BUDGET_DATABASE_URL: 'postgres://localhost/test',
          INS_DATABASE_URL: 'postgres://localhost/test-ins',
          API_BASE_URL: 'https://api.transparenta.eu',
        })
      ).toThrow('Invalid environment configuration');
    });

    it('rejects non-positive notification recovery values', () => {
      expect(() =>
        parseEnv({
          ...requiredEnv,
          NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES: '0',
        })
      ).toThrow('Invalid environment configuration');

      expect(() =>
        parseEnv({
          ...requiredEnv,
          NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES: '0',
        })
      ).toThrow('Invalid environment configuration');
    });
  });

  describe('createConfig', () => {
    it('creates server config with correct flags', () => {
      const devConfig = createConfig(parseEnv({ ...requiredEnv, NODE_ENV: 'development' }));
      expect(devConfig.server.isDevelopment).toBe(true);
      expect(devConfig.server.isProduction).toBe(false);
      expect(devConfig.server.isTest).toBe(false);

      const prodConfig = createConfig(parseEnv({ ...requiredEnv, NODE_ENV: 'production' }));
      expect(prodConfig.server.isDevelopment).toBe(false);
      expect(prodConfig.server.isProduction).toBe(true);
      expect(prodConfig.server.isTest).toBe(false);

      const testConfig = createConfig(parseEnv({ ...requiredEnv, NODE_ENV: 'test' }));
      expect(testConfig.server.isDevelopment).toBe(false);
      expect(testConfig.server.isProduction).toBe(false);
      expect(testConfig.server.isTest).toBe(true);
    });

    it('includes validated cache config', () => {
      const config = createConfig(
        parseEnv({
          ...requiredEnv,
          CACHE_BACKEND: 'multi',
          CACHE_DEFAULT_TTL_MS: '120000',
          CACHE_MEMORY_MAX_ENTRIES: '250',
          CACHE_L1_MAX_ENTRIES: '125',
          REDIS_URL: 'redis://cache.example.test:6379',
          REDIS_PASSWORD: 'secret',
          REDIS_PREFIX: 'custom',
        })
      );

      expect(config.cache).toEqual({
        backend: 'multi',
        defaultTtlMs: 120000,
        memoryMaxEntries: 250,
        l1MaxEntries: 125,
        redisUrl: 'redis://cache.example.test:6379',
        redisPassword: 'secret',
        keyPrefix: 'custom',
      });
    });

    it('includes secure-by-default database SSL verification config', () => {
      const defaultConfig = createConfig(parseEnv({ ...requiredEnv }));
      expect(defaultConfig.database.ssl).toBe(false);
      expect(defaultConfig.database.sslRejectUnauthorized).toBe(true);

      const permissiveConfig = createConfig(
        parseEnv({
          ...requiredEnv,
          DATABASE_SSL: 'true',
          DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
        })
      );

      expect(permissiveConfig.database.ssl).toBe(true);
      expect(permissiveConfig.database.sslRejectUnauthorized).toBe(false);
    });

    it('sets pretty logging for non-production', () => {
      const devConfig = createConfig(parseEnv({ ...requiredEnv, NODE_ENV: 'development' }));
      expect(devConfig.logger.pretty).toBe(true);

      const prodConfig = createConfig(parseEnv({ ...requiredEnv, NODE_ENV: 'production' }));
      expect(prodConfig.logger.pretty).toBe(false);
    });

    it('passes through port and host', () => {
      const config = createConfig(parseEnv({ ...requiredEnv, PORT: '8080', HOST: '127.0.0.1' }));

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('127.0.0.1');
    });

    it('enables learning progress admin review config when the API key is set', () => {
      const apiKey = 'r'.repeat(32);
      const config = createConfig(
        parseEnv({ ...requiredEnv, LEARNING_PROGRESS_REVIEW_API_KEY: apiKey })
      );

      expect(config.learningProgress.reviewApiKey).toBe(apiKey);
      expect(config.learningProgress.reviewApiEnabled).toBe(true);
    });

    it('normalizes special rate limit header names and exposes the service key', () => {
      const config = createConfig(
        parseEnv({
          ...requiredEnv,
          SPECIAL_RATE_LIMIT_HEADER: 'X-API-Key',
          SPECIAL_RATE_LIMIT_KEY: 's'.repeat(32),
        })
      );

      expect(config.rateLimit.specialHeader).toBe('x-api-key');
      expect(config.rateLimit.specialKey).toBe('s'.repeat(32));
    });

    it('exposes the Clerk webhook signing secret without enabling session auth', () => {
      const signingSecret = 'whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtMTIzNDU2Nzg5MDEy';
      const config = createConfig(
        parseEnv({
          ...requiredEnv,
          CLERK_WEBHOOK_SIGNING_SECRET: signingSecret,
        })
      );

      expect(config.auth.clerkWebhookSigningSecret).toBe(signingSecret);
      expect(config.auth.enabled).toBe(false);
    });

    it('exposes notification recovery job configuration', () => {
      const config = createConfig(
        parseEnv({
          ...requiredEnv,
          NOTIFICATION_RECOVERY_SWEEP_INTERVAL_MINUTES: '30',
          NOTIFICATION_STUCK_SENDING_THRESHOLD_MINUTES: '45',
        })
      );

      expect(config.jobs.notificationRecoverySweepIntervalMinutes).toBe(30);
      expect(config.jobs.notificationStuckSendingThresholdMinutes).toBe(45);
    });
  });
});
