/**
 * Extended Notifications Repository Adapter
 *
 * Wraps the notifications table with delivery-pipeline-specific methods.
 * Uses DeliveryError (not NotificationError) for consistency with the delivery module.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import { createDatabaseError, type DeliveryError } from '../../core/errors.js';

import type { ExtendedNotificationsRepository } from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type {
  Notification,
  NotificationType,
  NotificationConfig,
} from '@/modules/notifications/core/types.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

interface GlobalUnsubscribeRow {
  user_id: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
}

interface NotificationOutboxReferenceRow {
  reference_id: string | null;
}

export interface ExtendedNotificationsRepoOptions {
  db: UserDbClient;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const mapRow = (row: QueryRow): Notification => ({
  id: row.id,
  userId: row.user_id,
  entityCui: row.entity_cui,
  notificationType: row.notification_type as NotificationType,
  isActive: row.is_active,
  config: row.config as NotificationConfig,
  hash: row.hash,
  createdAt: parseDbTimestamp(row.created_at, 'created_at'),
  updatedAt: parseDbTimestamp(row.updated_at, 'updated_at'),
});

const GLOBAL_UNSUB_TYPE = 'global_unsubscribe';

const isEmailGloballyUnsubscribed = (
  row: Pick<GlobalUnsubscribeRow, 'is_active' | 'config'>
): boolean => {
  if (!row.is_active) {
    return true;
  }

  const config = row.config;
  if (config !== null && typeof config === 'object') {
    const channels = config['channels'] as Record<string, unknown> | undefined;
    if (channels?.['email'] === false) {
      return true;
    }
  }

  return false;
};

const ALL_COLUMNS = [
  'id',
  'user_id',
  'entity_cui',
  'notification_type',
  'is_active',
  'config',
  'hash',
  'created_at',
  'updated_at',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const makeExtendedNotificationsRepo = (
  options: ExtendedNotificationsRepoOptions
): ExtendedNotificationsRepository => {
  const { db, logger } = options;
  const log = logger.child({ repo: 'ExtendedNotificationsRepo' });

  return {
    async findById(notificationId: string): Promise<Result<Notification | null, DeliveryError>> {
      try {
        const row = await db
          .selectFrom('notifications')
          .select([...ALL_COLUMNS])
          .where('id', '=', notificationId)
          .executeTakeFirst();

        if (row === undefined) return ok(null);
        return ok(mapRow(row as unknown as QueryRow));
      } catch (error) {
        log.error({ err: error, notificationId }, 'Failed to find notification');
        return err(createDatabaseError('Failed to find notification'));
      }
    },

    async findEligibleForDelivery(
      notificationType: NotificationType,
      periodKey: string,
      limit?: number,
      ignoreMaterialized = false
    ): Promise<Result<Notification[], DeliveryError>> {
      try {
        const notificationRows = await db
          .selectFrom('notifications')
          .select([...ALL_COLUMNS])
          .where('notification_type', '=', notificationType)
          .where('is_active', '=', true)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();

        const globalUnsubscribeRows = await db
          .selectFrom('notifications')
          .select(['user_id', 'is_active', 'config'])
          .where('notification_type', '=', GLOBAL_UNSUB_TYPE)
          .execute();

        const globallyUnsubscribedUsers = new Set(
          globalUnsubscribeRows
            .filter((row) => isEmailGloballyUnsubscribed(row as unknown as GlobalUnsubscribeRow))
            .map((row) => row.user_id)
        );

        const materializedNotificationIds = ignoreMaterialized
          ? new Set<string>()
          : new Set(
              (
                await db
                  .selectFrom('notificationoutbox')
                  .select(['reference_id'])
                  .where('scope_key', '=', periodKey)
                  .where('notification_type', '=', notificationType)
                  .execute()
              )
                .map((row) => (row as NotificationOutboxReferenceRow).reference_id)
                .filter((referenceId): referenceId is string => typeof referenceId === 'string')
            );

        const eligibleNotifications = notificationRows
          .map((row) => mapRow(row as unknown as QueryRow))
          .filter(
            (notification) =>
              !globallyUnsubscribedUsers.has(notification.userId) &&
              !materializedNotificationIds.has(notification.id)
          );

        return ok(
          limit === undefined ? eligibleNotifications : eligibleNotifications.slice(0, limit)
        );
      } catch (error) {
        log.error(
          { err: error, notificationType, periodKey },
          'Failed to find eligible notifications'
        );
        return err(createDatabaseError('Failed to find eligible notifications'));
      }
    },

    async deactivate(notificationId: string): Promise<Result<void, DeliveryError>> {
      try {
        await db
          .updateTable('notifications')
          .set({ is_active: false, updated_at: sql`NOW()` })
          .where('id', '=', notificationId)
          .execute();

        return ok(undefined);
      } catch (error) {
        log.error({ err: error, notificationId }, 'Failed to deactivate notification');
        return err(createDatabaseError('Failed to deactivate notification'));
      }
    },

    async isUserGloballyUnsubscribed(userId: string): Promise<Result<boolean, DeliveryError>> {
      try {
        const row = await db
          .selectFrom('notifications')
          .select(['is_active', 'config'])
          .where('user_id', '=', userId)
          .where('notification_type', '=', GLOBAL_UNSUB_TYPE)
          .executeTakeFirst();

        // No global row = not unsubscribed
        if (row === undefined) {
          return ok(false);
        }

        return ok(isEmailGloballyUnsubscribed(row as unknown as GlobalUnsubscribeRow));
      } catch (error) {
        log.error({ err: error, userId }, 'Failed to check global unsubscribe status');
        return err(createDatabaseError('Failed to check global unsubscribe status'));
      }
    },
  };
};
