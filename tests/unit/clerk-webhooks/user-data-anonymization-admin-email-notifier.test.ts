import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { makeUserDataAnonymizationAdminEmailNotifier } from '@/modules/clerk-webhooks/shell/anonymization/admin-email-notifier.js';

import type { EmailSender } from '@/infra/email/client.js';
import type { UserDataAnonymizationAdminNotification } from '@/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js';

const logger = pinoLogger({ level: 'silent' });

const notification: UserDataAnonymizationAdminNotification = {
  userIdHash: 'hash-only',
  anonymizedUserId: 'deleted-user:hash-only',
  svixId: 'msg_123',
  eventType: 'user.deleted',
  eventTimestamp: 1_654_012_591_835,
  completedAt: new Date('2026-04-24T12:00:00.000Z'),
  summary: {
    anonymizedUserId: 'deleted-user:hash-only',
    shortLinksDeleted: 1,
    shortLinksUpdated: 2,
    notificationsUpdated: 3,
    outboxRowsUpdated: 4,
    userInteractionsUpdated: 5,
    userInteractionConflictsDeleted: 0,
    campaignRunPlansDeleted: 6,
    institutionThreadsUpdated: 7,
    resendWebhookEventsUpdated: 8,
    advancedMapRowsUpdated: 9,
    advancedMapSnapshotsUpdated: 10,
    advancedDatasetRowsUpdated: 11,
    advancedDatasetValueRowsDeleted: 12,
  },
};

const makeSender = (send: EmailSender['send']): EmailSender => ({
  getFromAddress: () => 'admin@example.test',
  send,
});

describe('makeUserDataAnonymizationAdminEmailNotifier', () => {
  it('sends a non-PII admin email to the configured sender recipient', async () => {
    const send = vi.fn<EmailSender['send']>(async () => ok({ emailId: 'email_123' }));
    const notifier = makeUserDataAnonymizationAdminEmailNotifier({
      emailSender: makeSender(send),
      recipientEmail: ' admin@example.test ',
      unsubscribeUrl: 'https://api.example.test',
      logger,
    });

    await notifier.notifyCompleted(notification);

    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0]?.[0];
    expect(params).toBeDefined();
    if (params === undefined) {
      return;
    }
    expect(params.to).toBe('admin@example.test');
    expect(params.subject).toBe('Clerk user deletion anonymization completed');
    expect(params.unsubscribeUrl).toBe('https://api.example.test');
    expect(params.tags).toEqual([
      { name: 'alert_type', value: 'user_data_anonymization' },
      { name: 'event_type', value: 'user_deleted' },
    ]);
    expect(params.text).toContain('User ID hash: hash-only');
    expect(params.text).toContain('Anonymized user ID: deleted-user:hash-only');
    expect(params.text).not.toContain('user_123');
    expect(params.html).not.toContain('user_123');
  });

  it('does not throw when the email sender fails', async () => {
    const send = vi.fn<EmailSender['send']>(async () =>
      err({
        type: 'SERVER' as const,
        message: 'Resend unavailable',
        retryable: true,
      })
    );
    const notifier = makeUserDataAnonymizationAdminEmailNotifier({
      emailSender: makeSender(send),
      recipientEmail: 'admin@example.test',
      unsubscribeUrl: 'https://api.example.test',
      logger,
    });

    await expect(notifier.notifyCompleted(notification)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
