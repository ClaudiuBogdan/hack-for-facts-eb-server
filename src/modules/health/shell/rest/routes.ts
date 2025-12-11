/**
 * Health check routes
 * Provides liveness and readiness endpoints for Kubernetes probes
 *
 * Endpoints:
 * - GET /health/live  - Liveness probe (is the process alive?)
 * - GET /health/ready - Readiness probe (is the service ready to accept traffic?)
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
     * GET /health/live - Liveness probe
     *
     * Used by:
     * - Kubernetes livenessProbe (k8s/base/deployment.yaml)
     * - Docker HEALTHCHECK (Dockerfile)
     * - Load balancers
     *
     * Should always return 200 unless the process is completely dead.
     * Does NOT check dependencies - that is the readiness probe's job.
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
     * GET /health/ready - Readiness probe
     *
     * Used by:
     * - Kubernetes readinessProbe (k8s/base/deployment.yaml)
     * - Service mesh traffic routing
     *
     * Checks if all dependencies (database, Redis, etc.) are available.
     * Returns 503 if any critical dependency is unavailable.
     * Kubernetes will stop sending traffic but will NOT restart the pod.
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

        // Execute use case to check all dependencies
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
