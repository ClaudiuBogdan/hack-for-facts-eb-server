/**
 * Unit tests for configuration module
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { parseEnv, createConfig } from '@/infra/config/index.js';

describe('Configuration', () => {
  describe('parseEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns default values when env is empty', () => {
      const env = parseEnv({});

      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3000);
      expect(env.HOST).toBe('0.0.0.0');
      expect(env.LOG_LEVEL).toBe('info');
    });

    it('parses PORT as number', () => {
      const env = parseEnv({ PORT: '8080' });

      expect(env.PORT).toBe(8080);
      expect(typeof env.PORT).toBe('number');
    });

    it('accepts valid NODE_ENV values', () => {
      expect(parseEnv({ NODE_ENV: 'development' }).NODE_ENV).toBe('development');
      expect(parseEnv({ NODE_ENV: 'production' }).NODE_ENV).toBe('production');
      expect(parseEnv({ NODE_ENV: 'test' }).NODE_ENV).toBe('test');
    });

    it('accepts valid LOG_LEVEL values', () => {
      const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

      for (const level of levels) {
        const env = parseEnv({ LOG_LEVEL: level });
        expect(env.LOG_LEVEL).toBe(level);
      }
    });

    it('accepts optional DATABASE_URL', () => {
      const envWithDb = parseEnv({ DATABASE_URL: 'postgres://localhost/test' });
      expect(envWithDb.DATABASE_URL).toBe('postgres://localhost/test');

      const envWithoutDb = parseEnv({});
      expect(envWithoutDb.DATABASE_URL).toBeUndefined();
    });

    it('accepts optional REDIS_URL', () => {
      const envWithRedis = parseEnv({ REDIS_URL: 'redis://localhost:6379' });
      expect(envWithRedis.REDIS_URL).toBe('redis://localhost:6379');

      const envWithoutRedis = parseEnv({});
      expect(envWithoutRedis.REDIS_URL).toBeUndefined();
    });

    it('throws on invalid PORT (non-numeric)', () => {
      expect(() => parseEnv({ PORT: 'invalid' })).toThrow('Invalid environment configuration');
    });
  });

  describe('createConfig', () => {
    it('creates server config with correct flags', () => {
      const devConfig = createConfig(parseEnv({ NODE_ENV: 'development' }));
      expect(devConfig.server.isDevelopment).toBe(true);
      expect(devConfig.server.isProduction).toBe(false);
      expect(devConfig.server.isTest).toBe(false);

      const prodConfig = createConfig(parseEnv({ NODE_ENV: 'production' }));
      expect(prodConfig.server.isDevelopment).toBe(false);
      expect(prodConfig.server.isProduction).toBe(true);
      expect(prodConfig.server.isTest).toBe(false);

      const testConfig = createConfig(parseEnv({ NODE_ENV: 'test' }));
      expect(testConfig.server.isDevelopment).toBe(false);
      expect(testConfig.server.isProduction).toBe(false);
      expect(testConfig.server.isTest).toBe(true);
    });

    it('sets pretty logging for non-production', () => {
      const devConfig = createConfig(parseEnv({ NODE_ENV: 'development' }));
      expect(devConfig.logger.pretty).toBe(true);

      const prodConfig = createConfig(parseEnv({ NODE_ENV: 'production' }));
      expect(prodConfig.logger.pretty).toBe(false);
    });

    it('passes through port and host', () => {
      const config = createConfig(parseEnv({ PORT: '8080', HOST: '127.0.0.1' }));

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('127.0.0.1');
    });
  });
});
