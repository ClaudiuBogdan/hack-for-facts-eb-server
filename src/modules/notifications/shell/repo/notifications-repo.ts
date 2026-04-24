/**
 * Notifications Repository Implementation
 *
 * Kysely-based implementation for the notifications table in UserDatabase.
 */

import { randomUUID } from 'crypto';

import { sql, type Transaction } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
} from '@/common/campaign-keys.js';
import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import { createDatabaseError, type NotificationError } from '../../core/errors.js';
import {
  generateNotificationHash,
  type Notification,
  type NotificationType,
  type NotificationConfig,
  NOTIFICATION_TYPE_CONFIGS,
} from '../../core/types.js';
import { sha256Hasher } from '../crypto/hasher.js';

import type {
  NotificationsRepository,
  CreateNotificationInput,
  UpdateCampaignGlobalPreferenceRepoInput,
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
  campaignSubscriptionStatsInvalidator?: CampaignSubscriptionStatsInvalidator;
}

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

export interface CampaignSubscriptionStatsInvalidator {
  invalidateCampaign(campaignId: string): Promise<void>;
  invalidateAll(): Promise<void>;
}

const buildUpdateValues = (
  input: UpdateNotificationRepoInput,
  updatedAt: Date
): Record<string, unknown> => {
  const updateValues: Record<string, unknown> = {
    updated_at: updatedAt,
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

  return updateValues;
};

const GLOBAL_UNSUBSCRIBE_TYPE = 'global_unsubscribe' as const satisfies NotificationType;
const PUBLIC_DEBATE_CHILD_NOTIFICATION_TYPES = [
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
] as const satisfies readonly NotificationType[];

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Notifications Repository.
 */
class KyselyNotificationsRepo implements NotificationsRepository {
  private readonly db: UserDbConnection;
  private readonly log: Logger;
  private readonly campaignSubscriptionStatsInvalidator:
    | CampaignSubscriptionStatsInvalidator
    | undefined;

  constructor(options: NotificationsRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ repo: 'NotificationsRepo' });
    this.campaignSubscriptionStatsInvalidator = options.campaignSubscriptionStatsInvalidator;
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

      await this.invalidateCampaignSubscriptionStatsCache(notificationType);
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

  async createWithManualOptIn(
    input: CreateNotificationInput
  ): Promise<Result<Notification, NotificationError>> {
    const { userId, notificationType, entityCui, hash } = input;

    this.log.debug(
      { userId, notificationType, entityCui, hash },
      'Creating notification with manual opt-in'
    );

    try {
      const id = randomUUID();
      const now = new Date();

      const row = await this.db.transaction().execute(async (trx) => {
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

        const inserted = await trx
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

        await this.applyManualNotificationOptInInTransaction(
          trx,
          input.userId,
          input.notificationType,
          now
        );

        return inserted;
      });

      await this.invalidateCampaignSubscriptionStatsCache(notificationType);
      await this.invalidateCampaignSubscriptionStatsCache(GLOBAL_UNSUBSCRIBE_TYPE);
      this.log.debug({ notificationId: id }, 'Notification created with manual opt-in');
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error(
        { err: error, userId, notificationType, entityCui },
        'Failed to create notification with manual opt-in'
      );
      return err(createDatabaseError('Failed to create notification with manual opt-in', error));
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
      const updateValues = buildUpdateValues(input, new Date());

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

      await this.invalidateCampaignSubscriptionStatsCache(
        row.notification_type as NotificationType
      );
      this.log.debug({ notificationId: id }, 'Notification updated successfully');
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, notificationId: id }, 'Failed to update notification');
      return err(createDatabaseError('Failed to update notification', error));
    }
  }

  async updateWithManualOptIn(
    id: string,
    input: UpdateNotificationRepoInput
  ): Promise<Result<Notification, NotificationError>> {
    this.log.debug({ notificationId: id, input }, 'Updating notification with manual opt-in');

    try {
      const updatedAt = new Date();
      const row = await this.db.transaction().execute(async (trx) => {
        const updateValues = buildUpdateValues(input, updatedAt);

        const updated = await trx
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

        await this.applyManualNotificationOptInInTransaction(
          trx,
          updated.user_id,
          updated.notification_type as NotificationType,
          updatedAt
        );

        return updated;
      });

      await this.invalidateCampaignSubscriptionStatsCache(
        row.notification_type as NotificationType
      );
      await this.invalidateCampaignSubscriptionStatsCache(GLOBAL_UNSUBSCRIBE_TYPE);
      this.log.debug({ notificationId: id }, 'Notification updated with manual opt-in');
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, notificationId: id }, 'Failed to update notification');
      return err(createDatabaseError('Failed to update notification with manual opt-in', error));
    }
  }

  async updateCampaignGlobalPreference(
    id: string,
    input: UpdateCampaignGlobalPreferenceRepoInput
  ): Promise<Result<Notification, NotificationError>> {
    this.log.debug({ notificationId: id, input }, 'Updating campaign global preference');

    try {
      const updatedAt = new Date();
      const row = await this.db.transaction().execute(async (trx) => {
        const updateValues = buildUpdateValues(input, updatedAt);

        const updatedGlobal = await trx
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

        if (!input.isActive) {
          await trx
            .updateTable('notifications')
            .set({
              is_active: false,
              updated_at: updatedAt,
            } as never)
            .where('user_id', '=', updatedGlobal.user_id)
            .where('id', '!=', updatedGlobal.id)
            .where('notification_type', 'in', PUBLIC_DEBATE_CHILD_NOTIFICATION_TYPES)
            .where('is_active', '=', true)
            .execute();
        }

        return updatedGlobal;
      });

      await this.invalidateCampaignSubscriptionStatsCache(
        row.notification_type as NotificationType
      );
      this.log.debug(
        { notificationId: id, isActive: input.isActive },
        'Campaign global preference updated successfully'
      );
      return ok(this.mapRowToNotification(row as unknown as QueryRow));
    } catch (error) {
      this.log.error(
        { err: error, notificationId: id },
        'Failed to update campaign global preference'
      );
      return err(createDatabaseError('Failed to update campaign global preference', error));
    }
  }

  async applyManualNotificationOptIn(input: {
    userId: string;
    notificationType: NotificationType;
  }): Promise<Result<void, NotificationError>> {
    this.log.debug(input, 'Applying manual notification opt-in');

    try {
      const updatedAt = new Date();
      await this.db.transaction().execute(async (trx) => {
        await this.applyManualNotificationOptInInTransaction(
          trx,
          input.userId,
          input.notificationType,
          updatedAt
        );
      });

      await this.invalidateCampaignSubscriptionStatsCache(input.notificationType);
      await this.invalidateCampaignSubscriptionStatsCache(GLOBAL_UNSUBSCRIBE_TYPE);
      this.log.debug(input, 'Manual notification opt-in applied');
      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, ...input }, 'Failed to apply manual notification opt-in');
      return err(createDatabaseError('Failed to apply manual notification opt-in', error));
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

      await this.invalidateCampaignSubscriptionStatsCache(notification.notificationType);
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
      const updatedAt = new Date();
      const config = { channels: { email: false } } as const;
      const hash = generateNotificationHash(
        sha256Hasher,
        userId,
        GLOBAL_UNSUBSCRIBE_TYPE,
        null,
        config
      );

      await this.db.transaction().execute(async (trx) => {
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
            ${updatedAt},
            ${updatedAt}
          )
          ON CONFLICT (user_id, notification_type)
          WHERE notification_type = 'global_unsubscribe'
          DO UPDATE
          SET is_active = FALSE,
              config = EXCLUDED.config,
              hash = EXCLUDED.hash,
              updated_at = EXCLUDED.updated_at
        `.execute(trx);

        await trx
          .updateTable('notifications')
          .set({
            is_active: false,
            updated_at: updatedAt,
          } as never)
          .where('user_id', '=', userId)
          .where('notification_type', '!=', GLOBAL_UNSUBSCRIBE_TYPE)
          .where('is_active', '=', true)
          .execute();
      });

      await this.invalidateCampaignSubscriptionStatsCache(GLOBAL_UNSUBSCRIBE_TYPE);
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

  private async applyManualNotificationOptInInTransaction(
    trx: Transaction<UserDatabase>,
    userId: string,
    notificationType: NotificationType,
    updatedAt: Date
  ): Promise<void> {
    const enabledGlobalConfig = { channels: { email: true } } as const;
    const enabledGlobalHash = generateNotificationHash(
      sha256Hasher,
      userId,
      GLOBAL_UNSUBSCRIBE_TYPE,
      null,
      enabledGlobalConfig
    );

    await trx
      .updateTable('notifications')
      .set({
        is_active: true,
        config: sql`${JSON.stringify(enabledGlobalConfig)}::jsonb`,
        hash: enabledGlobalHash,
        updated_at: updatedAt,
      } as never)
      .where('user_id', '=', userId)
      .where('notification_type', '=', GLOBAL_UNSUBSCRIBE_TYPE)
      .execute();

    const isPublicDebateChildNotification = PUBLIC_DEBATE_CHILD_NOTIFICATION_TYPES.some(
      (childNotificationType) => childNotificationType === notificationType
    );

    if (!isPublicDebateChildNotification) {
      return;
    }

    const campaignGlobalHash = generateNotificationHash(
      sha256Hasher,
      userId,
      FUNKY_NOTIFICATION_GLOBAL_TYPE,
      null,
      null
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
        'funky:notification:global',
        TRUE,
        NULL,
        ${campaignGlobalHash},
        ${updatedAt},
        ${updatedAt}
      )
      ON CONFLICT (user_id, notification_type)
      WHERE notification_type = 'funky:notification:global'
      DO UPDATE
      SET is_active = TRUE,
          updated_at = EXCLUDED.updated_at
    `.execute(trx);
  }

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

  private async invalidateCampaignSubscriptionStatsCache(
    notificationType: NotificationType
  ): Promise<void> {
    const invalidator = this.campaignSubscriptionStatsInvalidator;
    if (invalidator === undefined) {
      return;
    }

    try {
      if (notificationType === 'global_unsubscribe') {
        await invalidator.invalidateAll();
        this.log.debug(
          { notificationType },
          'Invalidated all campaign subscription stats cache entries'
        );
        return;
      }

      const campaignKey = NOTIFICATION_TYPE_CONFIGS[notificationType].campaignKey;
      if (campaignKey === undefined) {
        return;
      }

      await invalidator.invalidateCampaign(campaignKey);
      this.log.debug(
        { notificationType, campaignKey },
        'Invalidated campaign subscription stats cache entry'
      );
    } catch (error) {
      this.log.warn(
        { err: error, notificationType },
        'Failed to invalidate campaign subscription stats cache'
      );
    }
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
