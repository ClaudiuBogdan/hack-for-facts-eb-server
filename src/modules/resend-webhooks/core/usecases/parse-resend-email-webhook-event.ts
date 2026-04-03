import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { type InvalidResendWebhookPayloadError } from '../errors.js';
import { ResendEmailWebhookEventSchema, type ResendEmailWebhookEvent } from '../types.js';

const formatValidationErrorPath = (path: string): string => (path.length === 0 ? '/' : path);

export const parseResendEmailWebhookEvent = (
  payload: unknown
): Result<ResendEmailWebhookEvent, InvalidResendWebhookPayloadError> => {
  if (Value.Check(ResendEmailWebhookEventSchema, payload)) {
    return ok(payload);
  }

  const details = [...Value.Errors(ResendEmailWebhookEventSchema, payload)]
    .map((error) => `${formatValidationErrorPath(error.path)}: ${error.message}`)
    .join(', ');

  return err({
    type: 'InvalidResendWebhookPayload',
    message:
      details.length > 0
        ? `Webhook payload failed validation: ${details}`
        : 'Invalid webhook payload',
  });
};
