/**
 * Telemetry Configuration
 *
 * Parses OpenTelemetry environment variables for SigNoz integration.
 * Supports both SigNoz Cloud and self-hosted deployments.
 *
 * @security The TelemetryConfig type contains sensitive data (ingestionKey).
 * NEVER log the entire config object. When logging, explicitly select only
 * safe fields like endpoint, serviceName, and environment.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TypeBox schema for telemetry configuration validation.
 */
export const TelemetryConfigSchema = Type.Object({
  /** OTLP endpoint for SigNoz (Cloud or self-hosted) */
  endpoint: Type.String({ default: 'http://localhost:4318' }),

  /** SigNoz ingestion key (Cloud only, optional for self-hosted) */
  ingestionKey: Type.Optional(Type.String()),

  /** Service name for identification in SigNoz */
  serviceName: Type.String({ default: 'transparenta-eu-server' }),

  /** Deployment environment (development, staging, production) */
  environment: Type.String({ default: 'development' }),

  /** Master switch to enable/disable all telemetry */
  enabled: Type.Boolean({ default: true }),

  /** Enable trace export */
  enableTraces: Type.Boolean({ default: true }),

  /** Enable metrics export */
  enableMetrics: Type.Boolean({ default: true }),

  /** Enable log export via OTLP */
  enableLogs: Type.Boolean({ default: true }),

  /** Trace sampling rate (0.0 - 1.0, where 1.0 = 100%) */
  sampleRate: Type.Number({ default: 1, minimum: 0, maximum: 1 }),

  /** Additional OTLP headers (parsed from OTEL_EXPORTER_OTLP_HEADERS) */
  headers: Type.Record(Type.String(), Type.String(), { default: {} }),

  /** Resource attributes (parsed from OTEL_RESOURCE_ATTRIBUTES) */
  resourceAttributes: Type.Record(Type.String(), Type.String(), { default: {} }),
});

export type TelemetryConfig = Static<typeof TelemetryConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a comma-separated key=value string into a Record.
 * Format: "key1=value1,key2=value2"
 *
 * @example
 * parseKeyValueString("signoz-ingestion-key=abc,x-custom=foo")
 * // => { "signoz-ingestion-key": "abc", "x-custom": "foo" }
 */
const parseKeyValueString = (input: string | undefined): Record<string, string> => {
  if (input === undefined || input === '') {
    return {};
  }

  const result: Record<string, string> = {};

  for (const pair of input.split(',')) {
    const [key, ...valueParts] = pair.split('=');
    if (key !== undefined && key.trim() !== '') {
      result[key.trim()] = valueParts.join('=').trim();
    }
  }

  return result;
};

/**
 * Extracts the SigNoz ingestion key from OTEL_EXPORTER_OTLP_HEADERS.
 * Looks for "signoz-ingestion-key=<value>" or "signoz-access-token=<value>".
 */
const extractIngestionKey = (headers: Record<string, string>): string | undefined => {
  return headers['signoz-ingestion-key'] ?? headers['signoz-access-token'];
};

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses telemetry configuration from environment variables.
 *
 * Standard OpenTelemetry environment variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT - OTLP endpoint URL
 * - OTEL_EXPORTER_OTLP_HEADERS - Headers (key=value,key2=value2)
 * - OTEL_SERVICE_NAME - Service name for identification
 * - OTEL_SDK_DISABLED - Master disable switch
 * - OTEL_TRACES_EXPORTER - "none" to disable traces
 * - OTEL_METRICS_EXPORTER - "none" to disable metrics
 * - OTEL_LOGS_EXPORTER - "none" to disable logs
 * - OTEL_TRACES_SAMPLER_ARG - Sampling rate (0.0 - 1.0)
 * - OTEL_RESOURCE_ATTRIBUTES - Resource attributes (key=value)
 * - NODE_ENV - Deployment environment
 *
 * @param env - Process environment variables
 * @returns Validated telemetry configuration
 */
export const parseTelemetryConfig = (env: NodeJS.ProcessEnv): TelemetryConfig => {
  const headers = parseKeyValueString(env['OTEL_EXPORTER_OTLP_HEADERS']);
  const resourceAttributes = parseKeyValueString(env['OTEL_RESOURCE_ATTRIBUTES']);

  // Parse sample rate, defaulting to 1.0 (100%)
  let sampleRate = 1;
  const sampleRateEnv = env['OTEL_TRACES_SAMPLER_ARG'];
  if (sampleRateEnv !== undefined && sampleRateEnv !== '') {
    // Use Number() for safe parsing (not financial data, just a ratio)
    const parsed = Number(sampleRateEnv);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      sampleRate = parsed;
    }
  }

  const config = {
    endpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318',
    ingestionKey: extractIngestionKey(headers),
    serviceName: env['OTEL_SERVICE_NAME'] ?? 'transparenta-eu-server',
    environment: env['NODE_ENV'] ?? 'development',
    enabled: env['OTEL_SDK_DISABLED'] !== 'true',
    enableTraces: env['OTEL_TRACES_EXPORTER'] !== 'none',
    enableMetrics: env['OTEL_METRICS_EXPORTER'] !== 'none',
    enableLogs: env['OTEL_LOGS_EXPORTER'] !== 'none',
    sampleRate,
    headers,
    resourceAttributes,
  };

  // Validate against schema
  if (!Value.Check(TelemetryConfigSchema, config)) {
    const errors = [...Value.Errors(TelemetryConfigSchema, config)];
    const errorMessages = errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    console.warn(`Invalid telemetry configuration: ${errorMessages}. Using defaults.`);
    return Value.Default(TelemetryConfigSchema, {}) as TelemetryConfig;
  }

  return config;
};

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the configuration is for SigNoz Cloud (has ingestion key).
 */
export const isSigNozCloud = (config: TelemetryConfig): boolean => {
  return config.ingestionKey !== undefined && config.ingestionKey !== '';
};

/**
 * Checks if any telemetry is enabled.
 */
export const isTelemetryEnabled = (config: TelemetryConfig): boolean => {
  return config.enabled && (config.enableTraces || config.enableMetrics || config.enableLogs);
};

/**
 * Gets the OTLP headers for exporter configuration.
 * Adds the SigNoz ingestion key header if present.
 */
export const getExporterHeaders = (config: TelemetryConfig): Record<string, string> => {
  const headers = { ...config.headers };

  // Ensure ingestion key is in headers for SigNoz Cloud
  if (config.ingestionKey !== undefined && config.ingestionKey !== '') {
    headers['signoz-ingestion-key'] = config.ingestionKey;
  }

  return headers;
};
