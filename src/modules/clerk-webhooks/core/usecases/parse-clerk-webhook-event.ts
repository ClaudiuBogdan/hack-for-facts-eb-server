import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { ClerkWebhookEventSchema, type ClerkWebhookEvent } from '../types.js';

import type { InvalidClerkWebhookPayloadError } from '../errors.js';

const formatValidationErrorPath = (path: string): string => (path.length === 0 ? '/' : path);

export const parseClerkWebhookEvent = (
  payload: unknown
): Result<ClerkWebhookEvent, InvalidClerkWebhookPayloadError> => {
  if (Value.Check(ClerkWebhookEventSchema, payload)) {
    return ok(payload);
  }

  const details = [...Value.Errors(ClerkWebhookEventSchema, payload)]
    .map((error) => `${formatValidationErrorPath(error.path)}: ${error.message}`)
    .join(', ');

  return err({
    type: 'InvalidClerkWebhookPayload',
    message:
      details.length > 0
        ? `Webhook payload failed validation: ${details}`
        : 'Invalid webhook payload',
  });
};
