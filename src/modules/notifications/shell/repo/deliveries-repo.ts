/**
 * Deliveries Repository Implementation
 *
 * Kysely-based implementation for the notification deliveries table.
 */

import { ok, err, type Result } from 'neverthrow';

import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import { createDatabaseError, type NotificationError } from '../../core/errors.js';
import {
  ALERT_TYPES,
  NEWSLETTER_TYPES,
  type NotificationDeliveryHistory,
} from '../../core/types.js';

import type { DeliveriesRepository } from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Row type from database query.
 */
interface QueryRow {
  id: string;
  user_id: string;
  notification_type: string;
  reference_id: string | null;
  scope_key: string;
  delivery_key: string;
  status: string;
  rendered_subject: string | null;
  rendered_html: string | null;
  rendered_text: string | null;
  content_hash: string | null;
  template_name: string | null;
  template_version: string | null;
  to_email: string | null;
  resend_email_id: string | null;
  last_error: string | null;
  attempt_count: number;
  last_attempt_at: unknown;
  sent_at: unknown;
  metadata: Record<string, unknown> | null;
  created_at: unknown;
}

/**
 * Options for creating the deliveries repository.
 */
export interface DeliveriesRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Deliveries Repository.
 */
class KyselyDeliveriesRepo implements DeliveriesRepository {
  private readonly db: UserDbClient;
  private readonly log: Logger;

  constructor(options: DeliveriesRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ repo: 'DeliveriesRepo' });
  }

  async findByUserId(
    userId: string,
    limit: number,
    offset: number
  ): Promise<Result<NotificationDeliveryHistory[], NotificationError>> {
    this.log.debug({ userId, limit, offset }, 'Finding deliveries by user ID');

    try {
      // Keep the full delivery record in the domain model.
      // The REST serializer decides which fields are safe to expose.
      const rows = await this.db
        .selectFrom('notificationoutbox')
        .select([
          'id',
          'user_id',
          'notification_type',
          'reference_id',
          'scope_key',
          'delivery_key',
          'status',
          'rendered_subject',
          'rendered_html',
          'rendered_text',
          'content_hash',
          'template_name',
          'template_version',
          'to_email',
          'resend_email_id',
          'last_error',
          'attempt_count',
          'last_attempt_at',
          'sent_at',
          'metadata',
          'created_at',
        ])
        .where('user_id', '=', userId)
        .where('notification_type', 'in', [...NEWSLETTER_TYPES, ...ALERT_TYPES])
        .where('sent_at', 'is not', null)
        .orderBy('sent_at', 'desc')
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();

      this.log.debug({ userId, count: rows.length }, 'Found deliveries for user');
      return ok(rows.map((row) => this.mapRowToDelivery(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to find deliveries by user ID');
      return err(createDatabaseError('Failed to find deliveries by user ID', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps a database row to NotificationDelivery domain type.
   */
  private mapRowToDelivery(row: QueryRow): NotificationDeliveryHistory {
    return {
      id: row.id,
      userId: row.user_id,
      notificationId: row.reference_id ?? null,
      scopeKey: row.scope_key,
      deliveryKey: row.delivery_key,
      status: row.status as NotificationDeliveryHistory['status'],
      renderedSubject: row.rendered_subject,
      renderedHtml: row.rendered_html,
      renderedText: row.rendered_text,
      contentHash: row.content_hash,
      templateName: row.template_name,
      templateVersion: row.template_version,
      toEmail: row.to_email ?? null,
      resendEmailId: row.resend_email_id,
      lastError: row.last_error,
      attemptCount: row.attempt_count,
      lastAttemptAt:
        row.last_attempt_at !== null
          ? parseDbTimestamp(row.last_attempt_at, 'last_attempt_at')
          : null,
      sentAt: parseDbTimestamp(row.sent_at, 'sent_at'),
      metadata: row.metadata ?? {},
      createdAt: parseDbTimestamp(row.created_at, 'created_at'),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a DeliveriesRepository instance.
 */
export const makeDeliveriesRepo = (options: DeliveriesRepoOptions): DeliveriesRepository => {
  return new KyselyDeliveriesRepo(options);
};
