/**
 * Unit tests for telemetry configuration parsing
 */

import { describe, it, expect } from 'vitest';

import {
  parseTelemetryConfig,
  isSigNozCloud,
  isTelemetryEnabled,
  getExporterHeaders,
} from '@/infra/telemetry/config.js';

describe('parseTelemetryConfig', () => {
  describe('endpoint parsing', () => {
    it('parses SigNoz Cloud endpoint', () => {
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ingest.eu.signoz.cloud:443',
      };

      const config = parseTelemetryConfig(env);

      expect(config.endpoint).toBe('https://ingest.eu.signoz.cloud:443');
    });

    it('parses self-hosted endpoint', () => {
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      };

      const config = parseTelemetryConfig(env);

      expect(config.endpoint).toBe('http://localhost:4318');
    });

    it('uses default endpoint when not provided', () => {
      const config = parseTelemetryConfig({});

      expect(config.endpoint).toBe('http://localhost:4318');
    });
  });

  describe('ingestion key extraction', () => {
    it('extracts signoz-ingestion-key from headers', () => {
      const env = {
        OTEL_EXPORTER_OTLP_HEADERS: 'signoz-ingestion-key=test-key-123',
      };

      const config = parseTelemetryConfig(env);

      expect(config.ingestionKey).toBe('test-key-123');
    });

    it('extracts signoz-access-token from headers', () => {
      const env = {
        OTEL_EXPORTER_OTLP_HEADERS: 'signoz-access-token=token-456',
      };

      const config = parseTelemetryConfig(env);

      expect(config.ingestionKey).toBe('token-456');
    });

    it('handles multiple headers', () => {
      const env = {
        OTEL_EXPORTER_OTLP_HEADERS: 'x-custom=foo,signoz-ingestion-key=test-key,x-other=bar',
      };

      const config = parseTelemetryConfig(env);

      expect(config.ingestionKey).toBe('test-key');
      expect(config.headers['x-custom']).toBe('foo');
      expect(config.headers['x-other']).toBe('bar');
    });

    it('handles empty headers', () => {
      const config = parseTelemetryConfig({});

      expect(config.ingestionKey).toBeUndefined();
      expect(config.headers).toEqual({});
    });
  });

  describe('service name', () => {
    it('uses provided service name', () => {
      const env = {
        OTEL_SERVICE_NAME: 'my-custom-service',
      };

      const config = parseTelemetryConfig(env);

      expect(config.serviceName).toBe('my-custom-service');
    });

    it('uses default service name when not provided', () => {
      const config = parseTelemetryConfig({});

      expect(config.serviceName).toBe('transparenta-eu-server');
    });
  });

  describe('environment', () => {
    it('uses NODE_ENV as environment', () => {
      const env = {
        NODE_ENV: 'production',
      };

      const config = parseTelemetryConfig(env);

      expect(config.environment).toBe('production');
    });

    it('defaults to development when NODE_ENV not set', () => {
      const config = parseTelemetryConfig({});

      expect(config.environment).toBe('development');
    });
  });

  describe('enabled/disabled flags', () => {
    it('is enabled by default', () => {
      const config = parseTelemetryConfig({});

      expect(config.enabled).toBe(true);
    });

    it('can be disabled via OTEL_SDK_DISABLED', () => {
      const env = {
        OTEL_SDK_DISABLED: 'true',
      };

      const config = parseTelemetryConfig(env);

      expect(config.enabled).toBe(false);
    });

    it('enables all signal types by default', () => {
      const config = parseTelemetryConfig({});

      expect(config.enableTraces).toBe(true);
      expect(config.enableMetrics).toBe(true);
      expect(config.enableLogs).toBe(true);
    });

    it('disables traces when OTEL_TRACES_EXPORTER is none', () => {
      const env = {
        OTEL_TRACES_EXPORTER: 'none',
      };

      const config = parseTelemetryConfig(env);

      expect(config.enableTraces).toBe(false);
      expect(config.enableMetrics).toBe(true);
      expect(config.enableLogs).toBe(true);
    });

    it('disables metrics when OTEL_METRICS_EXPORTER is none', () => {
      const env = {
        OTEL_METRICS_EXPORTER: 'none',
      };

      const config = parseTelemetryConfig(env);

      expect(config.enableTraces).toBe(true);
      expect(config.enableMetrics).toBe(false);
      expect(config.enableLogs).toBe(true);
    });

    it('disables logs when OTEL_LOGS_EXPORTER is none', () => {
      const env = {
        OTEL_LOGS_EXPORTER: 'none',
      };

      const config = parseTelemetryConfig(env);

      expect(config.enableTraces).toBe(true);
      expect(config.enableMetrics).toBe(true);
      expect(config.enableLogs).toBe(false);
    });
  });

  describe('sample rate', () => {
    it('defaults to 1.0 (100%)', () => {
      const config = parseTelemetryConfig({});

      expect(config.sampleRate).toBe(1.0);
    });

    it('parses valid sample rate', () => {
      const env = {
        OTEL_TRACES_SAMPLER_ARG: '0.1',
      };

      const config = parseTelemetryConfig(env);

      expect(config.sampleRate).toBe(0.1);
    });

    it('ignores invalid sample rate and uses default', () => {
      const env = {
        OTEL_TRACES_SAMPLER_ARG: 'invalid',
      };

      const config = parseTelemetryConfig(env);

      expect(config.sampleRate).toBe(1.0);
    });

    it('ignores out-of-range sample rate and uses default', () => {
      const env = {
        OTEL_TRACES_SAMPLER_ARG: '1.5',
      };

      const config = parseTelemetryConfig(env);

      expect(config.sampleRate).toBe(1.0);
    });
  });

  describe('resource attributes', () => {
    it('parses resource attributes', () => {
      const env = {
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production,service.version=1.0.0',
      };

      const config = parseTelemetryConfig(env);

      expect(config.resourceAttributes['deployment.environment']).toBe('production');
      expect(config.resourceAttributes['service.version']).toBe('1.0.0');
    });

    it('handles empty resource attributes', () => {
      const config = parseTelemetryConfig({});

      expect(config.resourceAttributes).toEqual({});
    });
  });
});

describe('isSigNozCloud', () => {
  it('returns true when ingestion key is present', () => {
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: 'signoz-ingestion-key=test-key',
    };
    const config = parseTelemetryConfig(env);

    expect(isSigNozCloud(config)).toBe(true);
  });

  it('returns false when ingestion key is absent', () => {
    const config = parseTelemetryConfig({});

    expect(isSigNozCloud(config)).toBe(false);
  });

  it('returns false when ingestion key is empty string', () => {
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: 'signoz-ingestion-key=',
    };
    const config = parseTelemetryConfig(env);

    expect(isSigNozCloud(config)).toBe(false);
  });
});

describe('isTelemetryEnabled', () => {
  it('returns true when enabled and any signal type is on', () => {
    const config = parseTelemetryConfig({});

    expect(isTelemetryEnabled(config)).toBe(true);
  });

  it('returns false when SDK is disabled', () => {
    const env = {
      OTEL_SDK_DISABLED: 'true',
    };
    const config = parseTelemetryConfig(env);

    expect(isTelemetryEnabled(config)).toBe(false);
  });

  it('returns false when all signal types are disabled', () => {
    const env = {
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    };
    const config = parseTelemetryConfig(env);

    expect(isTelemetryEnabled(config)).toBe(false);
  });

  it('returns true when only traces are enabled', () => {
    const env = {
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    };
    const config = parseTelemetryConfig(env);

    expect(isTelemetryEnabled(config)).toBe(true);
  });
});

describe('getExporterHeaders', () => {
  it('includes ingestion key in headers', () => {
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: 'signoz-ingestion-key=test-key',
    };
    const config = parseTelemetryConfig(env);

    const headers = getExporterHeaders(config);

    expect(headers['signoz-ingestion-key']).toBe('test-key');
  });

  it('includes custom headers', () => {
    const env = {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-custom=value,signoz-ingestion-key=key',
    };
    const config = parseTelemetryConfig(env);

    const headers = getExporterHeaders(config);

    expect(headers['x-custom']).toBe('value');
    expect(headers['signoz-ingestion-key']).toBe('key');
  });

  it('returns empty object when no headers', () => {
    const config = parseTelemetryConfig({});

    const headers = getExporterHeaders(config);

    expect(headers).toEqual({});
  });
});
