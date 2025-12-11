/**
 * Deliveries Repository Implementation
 *
 * Kysely-based implementation for the notification deliveries table.
 */

import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type NotificationError } from '../../core/errors.js';

import type { DeliveriesRepository } from '../../core/ports.js';
import type { NotificationDelivery } from '../../core/types.js';
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
  notification_id: string;
  period_key: string;
  delivery_key: string;
  email_batch_id: string;
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
  ): Promise<Result<NotificationDelivery[], NotificationError>> {
    this.log.debug({ userId, limit, offset }, 'Finding deliveries by user ID');

    try {
      const rows = await this.db
        .selectFrom('notificationdeliveries')
        .select([
          'id',
          'user_id',
          'notification_id',
          'period_key',
          'delivery_key',
          'email_batch_id',
          'sent_at',
          'metadata',
          'created_at',
        ])
        .where('user_id', '=', userId)
        .orderBy('sent_at', 'desc')
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
  private mapRowToDelivery(row: QueryRow): NotificationDelivery {
    return {
      id: row.id,
      userId: row.user_id,
      notificationId: row.notification_id,
      periodKey: row.period_key,
      deliveryKey: row.delivery_key,
      emailBatchId: row.email_batch_id,
      sentAt: this.toDate(row.sent_at),
      metadata: row.metadata ?? {},
      createdAt: this.toDate(row.created_at),
    };
  }

  /**
   * Converts Kysely timestamp to Date.
   */
  private toDate(value: unknown): Date {
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
