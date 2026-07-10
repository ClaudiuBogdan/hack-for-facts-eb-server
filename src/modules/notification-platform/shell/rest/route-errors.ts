import type { ErrorResponse } from './schemas.js';
import type { FastifyReply } from 'fastify';

export interface PlatformRouteError {
  type: string;
  message?: string;
  retryable?: boolean;
  entity?: string;
  id?: string;
  reason?: string;
  from?: string;
  to?: string;
}

const statusForError = (error: PlatformRouteError): 400 | 403 | 404 | 409 | 500 => {
  switch (error.type) {
    case 'ValidationError':
      return 400;
    case 'Forbidden':
      return 403;
    case 'NotFound':
      return 404;
    case 'DeliveryConflict':
    case 'DigestConflict':
    case 'EventPayloadConflict':
    case 'InvalidDeliveryTransition':
    case 'SubscriptionConflict':
      return 409;
    default:
      return 500;
  }
};

const messageForError = (error: PlatformRouteError): string => {
  if (error.message !== undefined && error.message !== '') {
    return error.message;
  }
  if (error.type === 'NotFound') {
    return `${error.entity ?? 'Resource'} ${error.id ?? ''} not found`.replace(/\s+/gu, ' ').trim();
  }
  if (error.type === 'Forbidden') {
    return error.reason ?? 'Operation is forbidden';
  }
  if (error.type === 'InvalidDeliveryTransition') {
    return `Cannot transition delivery from ${error.from ?? 'unknown'} to ${error.to ?? 'unknown'}`;
  }
  return 'Notification platform operation failed';
};

export const sendPlatformRouteError = (
  reply: FastifyReply,
  error: PlatformRouteError
): ReturnType<FastifyReply['send']> => {
  const status = statusForError(error);
  if (status >= 500) {
    reply.request.log.error({ err: error }, 'Notification platform route failed');
    const body: ErrorResponse = {
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      retryable: error.retryable === true,
    };
    return reply.status(status).send(body);
  }

  const body: ErrorResponse = {
    ok: false,
    error: error.type,
    message: messageForError(error),
    retryable: error.retryable === true,
  };
  return reply.status(status).send(body);
};

export const sendPlatformNotFound = (
  reply: FastifyReply,
  entity: string,
  id: string
): ReturnType<FastifyReply['send']> =>
  sendPlatformRouteError(reply, { type: 'NotFound', entity, id });
