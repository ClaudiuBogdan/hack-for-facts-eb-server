import type { UserDataError } from '../../core/errors.js';
import type { RecordView } from '../../core/types.js';
import type { FastifyReply } from 'fastify';

interface ErrorBody {
  error: string;
  code?: string;
  message: string;
  retryable: boolean;
  violations?: readonly string[];
  current?: RecordView;
  limit?: number;
}

const notFoundBody = (): ErrorBody => ({
  error: 'NotFound',
  message: 'Resource not found',
  retryable: false,
});

export const sendUserDataRouteError = (
  reply: FastifyReply,
  error: UserDataError
): ReturnType<FastifyReply['send']> => {
  switch (error.type) {
    case 'UnknownCategory':
    case 'UnknownSchemaVersion':
    case 'InvalidLogicalKey':
    case 'InvalidTarget':
    case 'InvalidCursor':
      return reply.status(400).send({
        error: error.type,
        message: 'Invalid user-data request',
        retryable: false,
      });
    case 'InvalidPayload':
      return reply.status(400).send({
        error: error.type,
        message: 'Invalid user-data request',
        retryable: false,
        violations: error.violations,
      });
    case 'SchemaVersionWriteDisabled':
      return reply.status(409).send({
        error: error.type,
        code: 'UPGRADE_REQUIRED',
        message: 'This schema version is no longer writable',
        retryable: false,
      });
    case 'RevisionConflict':
      return reply.status(409).send({
        error: error.type,
        message: 'Record revision conflict',
        retryable: false,
        current: error.current,
      });
    case 'IdempotencyConflict':
      return reply.status(409).send({
        error: error.type,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was reused for a different request',
        retryable: false,
      });
    case 'RecordDeleted':
    case 'RecordNotDeleted':
      return reply.status(409).send({
        error: error.type,
        message: 'Record state conflicts with this operation',
        retryable: false,
      });
    case 'NotFound':
    case 'AdminAccessNotConfigured':
      return reply.status(404).send(notFoundBody());
    case 'Forbidden':
    case 'ActorNotAllowed':
    case 'UnknownAnnotationNamespace':
      return reply.status(403).send({
        error: error.type,
        message: 'Operation is forbidden',
        retryable: false,
      });
    case 'PayloadTooLarge':
      return reply.status(413).send({
        error: error.type,
        message: 'Payload exceeds the category limit',
        retryable: false,
        limit: error.limitBytes,
      });
    case 'QuotaExceeded':
      return reply.status(429).send({
        error: error.type,
        code: 'QUOTA_EXCEEDED',
        message: 'Record quota exceeded',
        retryable: false,
        limit: error.limit,
      });
    case 'RateLimited':
      return reply
        .header('Retry-After', String(error.retryAfterSeconds))
        .status(429)
        .send({ error: error.type, message: 'Mutation rate limit exceeded', retryable: true });
    case 'DatabaseError':
      reply.request.log.error({ err: error }, 'User-data route failed');
      return reply.status(500).send({
        error: 'InternalServerError',
        message: 'An unexpected error occurred',
        retryable: error.retryable,
      });
    default: {
      const exhaustive: never = error;
      reply.request.log.error({ err: exhaustive }, 'Unknown user-data route error');
      return reply.status(500).send({
        error: 'InternalServerError',
        message: 'An unexpected error occurred',
        retryable: false,
      });
    }
  }
};
