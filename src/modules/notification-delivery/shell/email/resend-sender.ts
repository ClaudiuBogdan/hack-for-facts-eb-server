import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_WELCOME_TYPE,
} from '@/common/campaign-keys.js';

import { createEmailSendError, type DeliveryError } from '../../core/errors.js';

import type { EmailSenderPort, SendEmailParams, SendEmailResult } from '../../core/ports.js';
import type { EmailSender } from '@/infra/email/client.js';

export interface ResendEmailSenderConfig {
  sender: EmailSender;
  campaignSender?: EmailSender;
}

const isFunkyCampaignNotificationType = (notificationType: string | undefined): boolean => {
  return (
    notificationType === FUNKY_OUTBOX_WELCOME_TYPE ||
    notificationType === FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE ||
    notificationType === FUNKY_OUTBOX_ENTITY_UPDATE_TYPE ||
    notificationType === FUNKY_OUTBOX_ADMIN_FAILURE_TYPE
  );
};

export const makeResendEmailSender = (config: ResendEmailSenderConfig): EmailSenderPort => {
  const { sender, campaignSender } = config;

  return {
    async send(params: SendEmailParams): Promise<Result<SendEmailResult, DeliveryError>> {
      const selectedSender = isFunkyCampaignNotificationType(params.notificationType)
        ? campaignSender
        : sender;

      if (selectedSender === undefined) {
        return err(createEmailSendError('Campaign email sender is not configured', false));
      }

      const result = await selectedSender.send({
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
