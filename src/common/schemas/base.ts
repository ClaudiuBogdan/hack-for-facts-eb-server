/**
 * Common TypeBox schemas used across modules
 */

import { Type, type Static } from '@sinclair/typebox';

/**
 * UUID string format
 */
export const UUIDSchema = Type.String({
  format: 'uuid',
  description: 'UUID v4 string',
});

/**
 * ISO 8601 date-time string
 */
export const DateTimeSchema = Type.String({
  format: 'date-time',
  description: 'ISO 8601 date-time string',
});

/**
 * Pagination parameters
 */
export const PaginationSchema = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
});

export type Pagination = Static<typeof PaginationSchema>;

/**
 * Standard error response
 */
export const ErrorResponseSchema = Type.Object({
  error: Type.String({ description: 'Error type code' }),
  message: Type.String({ description: 'Human-readable error message' }),
  details: Type.Optional(Type.Unknown({ description: 'Additional error details' })),
});

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

/**
 * Health check response
 */
export const HealthCheckSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('unhealthy')]),
  timestamp: DateTimeSchema,
  version: Type.Optional(Type.String()),
  checks: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        status: Type.Union([Type.Literal('healthy'), Type.Literal('unhealthy')]),
        message: Type.Optional(Type.String()),
        latencyMs: Type.Optional(Type.Number()),
      })
    )
  ),
});

export type HealthCheck = Static<typeof HealthCheckSchema>;
