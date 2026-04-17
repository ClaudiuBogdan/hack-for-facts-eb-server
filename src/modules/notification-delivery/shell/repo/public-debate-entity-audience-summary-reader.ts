import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
} from '@/common/campaign-keys.js';

import {
  buildPublicDebateEntityAudienceSummaryKey,
  type PublicDebateEntityAudienceSummary,
} from '../../core/admin-response.js';
import { createDatabaseError, type DeliveryError } from '../../core/errors.js';

import type { PublicDebateEntityAudienceSummaryReader } from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

interface EntitySubscriptionRow {
  entity_cui: string | null;
  user_id: string;
}

interface GlobalPreferenceRow {
  user_id: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
}

export interface PublicDebateEntityAudienceSummaryReaderConfig {
  db: UserDbClient;
  logger: Logger;
}

const isEmailGloballyUnsubscribed = (row: GlobalPreferenceRow): boolean => {
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

const normalizeRequesterUserId = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const makePublicDebateEntityAudienceSummaryReader = (
  config: PublicDebateEntityAudienceSummaryReaderConfig
): PublicDebateEntityAudienceSummaryReader => {
  const log = config.logger.child({ repo: 'PublicDebateEntityAudienceSummaryReader' });

  return {
    async summarize(
      inputs
    ): Promise<Result<Map<string, PublicDebateEntityAudienceSummary>, DeliveryError>> {
      const uniqueInputs = new Map(
        inputs.map((input) => [
          buildPublicDebateEntityAudienceSummaryKey({
            entityCui: input.entityCui,
            requesterUserId: normalizeRequesterUserId(input.requesterUserId),
          }),
          {
            entityCui: input.entityCui,
            requesterUserId: normalizeRequesterUserId(input.requesterUserId),
          },
        ])
      );

      if (uniqueInputs.size === 0) {
        return ok(new Map());
      }

      try {
        const entityCuis = [...new Set([...uniqueInputs.values()].map((input) => input.entityCui))];
        const subscriptionRows = (await config.db
          .selectFrom('notifications')
          .select(['entity_cui', 'user_id'])
          .where('notification_type', '=', FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE)
          .where('is_active', '=', true)
          .where('entity_cui', 'in', entityCuis)
          .execute()) as EntitySubscriptionRow[];

        const entityUserMap = new Map<string, Set<string>>();
        const allUserIds = new Set<string>();

        for (const row of subscriptionRows) {
          if (row.entity_cui === null) {
            continue;
          }

          const entityUsers = entityUserMap.get(row.entity_cui) ?? new Set<string>();
          entityUsers.add(row.user_id);
          entityUserMap.set(row.entity_cui, entityUsers);
          allUserIds.add(row.user_id);
        }

        const userIds = [...allUserIds];
        const globalUnsubscribeRows =
          userIds.length === 0
            ? []
            : ((await config.db
                .selectFrom('notifications')
                .select(['user_id', 'is_active', 'config'])
                .where('notification_type', '=', 'global_unsubscribe')
                .where('user_id', 'in', userIds)
                .execute()) as GlobalPreferenceRow[]);

        const campaignDisabledRows =
          userIds.length === 0
            ? []
            : ((await config.db
                .selectFrom('notifications')
                .select(['user_id'])
                .where('notification_type', '=', FUNKY_NOTIFICATION_GLOBAL_TYPE)
                .where('is_active', '=', false)
                .where('user_id', 'in', userIds)
                .execute()) as { user_id: string }[]);

        const globallyUnsubscribedUsers = new Set(
          globalUnsubscribeRows
            .filter((row) => isEmailGloballyUnsubscribed(row))
            .map((row) => row.user_id)
        );
        const campaignDisabledUsers = new Set(campaignDisabledRows.map((row) => row.user_id));

        const summaries = new Map<string, PublicDebateEntityAudienceSummary>();

        for (const [key, input] of uniqueInputs.entries()) {
          const requesterUserId = input.requesterUserId;
          const rawUsers = entityUserMap.get(input.entityCui) ?? new Set<string>();
          const eligibleUsers = [...rawUsers].filter(
            (userId) => !globallyUnsubscribedUsers.has(userId) && !campaignDisabledUsers.has(userId)
          );

          const rawRequesterCount =
            requesterUserId !== null && rawUsers.has(requesterUserId) ? 1 : 0;
          const eligibleRequesterCount =
            requesterUserId !== null && eligibleUsers.includes(requesterUserId) ? 1 : 0;

          summaries.set(key, {
            requesterCount: rawRequesterCount,
            subscriberCount: rawUsers.size - rawRequesterCount,
            eligibleRequesterCount,
            eligibleSubscriberCount: eligibleUsers.length - eligibleRequesterCount,
          });
        }

        return ok(summaries);
      } catch (error) {
        log.error({ err: error, inputs }, 'Failed to summarize public debate entity audiences');
        return err(createDatabaseError('Failed to summarize public debate entity audiences'));
      }
    },
  };
};
