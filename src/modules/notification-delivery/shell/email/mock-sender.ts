import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ok, err, type Result } from 'neverthrow';

import { createEmailSendError, type DeliveryError } from '../../core/errors.js';

import type { EmailSenderPort, SendEmailParams, SendEmailResult } from '../../core/ports.js';

export interface MockEmailSenderConfig {
  baseDir?: string;
}

const getTagValue = (tags: SendEmailParams['tags'], name: string): string | undefined => {
  return tags.find((tag) => tag.name === name)?.value;
};

export const getDefaultMockNotificationDir = (): string => {
  return path.join(tmpdir(), 'transparenta-eu-server', 'notifications');
};

export const makeMockEmailSender = (config: MockEmailSenderConfig = {}): EmailSenderPort => {
  const baseDir = config.baseDir ?? getDefaultMockNotificationDir();

  return {
    async send(params: SendEmailParams): Promise<Result<SendEmailResult, DeliveryError>> {
      const outboxId = getTagValue(params.tags, 'delivery_id') ?? params.idempotencyKey;
      const notificationType = getTagValue(params.tags, 'notification_type');
      const referenceId = getTagValue(params.tags, 'notification_id');
      const mockEmailId = `mock-${randomUUID()}`;
      const sentAt = new Date().toISOString();
      const safeId = path.basename(outboxId);
      const emailDir = path.join(baseDir, safeId);

      const metadata = {
        outboxId,
        notificationType: params.notificationType ?? notificationType ?? null,
        referenceId: params.referenceId ?? referenceId ?? null,
        userId: params.userId ?? null,
        to: params.to,
        subject: params.subject,
        templateName: params.templateName ?? getTagValue(params.tags, 'template_name') ?? null,
        templateVersion:
          params.templateVersion ?? getTagValue(params.tags, 'template_version') ?? null,
        mockEmailId,
        sentAt,
        metadata: params.metadata ?? {},
      };

      try {
        await mkdir(emailDir, { recursive: true });
        await writeFile(path.join(emailDir, 'index.html'), params.html, 'utf8');
        await writeFile(
          path.join(emailDir, 'index.json'),
          `${JSON.stringify(metadata, null, 2)}\n`,
          'utf8'
        );

        return ok({ emailId: mockEmailId });
      } catch (error) {
        return err(
          createEmailSendError(
            error instanceof Error ? error.message : 'Failed to write mock email artifacts',
            false
          )
        );
      }
    },
  };
};
