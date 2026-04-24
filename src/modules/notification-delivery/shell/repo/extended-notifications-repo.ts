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
import {
  type ExtendedNotificationsRepository,
  type TargetedNotificationEligibility,
  type UserScopedNotificationEligibility,
} from '../../core/ports.js';

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
const PUBLIC_DEBATE_GLOBAL_TYPE = 'funky:notification:global';
const PUBLIC_DEBATE_ENTITY_TYPE = 'funky:notification:entity_updates';

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

  const loadGloballyUnsubscribedUsers = async (userIds: readonly string[]) => {
    const candidateUserIds = [...new Set(userIds)];
    if (candidateUserIds.length === 0) {
      return ok(new Set<string>());
    }

    const globalUnsubscribeRows = await db
      .selectFrom('notifications')
      .select(['user_id', 'is_active', 'config'])
      .where('notification_type', '=', GLOBAL_UNSUB_TYPE)
      .where('user_id', 'in', candidateUserIds)
      .execute();

    return ok(
      new Set(
        globalUnsubscribeRows
          .filter((row) => isEmailGloballyUnsubscribed(row))
          .map((row) => row.user_id)
      )
    );
  };

  const loadCampaignDisabledUsers = async (
    notificationType: NotificationType,
    userIds: readonly string[]
  ) => {
    if (notificationType !== PUBLIC_DEBATE_ENTITY_TYPE) {
      return ok(new Set<string>());
    }

    const candidateUserIds = [...new Set(userIds)];
    if (candidateUserIds.length === 0) {
      return ok(new Set<string>());
    }

    const disabledRows = await db
      .selectFrom('notifications')
      .select(['user_id'])
      .where('notification_type', '=', PUBLIC_DEBATE_GLOBAL_TYPE)
      .where('user_id', 'in', candidateUserIds)
      .where('is_active', '=', false)
      .execute();

    return ok(new Set(disabledRows.map((row) => row.user_id)));
  };

  const loadMatchingNotification = async (
    userId: string,
    notificationType: NotificationType,
    entityCui: string
  ): Promise<Notification | null> => {
    const row = await db
      .selectFrom('notifications')
      .select([...ALL_COLUMNS])
      .where('user_id', '=', userId)
      .where('notification_type', '=', notificationType)
      .where('entity_cui', '=', entityCui)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return mapRow(row);
  };

  const loadMatchingUserScopedNotification = async (
    userId: string,
    notificationType: NotificationType
  ): Promise<Notification | null> => {
    const row = await db
      .selectFrom('notifications')
      .select([...ALL_COLUMNS])
      .where('user_id', '=', userId)
      .where('notification_type', '=', notificationType)
      .where('entity_cui', 'is', null)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return mapRow(row);
  };

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

        const globallyUnsubscribedUsersResult = await loadGloballyUnsubscribedUsers(
          notificationRows.map((row) => row.user_id)
        );
        if (globallyUnsubscribedUsersResult.isErr()) {
          return err(globallyUnsubscribedUsersResult.error);
        }
        const globallyUnsubscribedUsers = globallyUnsubscribedUsersResult.value;

        const materializedNotificationIds = ignoreMaterialized
          ? new Set<string>()
          : new Set(
              (
                await db
                  .selectFrom('notificationsoutbox')
                  .select(['reference_id'])
                  .where('scope_key', '=', periodKey)
                  .where('notification_type', '=', notificationType)
                  .execute()
              )
                .map((row) => row.reference_id)
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

    async findActiveByTypeAndEntity(
      notificationType: NotificationType,
      entityCui: string
    ): Promise<Result<Notification[], DeliveryError>> {
      try {
        const notificationRows = await db
          .selectFrom('notifications')
          .select([...ALL_COLUMNS])
          .where('notification_type', '=', notificationType)
          .where('entity_cui', '=', entityCui)
          .where('is_active', '=', true)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute();

        const globallyUnsubscribedUsersResult = await loadGloballyUnsubscribedUsers(
          notificationRows.map((row) => row.user_id)
        );
        if (globallyUnsubscribedUsersResult.isErr()) {
          return err(globallyUnsubscribedUsersResult.error);
        }
        const globallyUnsubscribedUsers = globallyUnsubscribedUsersResult.value;
        const campaignDisabledUsersResult = await loadCampaignDisabledUsers(
          notificationType,
          notificationRows.map((row) => row.user_id)
        );
        if (campaignDisabledUsersResult.isErr()) {
          return err(campaignDisabledUsersResult.error);
        }
        const campaignDisabledUsers = campaignDisabledUsersResult.value;

        return ok(
          notificationRows
            .map((row) => mapRow(row as unknown as QueryRow))
            .filter(
              (notification) =>
                !globallyUnsubscribedUsers.has(notification.userId) &&
                !campaignDisabledUsers.has(notification.userId)
            )
        );
      } catch (error) {
        log.error(
          { err: error, notificationType, entityCui },
          'Failed to find active notifications by type and entity'
        );
        return err(createDatabaseError('Failed to find active notifications by type and entity'));
      }
    },

    async findEligibleByUserTypeAndEntity(
      userId: string,
      notificationType: NotificationType,
      entityCui: string
    ): Promise<Result<TargetedNotificationEligibility, DeliveryError>> {
      try {
        const notification = await loadMatchingNotification(userId, notificationType, entityCui);

        if (notification === null) {
          return ok({
            isEligible: false,
            reason: 'missing_preference',
            notification: null,
          });
        }

        if (!notification.isActive) {
          return ok({
            isEligible: false,
            reason: 'inactive_preference',
            notification,
          });
        }

        const globalUnsubscribeResult = await loadGloballyUnsubscribedUsers([userId]);
        if (globalUnsubscribeResult.isErr()) {
          return err(globalUnsubscribeResult.error);
        }

        if (globalUnsubscribeResult.value.has(userId)) {
          return ok({
            isEligible: false,
            reason: 'global_unsubscribe',
            notification,
          });
        }

        const campaignDisabledUsersResult = await loadCampaignDisabledUsers(notificationType, [
          userId,
        ]);
        if (campaignDisabledUsersResult.isErr()) {
          return err(campaignDisabledUsersResult.error);
        }

        if (campaignDisabledUsersResult.value.has(userId)) {
          return ok({
            isEligible: false,
            reason: 'campaign_disabled',
            notification,
          });
        }

        return ok({
          isEligible: true,
          reason: 'eligible',
          notification,
        });
      } catch (error) {
        log.error(
          { err: error, userId, notificationType, entityCui },
          'Failed to evaluate targeted notification eligibility'
        );
        return err(createDatabaseError('Failed to evaluate targeted notification eligibility'));
      }
    },

    async findEligibleByUserType(
      userId: string,
      notificationType: NotificationType
    ): Promise<Result<UserScopedNotificationEligibility, DeliveryError>> {
      try {
        const notification = await loadMatchingUserScopedNotification(userId, notificationType);

        if (notification === null) {
          return ok({
            isEligible: false,
            reason: 'missing_preference',
            notification: null,
          });
        }

        if (!notification.isActive) {
          return ok({
            isEligible: false,
            reason: 'inactive_preference',
            notification,
          });
        }

        const globalUnsubscribeResult = await loadGloballyUnsubscribedUsers([userId]);
        if (globalUnsubscribeResult.isErr()) {
          return err(globalUnsubscribeResult.error);
        }

        if (globalUnsubscribeResult.value.has(userId)) {
          return ok({
            isEligible: false,
            reason: 'global_unsubscribe',
            notification,
          });
        }

        return ok({
          isEligible: true,
          reason: 'eligible',
          notification,
        });
      } catch (error) {
        log.error(
          { err: error, userId, notificationType },
          'Failed to evaluate user-scoped notification eligibility'
        );
        return err(createDatabaseError('Failed to evaluate user-scoped notification eligibility'));
      }
    },

    async findActiveByType(
      notificationType: NotificationType
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

        const globallyUnsubscribedUsersResult = await loadGloballyUnsubscribedUsers(
          notificationRows.map((row) => row.user_id)
        );
        if (globallyUnsubscribedUsersResult.isErr()) {
          return err(globallyUnsubscribedUsersResult.error);
        }

        const campaignDisabledUsersResult = await loadCampaignDisabledUsers(
          notificationType,
          notificationRows.map((row) => row.user_id)
        );
        if (campaignDisabledUsersResult.isErr()) {
          return err(campaignDisabledUsersResult.error);
        }

        const globallyUnsubscribedUsers = globallyUnsubscribedUsersResult.value;
        const campaignDisabledUsers = campaignDisabledUsersResult.value;

        return ok(
          notificationRows
            .map((row) => mapRow(row as unknown as QueryRow))
            .filter(
              (notification) =>
                !globallyUnsubscribedUsers.has(notification.userId) &&
                !campaignDisabledUsers.has(notification.userId)
            )
        );
      } catch (error) {
        log.error({ err: error, notificationType }, 'Failed to find active notifications by type');
        return err(createDatabaseError('Failed to find active notifications by type'));
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
