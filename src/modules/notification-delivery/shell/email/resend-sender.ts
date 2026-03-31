import { err, ok, type Result } from 'neverthrow';

import { createEmailSendError, type DeliveryError } from '../../core/errors.js';

import type { EmailSenderPort, SendEmailParams, SendEmailResult } from '../../core/ports.js';
import type { EmailSender } from '@/infra/email/client.js';

export interface ResendEmailSenderConfig {
  sender: EmailSender;
}

export const makeResendEmailSender = (config: ResendEmailSenderConfig): EmailSenderPort => {
  const { sender } = config;

  return {
    async send(params: SendEmailParams): Promise<Result<SendEmailResult, DeliveryError>> {
      const result = await sender.send({
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        idempotencyKey: params.idempotencyKey,
        unsubscribeUrl: params.unsubscribeUrl,
        tags: params.tags,
      });

      if (result.isErr()) {
        return err(createEmailSendError(result.error.message, result.error.retryable));
      }

      return ok(result.value);
    },
  };
};
