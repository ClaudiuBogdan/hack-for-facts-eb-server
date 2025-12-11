# Observability Specification

## Logging, Tracing & Metrics Strategy for Transparenta.eu with SigNoz

**Version**: 1.1  
**Status**: Proposed  
**Last Updated**: 2024-12-11

---

## 1. Problem Statement

### 1.1 Current State

Transparenta.eu currently uses:

- **Pino** for structured JSON logging
- No distributed tracing
- No application metrics (only PostgreSQL/Redis built-in metrics)

### 1.2 Observability Gaps

| Gap                      | Impact                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| No distributed tracing   | Cannot trace requests across GraphQL → Repository → Database           |
| No application metrics   | Cannot measure query latency percentiles, cache hit rates, error rates |
| No log correlation       | Cannot correlate logs with specific requests or traces                 |
| No performance baselines | Cannot detect performance regressions                                  |
| No alerting data         | Cannot set up alerts for anomalies                                     |

### 1.3 Business Requirements

1. **Trace GraphQL operations** end-to-end (resolver → repository → database)
2. **Monitor query performance** with latency histograms (RED metrics)
3. **Correlate logs** with trace context for debugging
4. **Unified observability platform** for traces, metrics, and logs
5. **Self-hosted option** for data sovereignty and cost control
6. **Zero-downtime rollout** — observability should not break existing functionality

---

## 2. Why SigNoz?

### 2.1 What is SigNoz?

[SigNoz](https://signoz.io/) is an open-source, OpenTelemetry-native observability platform that provides:

- **Unified APM**: Traces, metrics, and logs in a single platform
- **OpenTelemetry Native**: Built specifically for OpenTelemetry data
- **Self-Hosted & Cloud**: Choose between self-hosted (data sovereignty) or SigNoz Cloud
- **ClickHouse Backend**: Fast analytical queries on telemetry data
- **Cost Effective**: No per-host or per-span pricing

### 2.2 SigNoz vs Alternatives

| Feature                     | SigNoz           | Grafana Stack    | Datadog       | Jaeger           |
| --------------------------- | ---------------- | ---------------- | ------------- | ---------------- |
| **OpenTelemetry Native**    | Yes              | Partial          | Partial       | Traces only      |
| **Unified Platform**        | Yes              | Multiple tools   | Yes           | No (traces only) |
| **Self-Hosted**             | Yes (free)       | Yes (complex)    | No            | Yes              |
| **Logs + Traces + Metrics** | Single UI        | 3 separate UIs   | Single UI     | No logs/metrics  |
| **Pricing Model**           | Open Source / GB | Per-host metrics | Per-host + GB | Open Source      |
| **Query Language**          | ClickHouse SQL   | PromQL/LogQL     | Proprietary   | Limited          |

### 2.3 Key SigNoz Features for Transparenta.eu

1. **RED Metrics Dashboard**: Automatic Rate, Errors, Duration metrics from traces
2. **Trace-to-Logs Correlation**: Click from trace to related logs
3. **Service Map**: Visualize dependencies between services
4. **Alerting**: Built-in alerting on any metric or trace attribute
5. **Query Builder**: Powerful filtering without learning new query languages

---

## 3. Architecture Overview

### 3.1 Deployment Options

**Option A: SigNoz Cloud (Recommended for Getting Started)**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SigNoz Cloud                                     │
│   https://ingest.<region>.signoz.cloud:443                          │
│   Traces │ Metrics │ Logs                                           │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ OTLP (HTTP)
                              │ Header: signoz-ingestion-key
                              │
┌─────────────────────────────┴───────────────────────────────────────┐
│                    Transparenta.eu Server                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                OpenTelemetry SDK (Node.js)                  │    │
│  │  Auto-instrumentation → OTLP Export → SigNoz Cloud          │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

**Option B: Self-Hosted SigNoz (Recommended for Production)**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Self-Hosted SigNoz                               │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│   │   Query     │  │  ClickHouse │  │   Alert     │                 │
│   │   Service   │  │   (Storage) │  │   Manager   │                 │
│   └──────┬──────┘  └──────┬──────┘  └─────────────┘                 │
│          │                │                                         │
│   ┌──────┴────────────────┴──────┐                                  │
│   │     OTel Collector           │ ← http://localhost:4318          │
│   └──────────────────────────────┘                                  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ OTLP (HTTP)
                              │
┌─────────────────────────────┴───────────────────────────────────────┐
│                    Transparenta.eu Server                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                OpenTelemetry SDK (Node.js)                  │    │
│  │  Auto-instrumentation → OTLP Export → SigNoz Collector      │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Signal Types

| Signal      | Purpose                                         | SigNoz Tab |
| ----------- | ----------------------------------------------- | ---------- |
| **Traces**  | Request flow across services and components     | Traces     |
| **Metrics** | RED metrics (auto-generated from traces)        | Services   |
| **Logs**    | Structured event records with trace correlation | Logs       |

### 3.3 Integration Points

```
Request → Fastify HTTP → GraphQL Resolver → Use Case → Repository → PostgreSQL
    │          │              │                           │            │
    └──────────┴──────────────┴───────────────────────────┴────────────┘
           All layers emit spans → SigNoz computes RED metrics
```

---

## 4. Key Design Decisions

### 4.1 OpenTelemetry Auto-Instrumentation

**Decision**: Use `@opentelemetry/auto-instrumentations-node` for zero-code instrumentation.

**Rationale**:

- SigNoz recommends this approach for Node.js
- No code changes required for basic tracing
- Covers HTTP, Fastify, GraphQL, PostgreSQL, ioredis, Pino automatically

**Implementation**:

```bash
# No-code approach (recommended by SigNoz)
NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
```

### 4.2 OTLP HTTP Protocol

**Decision**: Use OTLP over HTTP (not gRPC) for all signal types.

**Rationale**:

- SigNoz Cloud uses HTTPS on port 443
- Simpler firewall configuration
- Works through proxies and load balancers

**SigNoz Endpoints**:

| Signal  | SigNoz Cloud Endpoint                                 | Self-Hosted Endpoint               |
| ------- | ----------------------------------------------------- | ---------------------------------- |
| Traces  | `https://ingest.<region>.signoz.cloud:443/v1/traces`  | `http://localhost:4318/v1/traces`  |
| Metrics | `https://ingest.<region>.signoz.cloud:443/v1/metrics` | `http://localhost:4318/v1/metrics` |
| Logs    | `https://ingest.<region>.signoz.cloud:443/v1/logs`    | `http://localhost:4318/v1/logs`    |

### 4.3 Pino Log Correlation

**Decision**: Use `@opentelemetry/instrumentation-pino` for automatic trace context injection.

**Rationale**:

- Pino is already configured in the project
- Auto-injects `trace_id`, `span_id`, `trace_flags` into logs
- Enables SigNoz's trace-to-logs correlation feature

**Log Format with Trace Context**:

```json
{
  "level": "info",
  "time": "2024-12-11T10:15:30.123Z",
  "msg": "GraphQL query completed",
  "trace_id": "abc123def456ghi789jkl012mno345pq",
  "span_id": "rst678uvw901xyz",
  "trace_flags": "01",
  "operation": "entity",
  "duration_ms": 45
}
```

### 4.4 SigNoz Cloud Regions

**Decision**: Use EU region for GDPR compliance.

**Available Regions**:

| Region | Endpoint                 | Use Case             |
| ------ | ------------------------ | -------------------- |
| US     | `ingest.us.signoz.cloud` | US data residency    |
| EU     | `ingest.eu.signoz.cloud` | GDPR compliance      |
| IN     | `ingest.in.signoz.cloud` | India data residency |

### 4.5 Instrumentation Location (Shell Only)

**Decision**: Telemetry initialization in `src/infra/telemetry/`, wired at application startup.

**Rationale**:

- Core remains pure (no side effects, no I/O)
- Shell handles all observability concerns
- Consistent with Functional Core / Imperative Shell pattern

---

## 5. Implementation

### 5.1 Package Installation

```bash
# Core OpenTelemetry packages (SigNoz recommended)
pnpm add @opentelemetry/api \
         @opentelemetry/auto-instrumentations-node

# For code-level instrumentation (optional)
pnpm add @opentelemetry/sdk-node \
         @opentelemetry/exporter-trace-otlp-http \
         @opentelemetry/exporter-metrics-otlp-http \
         @opentelemetry/exporter-logs-otlp-http \
         @opentelemetry/instrumentation-pino \
         @opentelemetry/resources \
         @opentelemetry/semantic-conventions \
         @opentelemetry/sdk-logs
```

### 5.2 No-Code Instrumentation (Recommended)

**Environment Variables for SigNoz Cloud**:

```bash
# SigNoz Cloud Configuration
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.eu.signoz.cloud:443"
export OTEL_EXPORTER_OTLP_HEADERS="signoz-ingestion-key=<your-ingestion-key>"
export OTEL_SERVICE_NAME="transparenta-eu-server"
export OTEL_NODE_RESOURCE_DETECTORS="env,host,os"
export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

# Run the application
node dist/api.js
```

**Environment Variables for Self-Hosted SigNoz**:

```bash
# Self-Hosted Configuration
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="transparenta-eu-server"
export OTEL_NODE_RESOURCE_DETECTORS="env,host,os"
export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

# Run the application
node dist/api.js
```

### 5.3 Code-Level Instrumentation (Advanced)

For more control, create a telemetry initialization file:

```typescript
// src/infra/telemetry/tracing.ts

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

// SigNoz configuration from environment
const signozEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';
const signozHeaders = process.env['OTEL_EXPORTER_OTLP_HEADERS'];
const serviceName = process.env['OTEL_SERVICE_NAME'] ?? 'transparenta-eu-server';
const environment = process.env['NODE_ENV'] ?? 'development';

// Parse headers (format: "key=value,key2=value2")
const parseHeaders = (headerString?: string): Record<string, string> => {
  if (!headerString) return {};
  return Object.fromEntries(
    headerString.split(',').map((pair) => {
      const [key, ...valueParts] = pair.split('=');
      return [key.trim(), valueParts.join('=').trim()];
    })
  );
};

const headers = parseHeaders(signozHeaders);

// Create exporters for SigNoz
const traceExporter = new OTLPTraceExporter({
  url: `${signozEndpoint}/v1/traces`,
  headers,
});

const metricExporter = new OTLPMetricExporter({
  url: `${signozEndpoint}/v1/metrics`,
  headers,
});

const logExporter = new OTLPLogExporter({
  url: `${signozEndpoint}/v1/logs`,
  headers,
});

// Initialize SDK
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: environment,
  }),
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation (too noisy)
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Configure Pino instrumentation for log correlation
      '@opentelemetry/instrumentation-pino': {
        logHook: (span, record) => {
          record['trace_id'] = span.spanContext().traceId;
          record['span_id'] = span.spanContext().spanId;
          record['trace_flags'] = span.spanContext().traceFlags;
        },
      },
      // Configure GraphQL instrumentation
      '@opentelemetry/instrumentation-graphql': {
        mergeItems: true,
        ignoreTrivialResolveSpans: true,
        allowValues: environment !== 'production',
      },
      // Configure pg instrumentation
      '@opentelemetry/instrumentation-pg': {
        requireParentSpan: true,
        enhancedDatabaseReporting: environment !== 'production',
      },
    }),
  ],
});

sdk.start();
console.log(`OpenTelemetry SDK started, sending to ${signozEndpoint}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => console.log('OpenTelemetry SDK shut down successfully'))
    .catch((error) => console.error('Error shutting down SDK', error))
    .finally(() => process.exit(0));
});

export default sdk;
```

**Application Integration**:

```typescript
// src/api.ts - Import tracing FIRST before any other imports
import './infra/telemetry/tracing.js';

// Rest of imports
import { buildApp } from './app/build-app.js';
// ...
```

### 5.4 Docker Integration

**Dockerfile**:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# OpenTelemetry environment variables for SigNoz
ENV OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.eu.signoz.cloud:443"
ENV OTEL_NODE_RESOURCE_DETECTORS="env,host,os"
ENV OTEL_SERVICE_NAME="transparenta-eu-server"
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
# OTEL_EXPORTER_OTLP_HEADERS set at runtime for security

EXPOSE 3000

CMD ["node", "dist/api.js"]
```

**docker-compose.yml (with self-hosted SigNoz)**:

```yaml
version: '3.8'

services:
  transparenta-api:
    build: .
    ports:
      - '3000:3000'
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector:4318
      - OTEL_SERVICE_NAME=transparenta-eu-server
      - OTEL_NODE_RESOURCE_DETECTORS=env,host,os
      - NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register
    depends_on:
      - signoz-otel-collector

  # SigNoz services (from SigNoz docker-compose)
  signoz-otel-collector:
    image: signoz/signoz-otel-collector:latest
    # ... rest of SigNoz configuration
```

---

## 6. Module Structure

### 6.1 Directory Layout

```
src/
├── infra/
│   └── telemetry/
│       ├── index.ts              # Public API exports
│       ├── tracing.ts            # SDK initialization (code-level approach)
│       ├── config.ts             # Configuration parsing
│       └── attributes.ts         # Custom span attribute helpers
│
├── app/
│   └── build-app.ts              # Application composition root
│
└── api.ts                        # Entry point (imports tracing first)
```

### 6.2 Configuration Schema

```typescript
// src/infra/telemetry/config.ts

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const TelemetryConfigSchema = Type.Object({
  // SigNoz endpoint
  endpoint: Type.String({ default: 'http://localhost:4318' }),

  // SigNoz ingestion key (Cloud only)
  ingestionKey: Type.Optional(Type.String()),

  // Service identification
  serviceName: Type.String({ default: 'transparenta-eu-server' }),
  environment: Type.String({ default: 'development' }),

  // Feature flags
  enabled: Type.Boolean({ default: true }),
  enableTraces: Type.Boolean({ default: true }),
  enableMetrics: Type.Boolean({ default: true }),
  enableLogs: Type.Boolean({ default: true }),

  // Sampling (1.0 = 100%, 0.1 = 10%)
  sampleRate: Type.Number({ default: 1.0, minimum: 0, maximum: 1 }),
});

export type TelemetryConfig = Static<typeof TelemetryConfigSchema>;

export const parseTelemetryConfig = (env: NodeJS.ProcessEnv): TelemetryConfig => {
  const headersString = env['OTEL_EXPORTER_OTLP_HEADERS'];
  const ingestionKey = headersString?.includes('signoz-ingestion-key')
    ? headersString.split('signoz-ingestion-key=')[1]?.split(',')[0]
    : undefined;

  const config = {
    endpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318',
    ingestionKey,
    serviceName: env['OTEL_SERVICE_NAME'] ?? 'transparenta-eu-server',
    environment: env['NODE_ENV'] ?? 'development',
    enabled: env['OTEL_SDK_DISABLED'] !== 'true',
    enableTraces: env['OTEL_TRACES_EXPORTER'] !== 'none',
    enableMetrics: env['OTEL_METRICS_EXPORTER'] !== 'none',
    enableLogs: env['OTEL_LOGS_EXPORTER'] !== 'none',
    sampleRate: parseFloat(env['OTEL_TRACES_SAMPLER_ARG'] ?? '1.0'),
  };

  if (!Value.Check(TelemetryConfigSchema, config)) {
    console.warn('Invalid telemetry configuration, using defaults');
    return Value.Default(TelemetryConfigSchema, {}) as TelemetryConfig;
  }

  return config;
};
```

---

## 7. SigNoz Features Utilization

### 7.1 Services Dashboard (RED Metrics)

SigNoz automatically computes RED metrics from trace data:

| Metric           | Description                   | SigNoz Calculation              |
| ---------------- | ----------------------------- | ------------------------------- |
| **Request Rate** | Operations per second         | Count of root spans / time      |
| **Error Rate**   | Percentage of failed requests | Spans with error / total        |
| **P50/P95/P99**  | Latency percentiles           | Span duration distribution      |
| **Apdex Score**  | User satisfaction (0-1)       | Based on configurable threshold |

**No additional code needed** — SigNoz computes these from traces automatically.

### 7.2 Trace Explorer

Filter and search traces by:

- `service.name = "transparenta-eu-server"`
- `http.route = "/graphql"`
- `db.system = "postgresql"`
- Custom attributes (entity.cui, period.type, etc.)

### 7.3 Log Correlation

With Pino instrumentation, logs automatically include trace context:

1. View a trace in SigNoz
2. Click "Related Logs"
3. See all Pino logs for that trace

### 7.4 Alerts

Create alerts in SigNoz UI:

| Alert Name       | Condition                                  | Notification |
| ---------------- | ------------------------------------------ | ------------ |
| High Error Rate  | `error_rate > 5%` for 5 minutes            | Slack/Email  |
| Slow GraphQL     | `P99 latency > 3s` for `POST /graphql`     | Slack/Email  |
| Database Timeout | `db.system = postgresql AND duration > 5s` | PagerDuty    |

---

## 8. Environment Variables Reference

### 8.0 Variable Reference Table

| Variable                      | Purpose                                                                                                    | Default                  | Example                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint URL where telemetry is sent                                                                  | `http://localhost:4318`  | `https://ingest.eu.signoz.cloud:443`                |
| `OTEL_EXPORTER_OTLP_HEADERS`  | HTTP headers for OTLP requests (format: `key=value,key2=value2`). Required for SigNoz Cloud authentication | -                        | `signoz-ingestion-key=abc123`                       |
| `OTEL_SERVICE_NAME`           | Service identifier shown in SigNoz dashboards                                                              | `transparenta-eu-server` | `my-api-server`                                     |
| `OTEL_SDK_DISABLED`           | Master kill switch to disable ALL telemetry                                                                | `false`                  | `true`                                              |
| `OTEL_TRACES_EXPORTER`        | Trace exporter type. Set to `none` to disable traces, `console` for stdout debugging                       | OTLP                     | `none`, `console`                                   |
| `OTEL_METRICS_EXPORTER`       | Metrics exporter type. Set to `none` to disable metrics                                                    | OTLP                     | `none`                                              |
| `OTEL_LOGS_EXPORTER`          | Logs exporter type. Set to `none` to disable log export via OTLP                                           | OTLP                     | `none`                                              |
| `OTEL_TRACES_SAMPLER_ARG`     | Trace sampling rate (0.0 - 1.0). Use in production to reduce volume/costs                                  | `1.0` (100%)             | `0.1` (10%)                                         |
| `OTEL_RESOURCE_ATTRIBUTES`    | Custom metadata attached to all telemetry (format: `key=value,key2=value2`)                                | -                        | `deployment.environment=prod,service.version=1.2.3` |

#### When to Use Each Variable

| Scenario                      | Variables to Set                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| **SigNoz Cloud**              | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (with ingestion key), `OTEL_SERVICE_NAME` |
| **Self-Hosted SigNoz**        | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`                                                    |
| **Production (high traffic)** | Add `OTEL_TRACES_SAMPLER_ARG=0.1` to sample 10%                                                       |
| **Local debugging**           | `OTEL_TRACES_EXPORTER=console`, `OTEL_LOGS_EXPORTER=console`                                          |
| **Disable in tests**          | `OTEL_SDK_DISABLED=true`                                                                              |
| **Disable specific signals**  | `OTEL_TRACES_EXPORTER=none` or `OTEL_METRICS_EXPORTER=none` or `OTEL_LOGS_EXPORTER=none`              |

### 8.1 SigNoz Cloud

```bash
# Required
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.eu.signoz.cloud:443
OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=<your-key>
OTEL_SERVICE_NAME=transparenta-eu-server

# Recommended
OTEL_NODE_RESOURCE_DETECTORS=env,host,os
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register

# Optional (sampling for high-traffic production)
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

### 8.2 Self-Hosted SigNoz

```bash
# Required
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=transparenta-eu-server

# Recommended
OTEL_NODE_RESOURCE_DETECTORS=env,host,os
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register

# Note: No ingestion key needed for self-hosted
```

### 8.3 Development (Console Output)

```bash
# Disable external export, use console
OTEL_TRACES_EXPORTER=console
OTEL_METRICS_EXPORTER=console
OTEL_LOGS_EXPORTER=console
OTEL_SERVICE_NAME=transparenta-eu-server
NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register
OTEL_LOG_LEVEL=debug
```

### 8.4 Disable Telemetry

```bash
OTEL_SDK_DISABLED=true
```

---

## 9. Self-Hosted SigNoz Deployment

### 9.1 Docker Compose Installation

```bash
# Clone SigNoz repository
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy

# Start SigNoz
docker compose -f docker/clickhouse-setup/docker-compose.yaml up -d
```

SigNoz UI will be available at `http://localhost:3301`.

### 9.2 Kubernetes Installation

```bash
# Add SigNoz Helm repo
helm repo add signoz https://charts.signoz.io

# Install SigNoz
helm install my-release signoz/signoz \
  --namespace platform \
  --create-namespace
```

### 9.3 Resource Requirements

| Component      | CPU  | Memory | Storage     |
| -------------- | ---- | ------ | ----------- |
| OTel Collector | 0.5  | 512MB  | -           |
| Query Service  | 1    | 1GB    | -           |
| ClickHouse     | 2    | 4GB    | 50GB+ (SSD) |
| Alert Manager  | 0.25 | 256MB  | -           |

### 9.4 Data Retention

Configure in SigNoz settings:

| Data Type | Default Retention | Recommended (Production) |
| --------- | ----------------- | ------------------------ |
| Traces    | 7 days            | 15-30 days               |
| Metrics   | 30 days           | 90 days                  |
| Logs      | 7 days            | 15-30 days               |

---

## 10. Logging Strategy

### 10.1 Log Levels

| Level   | Usage                       | Examples                               |
| ------- | --------------------------- | -------------------------------------- |
| `fatal` | Application cannot continue | Database connection failed at startup  |
| `error` | Operation failed            | Query timeout, validation error        |
| `warn`  | Potentially problematic     | Slow query, cache miss on expected key |
| `info`  | Normal operations           | Server started, request completed      |
| `debug` | Diagnostic information      | Query parameters, cache key            |
| `trace` | Detailed tracing            | SQL statements (non-production only)   |

### 10.2 Structured Log Format for SigNoz

SigNoz parses JSON logs automatically. Ensure logs include:

```json
{
  "level": "info",
  "time": 1702289730123,
  "msg": "GraphQL query completed",
  "trace_id": "abc123def456ghi789jkl012mno345pq",
  "span_id": "rst678uvw901xyz",
  "trace_flags": "01",
  "service": "transparenta-eu-server",
  "operation": "entity",
  "entity_cui": "4267117"
}
```

### 10.3 Log Query Examples in SigNoz

```sql
-- Find errors for a specific trace
SELECT * FROM logs
WHERE trace_id = 'abc123def456ghi789jkl012mno345pq'
AND level = 'error'

-- Find slow operations
SELECT * FROM logs
WHERE body LIKE '%duration_ms%'
AND JSONExtractInt(body, 'duration_ms') > 1000
```

---

## 11. Tracing Strategy

### 11.1 Span Hierarchy (Auto-Instrumented)

```
HTTP POST /graphql (http)
└── middleware (fastify)
    └── graphql.parse
    └── graphql.validate
    └── graphql.execute
        └── Query.entities (graphql.resolve)
            └── pg.query SELECT (pg)
                └── redis GET (ioredis, if cache check)
```

### 11.2 Custom Span Attributes

Add business context to auto-generated spans:

```typescript
// src/infra/telemetry/attributes.ts

import { trace } from '@opentelemetry/api';

/**
 * Add entity context to current span.
 * Call from resolvers (shell layer only).
 */
export const setEntityContext = (cui: string, name?: string): void => {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('entity.cui', cui);
    if (name) span.setAttribute('entity.name', name);
  }
};

/**
 * Add analytics context to current span.
 */
export const setAnalyticsContext = (periodType: string, normalization: string): void => {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('analytics.period_type', periodType);
    span.setAttribute('analytics.normalization', normalization);
  }
};
```

### 11.3 Sampling Strategy

| Environment | Sample Rate | Configuration                 |
| ----------- | ----------- | ----------------------------- |
| Development | 100%        | Default (no sampling config)  |
| Staging     | 100%        | Default                       |
| Production  | 10-20%      | `OTEL_TRACES_SAMPLER_ARG=0.1` |

**Note**: SigNoz always samples error spans regardless of sampling rate.

---

## 12. Testing Strategy

### 12.1 Unit Tests

```typescript
// tests/unit/infra/telemetry/config.test.ts

import { describe, it, expect } from 'vitest';
import { parseTelemetryConfig } from '@/infra/telemetry/config.js';

describe('parseTelemetryConfig', () => {
  it('parses SigNoz Cloud configuration', () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ingest.eu.signoz.cloud:443',
      OTEL_EXPORTER_OTLP_HEADERS: 'signoz-ingestion-key=test-key-123',
      OTEL_SERVICE_NAME: 'test-service',
    };

    const config = parseTelemetryConfig(env);

    expect(config.endpoint).toBe('https://ingest.eu.signoz.cloud:443');
    expect(config.ingestionKey).toBe('test-key-123');
    expect(config.serviceName).toBe('test-service');
  });

  it('parses self-hosted configuration', () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'test-service',
    };

    const config = parseTelemetryConfig(env);

    expect(config.endpoint).toBe('http://localhost:4318');
    expect(config.ingestionKey).toBeUndefined();
  });

  it('handles disabled SDK', () => {
    const env = { OTEL_SDK_DISABLED: 'true' };
    const config = parseTelemetryConfig(env);
    expect(config.enabled).toBe(false);
  });
});
```

### 12.2 Integration Tests

Telemetry should be disabled in integration tests to avoid noise:

```typescript
// tests/setup.ts

process.env['OTEL_SDK_DISABLED'] = 'true';
```

### 12.3 Verify Telemetry is Working

```bash
# Enable debug logging
export OTEL_LOG_LEVEL=debug

# Start application
node dist/api.js

# Look for output like:
# @opentelemetry/instrumentation-http Instrumentation HTTP enabled
# Sending spans to https://ingest.eu.signoz.cloud:443/v1/traces
```

---

## 13. Rollout Plan

### Phase 1: Foundation (Day 1-2)

- [ ] Install OpenTelemetry packages
- [ ] Set up environment variables for SigNoz Cloud
- [ ] Verify traces appear in SigNoz Services dashboard
- [ ] Verify auto-generated RED metrics

### Phase 2: Log Correlation (Day 3)

- [ ] Verify Pino logs include trace context
- [ ] Configure OTLP log export to SigNoz
- [ ] Test trace-to-logs navigation in SigNoz UI

### Phase 3: Custom Attributes (Day 4-5)

- [ ] Add `entity.cui` attributes to entity resolvers
- [ ] Add `analytics.*` attributes to analytics resolvers
- [ ] Create SigNoz saved queries for common filters

### Phase 4: Alerting (Day 6-7)

- [ ] Create High Error Rate alert
- [ ] Create Slow Query alert
- [ ] Configure Slack/Email notifications

### Phase 5: Production Deployment (Week 2)

- [ ] Configure sampling for production traffic
- [ ] Set up self-hosted SigNoz (if required for data sovereignty)
- [ ] Document runbooks for common observability tasks
- [ ] Performance testing to verify < 5% overhead

---

## 14. SigNoz Dashboard Templates

### 14.1 Service Overview Dashboard

Create in SigNoz UI with these panels:

1. **Request Rate** - `rate(signoz_calls_total{service_name="transparenta-eu-server"}[5m])`
2. **Error Rate** - `rate(signoz_calls_total{status_code="ERROR"}[5m]) / rate(signoz_calls_total[5m])`
3. **P99 Latency** - `histogram_quantile(0.99, signoz_latency_bucket{service_name="transparenta-eu-server"})`
4. **Top Operations** - Table of operations by call count

### 14.2 Database Performance Dashboard

1. **Query Duration P99** - Filter by `db.system = postgresql`
2. **Queries per Second** - Count of `pg.query` spans
3. **Slow Queries** - Filter by `duration > 1s`

### 14.3 GraphQL Operations Dashboard

1. **Operations by Type** - Group by `graphql.operation.type`
2. **Resolver Latency** - P95 of resolver spans
3. **Errors by Operation** - Filter error status spans

---

## 15. Troubleshooting

### 15.1 No Data in SigNoz

1. Check endpoint URL matches your SigNoz deployment
2. Verify ingestion key (Cloud) or network connectivity (self-hosted)
3. Enable debug logging: `OTEL_LOG_LEVEL=debug`
4. Check for 4xx errors in application logs

### 15.2 Missing Traces

1. Ensure `NODE_OPTIONS` includes auto-instrumentation require
2. Check sampling rate isn't too low
3. Verify the application is generating traffic

### 15.3 No Log Correlation

1. Ensure Pino instrumentation is loaded
2. Check logs include `trace_id` field
3. Verify logs are being sent to same SigNoz instance as traces

### 15.4 High Memory Usage

1. Reduce batch size: `OTEL_BSP_MAX_EXPORT_BATCH_SIZE=256`
2. Increase export interval: `OTEL_BSP_SCHEDULE_DELAY=5000`
3. Enable sampling in production

---

## 16. References

- [SigNoz Documentation](https://signoz.io/docs/)
- [SigNoz Node.js Instrumentation](https://signoz.io/docs/instrumentation/javascript/)
- [SigNoz Pino Logs](https://signoz.io/docs/logs-management/send-logs/nodejs-pino-logs/)
- [OpenTelemetry JS SDK](https://github.com/open-telemetry/opentelemetry-js)
- [OpenTelemetry JS Contrib](https://github.com/open-telemetry/opentelemetry-js-contrib)
- [SigNoz GitHub](https://github.com/SigNoz/signoz)
- [SigNoz Community Slack](https://signoz.io/slack)
