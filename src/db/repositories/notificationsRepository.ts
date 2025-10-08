import type { PoolClient } from 'pg';
import { runQuery, withTransaction } from '../dataAccess';
import type {
  Notification,
  NotificationConfig,
  NotificationType,
} from '../../services/notifications/types';
import { generateNotificationHash } from '../../services/notifications/types';

export interface CreateNotificationInput {
  userId: string;
  notificationType: NotificationType;
  entityCui?: string | null;
  config?: NotificationConfig | null;
}

export interface UpdateNotificationInput {
  isActive?: boolean;
  config?: NotificationConfig | null;
  hash?: string;
}

interface NotificationRow {
  id: number;
  user_id: string;
  entity_cui: string | null;
  notification_type: string;
  is_active: boolean;
  config: NotificationConfig | null;
  hash: string;
  created_at: Date;
  updated_at: Date;
}

function mapRowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    entityCui: row.entity_cui,
    notificationType: row.notification_type as NotificationType,
    isActive: row.is_active,
    config: row.config,
    hash: row.hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const notificationsRepository = {
  async create(input: CreateNotificationInput, client?: PoolClient): Promise<Notification> {
    const hash = generateNotificationHash(
      input.userId,
      input.notificationType,
      input.entityCui ?? null,
      input.config ?? null
    );

    const result = await runQuery<NotificationRow>(
      'userdata',
      `INSERT INTO Notifications (user_id, notification_type, entity_cui, config, hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.userId, input.notificationType, input.entityCui ?? null, input.config ?? null, hash],
      client
    );

    return mapRowToNotification(result.rows[0]);
  },

  async findByHash(hash: string, client?: PoolClient): Promise<Notification | null> {
    const result = await runQuery<NotificationRow>(
      'userdata',
      `SELECT * FROM Notifications WHERE hash = $1`,
      [hash],
      client
    );

    return result.rows[0] ? mapRowToNotification(result.rows[0]) : null;
  },

  async findById(id: number, client?: PoolClient): Promise<Notification | null> {
    const result = await runQuery<NotificationRow>(
      'userdata',
      `SELECT * FROM Notifications WHERE id = $1`,
      [id],
      client
    );

    return result.rows[0] ? mapRowToNotification(result.rows[0]) : null;
  },

  async findByUserId(userId: string, activeOnly = true): Promise<Notification[]> {
    const query = activeOnly
      ? `SELECT * FROM Notifications WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC`
      : `SELECT * FROM Notifications WHERE user_id = $1 ORDER BY created_at DESC`;

    const result = await runQuery<NotificationRow>('userdata', query, [userId]);

    return result.rows.map(mapRowToNotification);
  },

  async findByEntityCui(entityCui: string, activeOnly = true): Promise<Notification[]> {
    const query = activeOnly
      ? `SELECT * FROM Notifications WHERE entity_cui = $1 AND is_active = TRUE ORDER BY created_at DESC`
      : `SELECT * FROM Notifications WHERE entity_cui = $1 ORDER BY created_at DESC`;

    const result = await runQuery<NotificationRow>('userdata', query, [entityCui]);

    return result.rows.map(mapRowToNotification);
  },

  async findByType(
    notificationType: NotificationType,
    activeOnly = true,
    client?: PoolClient
  ): Promise<Notification[]> {
    const query = activeOnly
      ? `SELECT * FROM Notifications WHERE notification_type = $1 AND is_active = TRUE ORDER BY created_at DESC`
      : `SELECT * FROM Notifications WHERE notification_type = $1 ORDER BY created_at DESC`;

    const result = await runQuery<NotificationRow>('userdata', query, [notificationType], client);

    return result.rows.map(mapRowToNotification);
  },

  async update(
    id: number,
    input: UpdateNotificationInput,
    client?: PoolClient
  ): Promise<Notification> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(input.isActive);
    }

    if (input.config !== undefined) {
      updates.push(`config = $${paramIndex++}`);
      values.push(input.config);
    }

    if (input.hash !== undefined) {
      updates.push(`hash = $${paramIndex++}`);
      values.push(input.hash);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await runQuery<NotificationRow>(
      'userdata',
      `UPDATE Notifications SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
      client
    );

    return mapRowToNotification(result.rows[0]);
  },

  async deactivate(id: number, client?: PoolClient): Promise<Notification> {
    return this.update(id, { isActive: false }, client);
  },

  async findByUserAndEntity(
    userId: string,
    entityCui: string | null,
    activeOnly = true
  ): Promise<Notification[]> {
    const query = activeOnly
      ? `SELECT * FROM Notifications WHERE user_id = $1 AND entity_cui IS NOT DISTINCT FROM $2 AND is_active = TRUE ORDER BY created_at DESC`
      : `SELECT * FROM Notifications WHERE user_id = $1 AND entity_cui IS NOT DISTINCT FROM $2 ORDER BY created_at DESC`;

    const result = await runQuery<NotificationRow>('userdata', query, [userId, entityCui]);

    return result.rows.map(mapRowToNotification);
  },

  async findByUserTypeAndEntity(
    userId: string,
    notificationType: NotificationType,
    entityCui: string | null,
    client?: PoolClient
  ): Promise<Notification | null> {
    const result = await runQuery<NotificationRow>(
      'userdata',
      `SELECT *
       FROM Notifications
       WHERE user_id = $1
         AND notification_type = $2
         AND entity_cui IS NOT DISTINCT FROM $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, notificationType, entityCui],
      client
    );

    return result.rows[0] ? mapRowToNotification(result.rows[0]) : null;
  },

  async getActiveNotificationsByUser(userId: string): Promise<Notification[]> {
    return this.findByUserId(userId, true);
  },

  async deleteCascade(id: number): Promise<Notification | null> {
    return withTransaction('userdata', async (client) => {
      const existingResult = await runQuery<NotificationRow>(
        'userdata',
        `SELECT * FROM Notifications WHERE id = $1`,
        [id],
        client
      );

      if (!existingResult.rows[0]) {
        return null;
      }

      const notification = mapRowToNotification(existingResult.rows[0]);

      await runQuery(
        'userdata',
        `DELETE FROM NotificationDeliveries WHERE notification_id = $1`,
        [id],
        client
      );

      await runQuery(
        'userdata',
        `DELETE FROM UnsubscribeTokens WHERE notification_id = $1`,
        [id],
        client
      );

      await runQuery(
        'userdata',
        `DELETE FROM Notifications WHERE id = $1`,
        [id],
        client
      );

      return notification;
    });
  },
};
