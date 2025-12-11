/**
 * OpenTelemetry SDK Initialization for SigNoz
 *
 * This module initializes the OpenTelemetry SDK with exporters configured
 * for SigNoz (Cloud or self-hosted). It must be imported FIRST in api.ts
 * before any other imports to ensure proper instrumentation.
 *
 * Supports two modes:
 * 1. No-code: Set NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
 * 2. Code-level: Import this module at the very top of api.ts
 *
 * This file implements code-level instrumentation for more control.
 */

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, ConsoleLogRecordExporter } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import {
  parseTelemetryConfig,
  isTelemetryEnabled,
  getExporterHeaders,
  type TelemetryConfig,
} from './config.js';

import type { IncomingMessage } from 'node:http';

// ─────────────────────────────────────────────────────────────────────────────
// SDK Instance
// ─────────────────────────────────────────────────────────────────────────────

let sdk: NodeSDK | undefined;
let telemetryConfig: TelemetryConfig | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap Logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple bootstrap logger for telemetry initialization.
 *
 * We cannot use Pino here because:
 * 1. This file is imported FIRST before any other code
 * 2. Pino instrumentation is set up by this file
 * 3. Using Pino before instrumentation would miss trace correlation
 *
 * This produces JSON logs compatible with Pino format for consistency.
 */
const bootstrapLog = {
  info: (msg: string, data?: Record<string, unknown>): void => {
    const logEntry = {
      level: 'info',
      time: Date.now(),
      name: 'telemetry',
      msg,
      ...data,
    };
    console.log(JSON.stringify(logEntry));
  },
  error: (msg: string, data?: Record<string, unknown>): void => {
    const logEntry = {
      level: 'error',
      time: Date.now(),
      name: 'telemetry',
      msg,
      ...data,
    };
    console.error(JSON.stringify(logEntry));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SDK Initialization
// ─────────────────────────────────────────────────────────────────────────────

/** Standard OpenTelemetry attribute key for deployment environment */
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

/**
 * Creates the OpenTelemetry Resource with service information.
 */
const createResource = (config: TelemetryConfig) => {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: config.environment,
  };

  // Add version if available
  const version = process.env['APP_VERSION'];
  if (version !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = version;
  }

  // Add custom resource attributes
  for (const [key, value] of Object.entries(config.resourceAttributes)) {
    attributes[key] = value;
  }

  return resourceFromAttributes(attributes);
};

/**
 * Creates trace exporter based on configuration.
 */
const createTraceExporter = (config: TelemetryConfig) => {
  // Use console exporter for development/debugging when configured
  if (process.env['OTEL_TRACES_EXPORTER'] === 'console') {
    return new ConsoleSpanExporter();
  }

  return new OTLPTraceExporter({
    url: `${config.endpoint}/v1/traces`,
    headers: getExporterHeaders(config),
  });
};

/**
 * Creates metric reader based on configuration.
 */
const createMetricReader = (config: TelemetryConfig) => {
  const exporter = new OTLPMetricExporter({
    url: `${config.endpoint}/v1/metrics`,
    headers: getExporterHeaders(config),
  });

  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000, // Export metrics every 60 seconds
  });
};

/**
 * Creates log processor based on configuration.
 */
const createLogProcessor = (config: TelemetryConfig) => {
  // Use console exporter for development/debugging when configured
  if (process.env['OTEL_LOGS_EXPORTER'] === 'console') {
    return new BatchLogRecordProcessor(new ConsoleLogRecordExporter());
  }

  const exporter = new OTLPLogExporter({
    url: `${config.endpoint}/v1/logs`,
    headers: getExporterHeaders(config),
  });

  return new BatchLogRecordProcessor(exporter);
};

/**
 * Initializes the OpenTelemetry SDK.
 * Call this at the very start of your application.
 */
const initializeTelemetry = (): void => {
  // Parse configuration from environment
  telemetryConfig = parseTelemetryConfig(process.env);

  // Skip if telemetry is disabled
  if (!isTelemetryEnabled(telemetryConfig)) {
    bootstrapLog.info('Telemetry disabled via configuration');
    return;
  }

  const config = telemetryConfig;

  try {
    // Build SDK options
    const sdkOptions: ConstructorParameters<typeof NodeSDK>[0] = {
      resource: createResource(config),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs instrumentation (too noisy for file-based datasets)
          '@opentelemetry/instrumentation-fs': { enabled: false },

          // Configure Pino instrumentation for log correlation
          '@opentelemetry/instrumentation-pino': {
            logHook: (span, record) => {
              const ctx = span.spanContext();
              record['trace_id'] = ctx.traceId;
              record['span_id'] = ctx.spanId;
              record['trace_flags'] = ctx.traceFlags;
            },
          },

          // Configure GraphQL instrumentation
          '@opentelemetry/instrumentation-graphql': {
            mergeItems: true,
            ignoreTrivialResolveSpans: true,
            // Only capture query values in non-production
            allowValues: config.environment !== 'production',
          },

          // Configure PostgreSQL instrumentation
          '@opentelemetry/instrumentation-pg': {
            requireParentSpan: true,
            // Only capture query text in non-production
            enhancedDatabaseReporting: config.environment !== 'production',
          },

          // Configure HTTP instrumentation - ignore health checks
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (request: IncomingMessage) => {
              const ignoredPaths = ['/health/live', '/health/ready', '/metrics'];
              const url = request.url;
              if (url === undefined) {
                return false;
              }
              return ignoredPaths.some((p) => url.startsWith(p));
            },
          },
        }),
      ],
    };

    // Add trace exporter if enabled
    if (config.enableTraces) {
      sdkOptions.traceExporter = createTraceExporter(config);
    }

    // Add metric reader if enabled (use metricReaders array)
    if (config.enableMetrics) {
      sdkOptions.metricReaders = [createMetricReader(config)];
    }

    // Add log processor if enabled (use logRecordProcessors array)
    if (config.enableLogs) {
      sdkOptions.logRecordProcessors = [createLogProcessor(config)];
    }

    // Create and start the SDK
    sdk = new NodeSDK(sdkOptions);
    sdk.start();

    // SECURITY: Do not log config object directly as it may contain ingestionKey
    bootstrapLog.info('Telemetry started', {
      endpoint: config.endpoint,
      service: config.serviceName,
      environment: config.environment,
    });

    // Register graceful shutdown
    registerShutdownHandler();
  } catch (error) {
    bootstrapLog.error('Failed to initialize telemetry', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers process event handlers for graceful SDK shutdown.
 */
const registerShutdownHandler = (): void => {
  const shutdown = async (): Promise<void> => {
    if (sdk === undefined) return;

    try {
      await sdk.shutdown();
      bootstrapLog.info('Telemetry shut down successfully');
    } catch (error) {
      bootstrapLog.error('Error during telemetry shutdown', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Note: We register for SIGTERM and SIGINT, but api.ts also handles these.
  // The SDK shutdown is idempotent, so double-calling is safe.
  process.on('SIGTERM', () => {
    void shutdown();
  });

  process.on('SIGINT', () => {
    void shutdown();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the current telemetry configuration.
 * Returns undefined if telemetry hasn't been initialized.
 */
export const getTelemetryConfig = (): TelemetryConfig | undefined => {
  return telemetryConfig;
};

/**
 * Checks if telemetry is currently active.
 */
export const isTelemetryActive = (): boolean => {
  return sdk !== undefined;
};

/**
 * Manually shuts down the telemetry SDK.
 * Useful for tests or graceful shutdown handlers.
 */
export const shutdownTelemetry = async (): Promise<void> => {
  if (sdk !== undefined) {
    await sdk.shutdown();
    sdk = undefined;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Initialize on Import
// ─────────────────────────────────────────────────────────────────────────────

// Initialize telemetry immediately when this module is imported.
// This ensures instrumentation is set up before any other code runs.
initializeTelemetry();
