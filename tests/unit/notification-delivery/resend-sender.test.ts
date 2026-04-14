import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_WELCOME_TYPE,
} from '@/common/campaign-keys.js';
import { makeResendEmailSender } from '@/modules/notification-delivery/index.js';

import type { EmailSender } from '@/infra/email/client.js';

const CAMPAIGN_NOTIFICATION_TYPES = [
  FUNKY_OUTBOX_WELCOME_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
] as const;

const createEmailSenderMock = () => {
  const send = vi.fn(async () => ok({ emailId: 'email-1' }));

  const sender: EmailSender = {
    getFromAddress: () => 'noreply@example.com',
    send,
  };

  return { sender, send };
};

describe('makeResendEmailSender', () => {
  it('uses the default sender for non-campaign emails', async () => {
    const defaultSender = createEmailSenderMock();
    const campaignSender = createEmailSenderMock();
    const emailSender = makeResendEmailSender({
      sender: defaultSender.sender,
      campaignSender: campaignSender.sender,
    });

    const result = await emailSender.send({
      to: 'user@example.com',
      notificationType: 'transactional_welcome',
      subject: 'Welcome',
      html: '<p>Hello</p>',
      text: 'Hello',
      idempotencyKey: 'outbox-1',
      unsubscribeUrl: 'https://example.com/unsub',
      tags: [],
    });

    expect(result.isOk()).toBe(true);
    expect(defaultSender.send).toHaveBeenCalledTimes(1);
    expect(campaignSender.send).not.toHaveBeenCalled();
  });

  it.each(CAMPAIGN_NOTIFICATION_TYPES)(
    'uses the campaign sender for %s',
    async (notificationType) => {
      const defaultSender = createEmailSenderMock();
      const campaignSender = createEmailSenderMock();
      const emailSender = makeResendEmailSender({
        sender: defaultSender.sender,
        campaignSender: campaignSender.sender,
      });

      const result = await emailSender.send({
        to: 'user@example.com',
        notificationType,
        subject: 'Campaign email',
        html: '<p>Hello</p>',
        text: 'Hello',
        idempotencyKey: `outbox-${notificationType}`,
        unsubscribeUrl: 'https://example.com/unsub',
        tags: [],
      });

      expect(result.isOk()).toBe(true);
      expect(defaultSender.send).not.toHaveBeenCalled();
      expect(campaignSender.send).toHaveBeenCalledTimes(1);
    }
  );

  it('fails closed when a campaign email is sent without a campaign sender', async () => {
    const defaultSender = createEmailSenderMock();
    const emailSender = makeResendEmailSender({
      sender: defaultSender.sender,
    });

    const result = await emailSender.send({
      to: 'user@example.com',
      notificationType: FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
      subject: 'Campaign subscription',
      html: '<p>Hello</p>',
      text: 'Hello',
      idempotencyKey: 'outbox-3',
      unsubscribeUrl: 'https://example.com/unsub',
      tags: [],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('EmailSendError');
      if (result.error.type === 'EmailSendError') {
        expect(result.error.message).toBe('Campaign email sender is not configured');
      }
    }
    expect(defaultSender.send).not.toHaveBeenCalled();
  });
});
