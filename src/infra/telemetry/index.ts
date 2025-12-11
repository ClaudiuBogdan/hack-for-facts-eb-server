/**
 * Telemetry Module - Public API
 *
 * Provides OpenTelemetry instrumentation for SigNoz integration.
 *
 * ## Usage
 *
 * ### Application Startup (api.ts)
 *
 * Import the tracing module FIRST, before any other imports:
 *
 * ```typescript
 * // MUST be first import to ensure proper instrumentation
 * import '@/infra/telemetry/tracing.js';
 *
 * // Rest of imports
 * import { buildApp } from './app/build-app.js';
 * ```
 *
 * ### Adding Context to Spans (Shell Layer)
 *
 * Use attribute helpers in resolvers and handlers:
 *
 * ```typescript
 * import { setEntityContext, setAnalyticsContext } from '@/infra/telemetry/index.js';
 *
 * // In a GraphQL resolver
 * const result = await getEntity({ entityRepo }, { cui });
 * if (result.isOk() && result.value !== null) {
 *   setEntityContext(result.value.cui, result.value.name);
 * }
 * ```
 *
 * ## Environment Variables
 *
 * ### SigNoz Cloud
 *
 * ```bash
 * OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.eu.signoz.cloud:443
 * OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=<your-key>
 * OTEL_SERVICE_NAME=transparenta-eu-server
 * ```
 *
 * ### Self-Hosted SigNoz
 *
 * ```bash
 * OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 * OTEL_SERVICE_NAME=transparenta-eu-server
 * ```
 *
 * ### Disable Telemetry
 *
 * ```bash
 * OTEL_SDK_DISABLED=true
 * ```
 */

// Configuration
export {
  parseTelemetryConfig,
  isSigNozCloud,
  isTelemetryEnabled,
  getExporterHeaders,
  TelemetryConfigSchema,
  type TelemetryConfig,
} from './config.js';

// SDK Control (normally not needed - tracing.ts auto-initializes)
export { getTelemetryConfig, isTelemetryActive, shutdownTelemetry } from './tracing.js';

// Span Attribute Helpers
export {
  // Constants
  ATTR,

  // Entity context
  setEntityContext,

  // UAT context
  setUatContext,

  // Analytics context
  setAnalyticsContext,
  setPeriodContext,

  // Budget context
  setBudgetSectorContext,
  setBudgetClassificationContext,

  // Query context
  setQueryResultContext,
  setFilterCount,

  // Error recording
  recordError,

  // Generic
  setAttribute,
} from './attributes.js';
