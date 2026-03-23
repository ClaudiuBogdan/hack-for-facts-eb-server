import { ok, err, type Result } from 'neverthrow';

import { deserialize } from '@/infra/cache/serialization.js';

import {
  createDatabaseError,
  createDuplicateResendWebhookEventError,
  type ResendWebhookError,
} from '../../core/errors.js';
import { mapResendEmailWebhookEventToInsert, parseTags } from '../../core/mappers.js';

import type {
  InsertResendWebhookEmailEventInput,
  ResendWebhookEmailEventsRepository,
} from '../../core/ports.js';
import type { StoredResendEmailEvent, ResendWebhookTags } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface ResendWebhookEmailEventsRepoConfig {
  db: UserDbClient;
  logger: Logger;
}

const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    return new Date(value);
  }

  if (typeof value === 'object' && value !== null && 'toISOString' in value) {
    return new Date((value as { toISOString: () => string }).toISOString());
  }

  return new Date();
};

const toTags = (value: unknown): ResendWebhookTags | null => {
  if (typeof value === 'string') {
    const parsed = deserialize(value);
    return parsed.ok ? parseTags(parsed.value) : null;
  }

  return parseTags(value);
};

const mapRow = (row: Record<string, unknown>): StoredResendEmailEvent => ({
  id: row['id'] as string,
  svixId: row['svix_id'] as string,
  eventType: row['event_type'] as StoredResendEmailEvent['eventType'],
  webhookReceivedAt: toDate(row['webhook_received_at']),
  eventCreatedAt: toDate(row['event_created_at']),
  emailId: row['email_id'] as string,
  fromAddress: row['from_address'] as string,
  toAddresses: row['to_addresses'] as string[],
  subject: row['subject'] as string,
  emailCreatedAt: toDate(row['email_created_at']),
  broadcastId: (row['broadcast_id'] as string | null) ?? null,
  templateId: (row['template_id'] as string | null) ?? null,
  tags: toTags(row['tags']),
  bounceType: (row['bounce_type'] as string | null) ?? null,
  bounceSubType: (row['bounce_sub_type'] as string | null) ?? null,
  bounceMessage: (row['bounce_message'] as string | null) ?? null,
  bounceDiagnosticCode: (row['bounce_diagnostic_code'] as string[] | null) ?? null,
  clickIpAddress: (row['click_ip_address'] as string | null) ?? null,
  clickLink: (row['click_link'] as string | null) ?? null,
  clickTimestamp: row['click_timestamp'] !== null ? toDate(row['click_timestamp']) : null,
  clickUserAgent: (row['click_user_agent'] as string | null) ?? null,
  threadKey: (row['thread_key'] as string | null) ?? null,
});

export const makeResendWebhookEmailEventsRepo = (
  config: ResendWebhookEmailEventsRepoConfig
): ResendWebhookEmailEventsRepository => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'ResendWebhookEmailEventsRepo' });

  return {
    async insert(
      input: InsertResendWebhookEmailEventInput
    ): Promise<Result<StoredResendEmailEvent, ResendWebhookError>> {
      try {
        const result = await db
          .insertInto('resend_wh_emails')
          .values(mapResendEmailWebhookEventToInsert(input.svixId, input.event))
          .returningAll()
          .executeTakeFirst();

        if (result === undefined) {
          return err(createDatabaseError('Insert returned no result'));
        }

        return ok(mapRow(result as unknown as Record<string, unknown>));
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('unique constraint') ||
            error.message.includes('duplicate key') ||
            error.message.includes('UNIQUE constraint'))
        ) {
          log.debug({ svixId: input.svixId }, 'Duplicate resend webhook event');
          return err(createDuplicateResendWebhookEventError(input.svixId));
        }

        log.error({ error, svixId: input.svixId }, 'Failed to insert resend webhook email event');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findBySvixId(
      svixId: string
    ): Promise<Result<StoredResendEmailEvent | null, ResendWebhookError>> {
      try {
        const result = await db
          .selectFrom('resend_wh_emails')
          .selectAll()
          .where('svix_id', '=', svixId)
          .executeTakeFirst();

        return ok(
          result !== undefined ? mapRow(result as unknown as Record<string, unknown>) : null
        );
      } catch (error) {
        log.error({ error, svixId }, 'Failed to load resend webhook email event');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },
  };
};
