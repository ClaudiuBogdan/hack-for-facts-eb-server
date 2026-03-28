import { err, ok } from 'neverthrow';
import { Webhook } from 'svix';

import type { ClerkWebhookVerificationError } from '../../core/errors.js';
import type { ClerkWebhookVerifier, SvixHeaders } from '../../core/ports.js';
import type { Logger } from 'pino';

export interface ClerkWebhookVerifierConfig {
  signingSecret: string;
  logger: Logger;
}

const toVerificationError = (error: unknown): ClerkWebhookVerificationError => {
  if (error instanceof Error) {
    const lowerMessage = error.message.toLowerCase();

    if (
      lowerMessage.includes('expired') ||
      lowerMessage.includes('too old') ||
      lowerMessage.includes('too new')
    ) {
      return {
        type: 'EXPIRED',
        message: error.message,
      };
    }

    if (
      lowerMessage.includes('signature') ||
      lowerMessage.includes('matching signature') ||
      lowerMessage.includes('required headers')
    ) {
      return {
        type: 'INVALID_SIGNATURE',
        message: error.message,
      };
    }

    return {
      type: 'UNKNOWN',
      message: error.message,
    };
  }

  return {
    type: 'UNKNOWN',
    message: 'Unknown verification error',
  };
};

export const makeClerkWebhookVerifier = (
  config: ClerkWebhookVerifierConfig
): ClerkWebhookVerifier => {
  const { signingSecret, logger } = config;
  const log = logger.child({ component: 'ClerkWebhookVerifier' });
  const webhook = new Webhook(signingSecret);

  log.info('Initializing Clerk webhook verifier');

  return {
    verify(rawBody: string, headers: SvixHeaders) {
      const { svixId, svixTimestamp, svixSignature } = headers;

      log.debug({ svixId }, 'Verifying Clerk webhook signature');

      try {
        const payload = webhook.verify(rawBody, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });

        return Promise.resolve(ok(payload));
      } catch (error) {
        const verificationError = toVerificationError(error);
        log.error({ svixId, error: verificationError }, 'Clerk webhook verification failed');
        return Promise.resolve(err(verificationError));
      }
    },
  };
};
