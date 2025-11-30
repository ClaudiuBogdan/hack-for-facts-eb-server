/**
 * Health check routes
 * Provides liveness and readiness endpoints for Kubernetes probes
 */

import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type HealthDeps,
  type HealthCheckResult,
  type LivenessResponse,
  type ReadinessResponse,
} from './types.js';

import type { FastifyPluginAsync } from 'fastify';

/**
 * Factory function to create health routes with dependencies
 */
export const makeHealthRoutes = (deps: HealthDeps = {}): FastifyPluginAsync => {
  const { version, checkers = [] } = deps;
  const startTime = Date.now();

  return async (fastify) => {
    /**
     * Liveness probe - just checks if the process is running
     * Should always return 200 unless the process is completely dead
     */
    fastify.get<{ Reply: LivenessResponse }>(
      '/health/live',
      {
        schema: {
          response: {
            200: LivenessResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        return reply.status(200).send({ status: 'ok' });
      }
    );

    /**
     * Readiness probe - checks if dependencies are available
     * Returns 503 if any critical dependency is unavailable
     */
    fastify.get<{ Reply: ReadinessResponse }>(
      '/health/ready',
      {
        schema: {
          response: {
            200: ReadinessResponseSchema,
            503: ReadinessResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        const checks: HealthCheckResult[] = [];

        // Run all health checkers in parallel
        if (checkers.length > 0) {
          const results = await Promise.allSettled(checkers.map((checker) => checker()));

          for (const result of results) {
            if (result.status === 'fulfilled') {
              checks.push(result.value);
            } else {
              checks.push({
                name: 'unknown',
                status: 'unhealthy',
                message: result.reason instanceof Error ? result.reason.message : 'Check failed',
              });
            }
          }
        }

        // Determine overall status
        const hasUnhealthy = checks.some((c) => c.status === 'unhealthy');
        const status = hasUnhealthy ? 'unhealthy' : 'ok';
        const httpStatus = hasUnhealthy ? 503 : 200;

        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

        // Build response, only including version if defined
        const response: ReadinessResponse = {
          status,
          timestamp: new Date().toISOString(),
          uptime: uptimeSeconds,
          checks,
          ...(version !== undefined && { version }),
        };

        return reply.status(httpStatus).send(response);
      }
    );
  };
};
