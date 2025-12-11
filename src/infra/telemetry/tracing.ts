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
 *
 * Features:
 * - Automatic instrumentation of HTTP, GraphQL, PostgreSQL, etc.
 * - Captures uncaughtException and unhandledRejection as error spans
 * - Log correlation with trace IDs
 */

import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
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

          // Configure HTTP instrumentation - ignore health checks at TCP/HTTP level
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

          // Configure Fastify instrumentation - ignore health checks at framework level
          '@opentelemetry/instrumentation-fastify': {
            requestHook: (span, info) => {
              // Add route pattern as attribute for better grouping in traces
              // The info.request type varies by Fastify version, so we use safe property access
              const request = info.request as Record<string, unknown> | undefined;
              const routeOptions = request?.['routeOptions'] as Record<string, unknown> | undefined;
              const routeUrl = routeOptions?.['url'];
              if (typeof routeUrl === 'string') {
                span.setAttribute('http.route', routeUrl);
              }
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
// Unhandled Error Capture
// ─────────────────────────────────────────────────────────────────────────────

/** Timeout for flushing telemetry during error handling (ms) */
const FLUSH_TIMEOUT_MS = 5000;

/** Standard semantic convention attributes for exceptions */
const SEMCONV_EXCEPTION_TYPE = 'exception.type';
const SEMCONV_EXCEPTION_MESSAGE = 'exception.message';
const SEMCONV_EXCEPTION_STACKTRACE = 'exception.stacktrace';

/**
 * Force flushes all pending telemetry data with a timeout.
 *
 * Uses forceFlush() which is designed for urgent export scenarios,
 * unlike shutdown() which tears down the entire SDK.
 *
 * @param timeoutMs - Maximum time to wait for flush (default: 5000ms)
 * @returns Promise that resolves when flush completes or times out
 */
const flushTelemetryWithTimeout = async (timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> => {
  if (sdk === undefined) {
    return;
  }

  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Telemetry flush timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    // Log but don't throw - we're already in an error state
    bootstrapLog.error('Telemetry flush failed', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Records an unhandled error as an OpenTelemetry span.
 *
 * This creates a dedicated span for the error, which ensures:
 * 1. The error appears in the tracing backend even without an active request
 * 2. Standard semantic conventions are followed for error attributes
 * 3. The error is linked to any active trace context if one exists
 *
 * @param error - The error to record
 * @param errorType - Classification of the error
 * @param additionalAttrs - Optional additional attributes to include
 */
const recordErrorAsSpan = (
  error: Error,
  errorType: 'uncaughtException' | 'unhandledRejection',
  additionalAttrs?: Record<string, string>
): void => {
  try {
    const tracer = trace.getTracer('process-errors', '1.0.0');

    // Check if there's an active span (error might have occurred during a request)
    const activeSpan = trace.getActiveSpan();
    const parentContext =
      activeSpan !== undefined ? trace.setSpan(context.active(), activeSpan) : undefined;

    // Create the error span, optionally linking to parent context
    const span = tracer.startSpan(
      `process.${errorType}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          // Standard semantic conventions for exceptions
          [SEMCONV_EXCEPTION_TYPE]: error.name,
          [SEMCONV_EXCEPTION_MESSAGE]: error.message,
          [SEMCONV_EXCEPTION_STACKTRACE]: error.stack ?? '',
          // Custom attributes for filtering/searching
          'process.error.type': errorType,
          'process.error.handled': false,
          ...additionalAttrs,
        },
      },
      parentContext
    );

    // Record the exception using OTel's standard method
    span.recordException(error);

    // Set span status to error
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `${errorType}: ${error.message}`,
    });

    // End the span immediately (it represents a point-in-time event)
    span.end();

    // If there was an active span, also record the exception on it
    if (activeSpan !== undefined) {
      activeSpan.recordException(error);
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${errorType}: ${error.message}`,
      });
    }
  } catch (recordingError) {
    // Don't let telemetry errors mask the original error
    bootstrapLog.error('Failed to record error span', {
      originalError: error.message,
      recordingError:
        recordingError instanceof Error ? recordingError.message : String(recordingError),
    });
  }
};

/**
 * Registers handlers for uncaught exceptions and unhandled promise rejections.
 *
 * These handlers ensure errors are:
 * 1. Logged to console (always, regardless of telemetry)
 * 2. Recorded as spans in OpenTelemetry (if enabled)
 * 3. Properly flushed before process exit (for uncaughtException)
 *
 * Design decisions:
 * - uncaughtException: Log, record, flush, then exit (process is in unknown state)
 * - unhandledRejection: Log, record, but don't exit (configurable via Node.js flags)
 * - warning: Log only (informational)
 */
const registerUnhandledErrorHandlers = (): void => {
  // Track if we're already handling an error (prevent infinite loops)
  let isHandlingError = false;

  // Handle uncaught synchronous exceptions
  process.on('uncaughtException', (error: Error, origin: string) => {
    // Prevent recursive error handling
    if (isHandlingError) {
      console.error('Recursive error during uncaughtException handling:', error);
      process.exitCode = 1;
      return;
    }
    isHandlingError = true;

    // Always log to console (works even if telemetry fails)
    bootstrapLog.error('Uncaught exception', {
      err: error.message,
      name: error.name,
      stack: error.stack,
      origin,
    });

    // Record to OpenTelemetry
    recordErrorAsSpan(error, 'uncaughtException', { 'exception.origin': origin });

    // Set exit code (don't call process.exit() directly - let Node.js handle it)
    process.exitCode = 1;

    // Flush telemetry before exit, then let Node.js exit naturally.
    // We must use async operations in this sync handler to ensure data export.
    // eslint-disable-next-line promise/no-promise-in-callback -- Intentional: async flush in sync error handler
    flushTelemetryWithTimeout()
      .finally(() => {
        // Node.js will exit after uncaughtException handler returns
        // Setting exitCode ensures non-zero exit even if Node doesn't exit automatically
        isHandlingError = false;
      })
      .catch(() => {
        // Already logged in flushTelemetryWithTimeout, prevent unhandled rejection
      });
  });

  // Handle unhandled promise rejections
  // Note: The promise parameter is typed as Promise<unknown> but we only use it for identification
  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    // Normalize reason to Error
    const error =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));

    // Always log to console
    bootstrapLog.error('Unhandled promise rejection', {
      err: error.message,
      name: error.name,
      stack: error.stack,
    });

    // Record to OpenTelemetry
    recordErrorAsSpan(error, 'unhandledRejection');

    // Note: We intentionally don't exit here.
    // Node.js behavior is configurable via --unhandled-rejections flag:
    // - 'throw' (default in Node 15+): Exit with code 1
    // - 'warn': Print warning (legacy behavior)
    // - 'strict': Exit immediately
    // - 'none': Silence
  });

  // Handle process warnings (deprecations, experimental features, etc.)
  process.on('warning', (warning: Error) => {
    // Log warnings for observability but don't record as error spans
    bootstrapLog.info('Process warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
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

// Always register global error handlers, even if telemetry is disabled.
// This ensures errors are logged to console regardless of configuration.
registerUnhandledErrorHandlers();
