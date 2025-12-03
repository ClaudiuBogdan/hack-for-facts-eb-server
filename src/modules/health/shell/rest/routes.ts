/**
 * Health check routes
 * Provides liveness and readiness endpoints for Kubernetes probes
 */

import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type LivenessResponse,
  type ReadinessResponse,
} from '../../core/types.js';
import { getReadiness, type GetReadinessDeps } from '../../core/usecases/get-readiness.js';

import type { FastifyPluginAsync } from 'fastify';

/**
 * Factory function to create health routes with dependencies
 */
export const makeHealthRoutes = (deps: Partial<GetReadinessDeps> = {}): FastifyPluginAsync => {
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
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const timestamp = new Date().toISOString();

        // Execute use case
        const response = await getReadiness(
          { version, checkers },
          { uptime: uptimeSeconds, timestamp }
        );

        const httpStatus = response.status === 'unhealthy' ? 503 : 200;

        return reply.status(httpStatus).send(response);
      }
    );
  };
};
