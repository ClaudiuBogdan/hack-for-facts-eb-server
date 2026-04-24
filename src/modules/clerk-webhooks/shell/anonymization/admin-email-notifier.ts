import { randomUUID } from 'node:crypto';

import type {
  UserDataAnonymizationAdminNotification,
  UserDataAnonymizationAdminNotifier,
} from './user-data-anonymizer.js';
import type { EmailSender } from '@/infra/email/client.js';
import type { Logger } from 'pino';

export interface UserDataAnonymizationAdminEmailNotifierDeps {
  emailSender: EmailSender;
  recipientEmail: string;
  unsubscribeUrl: string;
  logger: Logger;
}

const SUBJECT = 'Clerk user deletion anonymization completed';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const formatEventTimestamp = (timestamp: number): string => {
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString();
};

const formatSummaryLines = (summary: UserDataAnonymizationAdminNotification['summary']): string[] =>
  Object.entries(summary)
    .filter(([key]) => key !== 'anonymizedUserId')
    .map(([key, value]) => `- ${key}: ${String(value)}`);

const buildText = (input: UserDataAnonymizationAdminNotification): string => {
  const summaryLines = formatSummaryLines(input.summary);

  return [
    'A Clerk user.deleted anonymization run completed.',
    '',
    `Event type: ${input.eventType}`,
    `Svix ID: ${input.svixId}`,
    `Event timestamp: ${formatEventTimestamp(input.eventTimestamp)}`,
    `Completed at: ${input.completedAt.toISOString()}`,
    `User ID hash: ${input.userIdHash}`,
    `Anonymized user ID: ${input.anonymizedUserId}`,
    '',
    'Mutation summary:',
    ...summaryLines,
    '',
    'The raw Clerk user ID is intentionally not included in this alert.',
  ].join('\n');
};

const buildHtml = (text: string): string =>
  [
    '<!doctype html>',
    '<html>',
    '<body>',
    '<h1>Clerk user deletion anonymization completed</h1>',
    `<pre>${escapeHtml(text)}</pre>`,
    '</body>',
    '</html>',
  ].join('');

export const makeUserDataAnonymizationAdminEmailNotifier = (
  deps: UserDataAnonymizationAdminEmailNotifierDeps
): UserDataAnonymizationAdminNotifier => {
  const log = deps.logger.child({ component: 'UserDataAnonymizationAdminEmailNotifier' });
  const recipientEmail = deps.recipientEmail.trim();
  const unsubscribeUrl = deps.unsubscribeUrl.trim();

  return {
    async notifyCompleted(input) {
      const text = buildText(input);
      const sendResult = await deps.emailSender.send({
        to: recipientEmail,
        subject: SUBJECT,
        html: buildHtml(text),
        text,
        idempotencyKey: randomUUID(),
        unsubscribeUrl,
        tags: [
          { name: 'alert_type', value: 'user_data_anonymization' },
          { name: 'event_type', value: 'user_deleted' },
        ],
      });

      if (sendResult.isErr()) {
        log.warn(
          {
            err: sendResult.error,
            svixId: input.svixId,
            anonymizedUserId: input.anonymizedUserId,
          },
          'Failed to send user data anonymization admin email'
        );
        return;
      }

      log.info(
        {
          emailId: sendResult.value.emailId,
          svixId: input.svixId,
          anonymizedUserId: input.anonymizedUserId,
        },
        'Sent user data anonymization admin email'
      );
    },
  };
};
