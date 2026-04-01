/**
 * Notifications Repository Implementation
 *
 * Kysely-based implementation for the notifications table in UserDatabase.
 */

import { randomUUID } from 'crypto';

import { sql, type Transaction } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import { createDatabaseError, type NotificationError } from '../../core/errors.js';
import {
  generateNotificationHash,
  type Notification,
  type NotificationType,
  type NotificationConfig,
} from '../../core/types.js';
import { sha256Hasher } from '../crypto/hasher.js';

import type {
  NotificationsRepository,
  CreateNotificationInput,
  UpdateNotificationRepoInput,
} from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { UserDatabase } from '@/infra/database/user/types.js';
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
  entity_cui: string | null;
  notification_type: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
  hash: string;
  created_at: unknown;
  updated_at: unknown;
}

/**
 * Options for creating the notifications repository.
 */
export interface NotificationsRepoOptions {
  db: UserDbConnection;
  logger: Logger;
}

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Notifications Repository.
 */
class KyselyNotificationsRepo implements NotificationsRepository {
  private readonly db: UserDbConnection;
  private readonly log: Logger;

  constructor(options: NotificationsRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ repo: 'NotificationsRepo' });
  }

  async create(input: CreateNotificationInput): Promise<Result<Notification, NotificationError>> {
    const { userId, notificationType, entityCui, hash } = input;

    this.log.debug({ userId, notificationType, entityCui, hash }, 'Creating notification');

    try {
      const id = randomUUID();
      const now = new Date();

      const insertValues = {
        id,
        user_id: input.userId,
        entity_cui: input.entityCui,
        notification_type: input.notificationType,
        is_active: true,
        config: input.config !== null ? sql`${JSON.stringify(input.config)}::jsonb` : null,
        hash: input.hash,
        created_at: now,
        updated_at: now,
      };

      const row = await this.db
        .insertInto('notifications')
        .values(insertValues as never)
        .returning([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow();

      this.log.debug({ notificationId: id }, 'Notification created successfully');
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error(
        { err: error, userId, notificationType, entityCui },
        'Failed to create notification'
      );
      return err(createDatabaseError('Failed to create notification', error));
    }
  }

  async findById(id: string): Promise<Result<Notification | null, NotificationError>> {
    this.log.debug({ notificationId: id }, 'Finding notification by ID');

    try {
      const row = await this.db
        .selectFrom('notifications')
        .select([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .where('id', '=', id)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug({ notificationId: id }, 'Notification not found');
        return ok(null);
      }

      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, notificationId: id }, 'Failed to find notification by ID');
      return err(createDatabaseError('Failed to find notification by ID', error));
    }
  }

  async findByHash(hash: string): Promise<Result<Notification | null, NotificationError>> {
    this.log.debug({ hash }, 'Finding notification by hash');

    try {
      const row = await this.db
        .selectFrom('notifications')
        .select([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .where('hash', '=', hash)
        .executeTakeFirst();

      if (row === undefined) {
        this.log.debug({ hash }, 'Notification not found by hash');
        return ok(null);
      }

      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, hash }, 'Failed to find notification by hash');
      return err(createDatabaseError('Failed to find notification by hash', error));
    }
  }

  async findByUserId(
    userId: string,
    activeOnly: boolean
  ): Promise<Result<Notification[], NotificationError>> {
    this.log.debug({ userId, activeOnly }, 'Finding notifications by user ID');

    try {
      let query = this.db
        .selectFrom('notifications')
        .select([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .where('user_id', '=', userId);

      if (activeOnly) {
        query = query.where('is_active', '=', true);
      }

      query = query.orderBy('created_at', 'desc');

      const rows = await query.execute();

      this.log.debug({ userId, count: rows.length }, 'Found notifications for user');
      return ok(rows.map((row) => this.mapRowToNotification(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error({ err: error, userId, activeOnly }, 'Failed to find notifications by user ID');
      return err(createDatabaseError('Failed to find notifications by user ID', error));
    }
  }

  async findByUserAndEntity(
    userId: string,
    entityCui: string | null,
    activeOnly: boolean
  ): Promise<Result<Notification[], NotificationError>> {
    this.log.debug({ userId, entityCui, activeOnly }, 'Finding notifications by user and entity');

    try {
      let query = this.db
        .selectFrom('notifications')
        .select([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .where('user_id', '=', userId);

      // Null-safe comparison for entityCui
      if (entityCui === null) {
        query = query.where('entity_cui', 'is', null);
      } else {
        query = query.where('entity_cui', '=', entityCui);
      }

      if (activeOnly) {
        query = query.where('is_active', '=', true);
      }

      query = query.orderBy('created_at', 'desc');

      const rows = await query.execute();

      this.log.debug(
        { userId, entityCui, count: rows.length },
        'Found notifications for user and entity'
      );
      return ok(rows.map((row) => this.mapRowToNotification(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error(
        { err: error, userId, entityCui, activeOnly },
        'Failed to find notifications by user and entity'
      );
      return err(createDatabaseError('Failed to find notifications by user and entity', error));
    }
  }

  async findByUserTypeAndEntity(
    userId: string,
    notificationType: NotificationType,
    entityCui: string | null
  ): Promise<Result<Notification | null, NotificationError>> {
    this.log.debug(
      { userId, notificationType, entityCui },
      'Finding notification by user, type, and entity'
    );

    try {
      let query = this.db
        .selectFrom('notifications')
        .select([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .where('user_id', '=', userId)
        .where('notification_type', '=', notificationType);

      // Null-safe comparison for entityCui
      if (entityCui === null) {
        query = query.where('entity_cui', 'is', null);
      } else {
        query = query.where('entity_cui', '=', entityCui);
      }

      const row = await query.executeTakeFirst();

      if (row === undefined) {
        this.log.debug(
          { userId, notificationType, entityCui },
          'Notification not found for user, type, and entity'
        );
        return ok(null);
      }

      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error(
        { err: error, userId, notificationType, entityCui },
        'Failed to find notification by user, type, and entity'
      );
      return err(
        createDatabaseError('Failed to find notification by user, type, and entity', error)
      );
    }
  }

  async update(
    id: string,
    input: UpdateNotificationRepoInput
  ): Promise<Result<Notification, NotificationError>> {
    this.log.debug({ notificationId: id, input }, 'Updating notification');

    try {
      const updateValues: Record<string, unknown> = {
        updated_at: new Date(),
      };

      if (input.isActive !== undefined) {
        updateValues['is_active'] = input.isActive;
      }

      if (input.config !== undefined) {
        updateValues['config'] =
          input.config !== null ? sql`${JSON.stringify(input.config)}::jsonb` : null;
      }

      if (input.hash !== undefined) {
        updateValues['hash'] = input.hash;
      }

      const row = await this.db
        .updateTable('notifications')
        .set(updateValues)
        .where('id', '=', id)
        .returning([
          'id',
          'user_id',
          'entity_cui',
          'notification_type',
          'is_active',
          'config',
          'hash',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow();

      this.log.debug({ notificationId: id }, 'Notification updated successfully');
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, notificationId: id }, 'Failed to update notification');
      return err(createDatabaseError('Failed to update notification', error));
    }
  }

  async deleteCascade(id: string): Promise<Result<Notification | null, NotificationError>> {
    this.log.debug({ notificationId: id }, 'Deleting notification with cascade');

    try {
      // First, get the notification for return value
      const findResult = await this.findById(id);
      if (findResult.isErr()) {
        return err(findResult.error);
      }

      const notification = findResult.value;
      if (notification === null) {
        this.log.debug({ notificationId: id }, 'Notification not found for deletion');
        return ok(null);
      }

      // SECURITY: SEC-019 - Atomic cascade deletion to prevent data inconsistency
      await this.db.transaction().execute(async (trx) => {
        await trx.deleteFrom('notificationsoutbox').where('reference_id', '=', id).execute();
        await trx.deleteFrom('notifications').where('id', '=', id).execute();
      });

      this.log.debug({ notificationId: id }, 'Notification deleted successfully with cascade');
      return ok(notification);
    } catch (error) {
      this.log.error({ err: error, notificationId: id }, 'Failed to delete notification');
      return err(createDatabaseError('Failed to delete notification', error));
    }
  }

  async deactivateGlobalUnsubscribe(userId: string): Promise<Result<void, NotificationError>> {
    this.log.debug({ userId }, 'Deactivating global unsubscribe');

    try {
      const config = { channels: { email: false } } as const;
      const hash = generateNotificationHash(
        sha256Hasher,
        userId,
        'global_unsubscribe',
        null,
        config
      );

      await sql`
        INSERT INTO notifications (
          id,
          user_id,
          entity_cui,
          notification_type,
          is_active,
          config,
          hash,
          created_at,
          updated_at
        )
        VALUES (
          ${randomUUID()},
          ${userId},
          NULL,
          'global_unsubscribe',
          FALSE,
          ${JSON.stringify(config)}::jsonb,
          ${hash},
          NOW(),
          NOW()
        )
        ON CONFLICT (user_id, notification_type)
        WHERE notification_type = 'global_unsubscribe'
        DO UPDATE
        SET is_active = FALSE,
            config = EXCLUDED.config,
            hash = EXCLUDED.hash,
            updated_at = NOW()
      `.execute(this.db);

      this.log.info({ userId }, 'Global unsubscribe deactivated');
      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to deactivate global unsubscribe');
      return err(createDatabaseError('Failed to deactivate global unsubscribe', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps a database row to Notification domain type.
   */
  private mapRowToNotification(row: QueryRow): Notification {
    return {
      id: row.id,
      userId: row.user_id,
      entityCui: row.entity_cui,
      notificationType: row.notification_type as NotificationType,
      isActive: row.is_active,
      config: row.config as NotificationConfig,
      hash: row.hash,
      createdAt: parseDbTimestamp(row.created_at, 'created_at'),
      updatedAt: parseDbTimestamp(row.updated_at, 'updated_at'),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a NotificationsRepository instance.
 */
export const makeNotificationsRepo = (
  options: NotificationsRepoOptions
): NotificationsRepository => {
  return new KyselyNotificationsRepo(options);
};
