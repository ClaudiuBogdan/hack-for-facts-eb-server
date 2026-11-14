import type { FastifyError, FastifyInstance } from 'fastify';

// These REST routes declare a shared error envelope. Fastify's default
// validation and rate-limit errors cannot be serialized against that schema.
export function registerUserRouteErrorHandler(scope: FastifyInstance): void {
  scope.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation !== undefined) {
      return reply.status(400).send({
        ok: false,
        error: 'ValidationError',
        message: 'Request validation failed',
      });
    }
    if (error.statusCode === 429) {
      return reply.status(429).send({
        ok: false,
        error: 'RateLimitExceededError',
        message: 'Too many requests',
      });
    }
    throw error;
  });
}
