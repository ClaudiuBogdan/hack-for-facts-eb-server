import { Type, type Static } from '@sinclair/typebox';

/**
 * Individual health check result
 */
export const HealthCheckResultSchema = Type.Object({
  name: Type.String({ description: 'Name of the component being checked' }),
  status: Type.Union([Type.Literal('healthy'), Type.Literal('unhealthy')]),
  message: Type.Optional(Type.String({ description: 'Additional status message' })),
  latencyMs: Type.Optional(Type.Number({ description: 'Check latency in milliseconds' })),
});

export type HealthCheckResult = Static<typeof HealthCheckResultSchema>;

/**
 * Liveness check response - indicates if the process is running
 */
export const LivenessResponseSchema = Type.Object({
  status: Type.Literal('ok'),
});

export type LivenessResponse = Static<typeof LivenessResponseSchema>;

/**
 * Readiness check response - indicates if the service can handle requests
 */
export const ReadinessResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('unhealthy')]),
  timestamp: Type.String({ format: 'date-time' }),
  version: Type.Optional(Type.String()),
  uptime: Type.Number({ description: 'Process uptime in seconds' }),
  checks: Type.Array(HealthCheckResultSchema),
});

export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;

/**
 * Health check function type
 */
export type HealthChecker = () => Promise<HealthCheckResult>;

/**
 * Health check dependencies
 */
export interface HealthDeps {
  version?: string | undefined;
  checkers?: HealthChecker[] | undefined;
}
