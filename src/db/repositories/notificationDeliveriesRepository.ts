import type { PoolClient } from 'pg';
import { runQuery } from '../dataAccess';
import type { NotificationDelivery, UUID } from '../../services/notifications/types';

export interface CreateDeliveryInput {
  userId: string;
  notificationId: UUID;
  periodKey: string;
  deliveryKey: string;
  emailBatchId: string;
  metadata?: Record<string, any>;
}

interface DeliveryRow {
  id: number;
  user_id: string;
  notification_id: UUID;
  period_key: string;
  delivery_key: string;
  email_batch_id: string;
  sent_at: Date;
  metadata: Record<string, any>;
  created_at: Date;
}

function mapRowToDelivery(row: DeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    userId: row.user_id,
    notificationId: row.notification_id,
    periodKey: row.period_key,
    deliveryKey: row.delivery_key,
    emailBatchId: row.email_batch_id,
    sentAt: row.sent_at,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export const notificationDeliveriesRepository = {
  async create(input: CreateDeliveryInput, client?: PoolClient): Promise<NotificationDelivery> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `INSERT INTO NotificationDeliveries
       (user_id, notification_id, period_key, delivery_key, email_batch_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.notificationId,
        input.periodKey,
        input.deliveryKey,
        input.emailBatchId,
        input.metadata ?? {},
      ],
      client
    );

    return mapRowToDelivery(result.rows[0]);
  },

  async findByDeliveryKey(deliveryKey: string, client?: PoolClient): Promise<NotificationDelivery | null> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `SELECT * FROM NotificationDeliveries WHERE delivery_key = $1`,
      [deliveryKey],
      client
    );

    return result.rows[0] ? mapRowToDelivery(result.rows[0]) : null;
  },

  async findByEmailBatchId(emailBatchId: string): Promise<NotificationDelivery[]> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `SELECT * FROM NotificationDeliveries WHERE email_batch_id = $1 ORDER BY created_at DESC`,
      [emailBatchId]
    );

    return result.rows.map(mapRowToDelivery);
  },

  async findByUserId(
    userId: string,
    limit?: number,
    offset?: number
  ): Promise<NotificationDelivery[]> {
    const query = limit
      ? `SELECT * FROM NotificationDeliveries WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`
      : `SELECT * FROM NotificationDeliveries WHERE user_id = $1 ORDER BY created_at DESC`;

    const params = limit ? [userId, limit, offset ?? 0] : [userId];

    const result = await runQuery<DeliveryRow>('userdata', query, params);

    return result.rows.map(mapRowToDelivery);
  },

  async findByNotificationId(notificationId: UUID): Promise<NotificationDelivery[]> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `SELECT * FROM NotificationDeliveries WHERE notification_id = $1 ORDER BY created_at DESC`,
      [notificationId]
    );

    return result.rows.map(mapRowToDelivery);
  },

  async findByUserAndPeriod(userId: string, periodKey: string): Promise<NotificationDelivery[]> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `SELECT * FROM NotificationDeliveries WHERE user_id = $1 AND period_key = $2 ORDER BY created_at DESC`,
      [userId, periodKey]
    );

    return result.rows.map(mapRowToDelivery);
  },

  async checkDeliveryExists(deliveryKey: string, client?: PoolClient): Promise<boolean> {
    const result = await runQuery<{ exists: boolean }>(
      'userdata',
      `SELECT EXISTS(SELECT 1 FROM NotificationDeliveries WHERE delivery_key = $1) as exists`,
      [deliveryKey],
      client
    );

    return result.rows[0].exists;
  },

  async getRecentDeliveries(limit = 100): Promise<NotificationDelivery[]> {
    const result = await runQuery<DeliveryRow>(
      'userdata',
      `SELECT * FROM NotificationDeliveries ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map(mapRowToDelivery);
  },
};
