import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makePublicDebateEntityAudienceSummaryReader } from '@/modules/notification-delivery/index.js';

import type { UserDbClient } from '@/infra/database/client.js';

const testLogger = pinoLogger({ level: 'silent' });

interface NotificationRow {
  user_id: string;
  entity_cui: string | null;
  notification_type: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
}

function makeUserDb(rows: readonly NotificationRow[]): UserDbClient {
  return {
    selectFrom: (table: string) => {
      if (table !== 'notifications') {
        throw new Error(`Unsupported table ${table}`);
      }

      const state = {
        selectedColumns: undefined as readonly string[] | undefined,
        clauses: [] as { column: string; operator: string; value: unknown }[],
      };

      const executeRows = async () => {
        const filtered = rows.filter((row) =>
          state.clauses.every((clause) => {
            if (clause.operator === '=') {
              return row[clause.column as keyof NotificationRow] === clause.value;
            }

            if (clause.operator === 'in') {
              return (
                Array.isArray(clause.value) &&
                clause.value.includes(row[clause.column as keyof NotificationRow])
              );
            }

            return true;
          })
        );

        if (state.selectedColumns === undefined) {
          return filtered as unknown as Record<string, unknown>[];
        }

        return filtered.map((row) =>
          Object.fromEntries(
            state.selectedColumns!.map((column) => [column, row[column as keyof NotificationRow]])
          )
        );
      };

      const chain = {
        where(column: string, operator: string, value: unknown) {
          state.clauses.push({ column, operator, value });
          return chain;
        },
        execute: executeRows,
      };

      return {
        select(columns: readonly string[]) {
          state.selectedColumns = columns;
          return chain;
        },
      };
    },
  } as unknown as UserDbClient;
}

describe('makePublicDebateEntityAudienceSummaryReader', () => {
  it('counts requester and subscribers when the requester is subscribed', async () => {
    const reader = makePublicDebateEntityAudienceSummaryReader({
      db: makeUserDb([
        {
          user_id: 'user-1',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
        {
          user_id: 'user-2',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
        {
          user_id: 'user-3',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
      ]),
      logger: testLogger,
    });

    const result = await reader.summarize([
      {
        entityCui: '12345678',
        requesterUserId: 'user-1',
      },
    ]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect([...result.value.values()][0]).toEqual({
        requesterCount: 1,
        subscriberCount: 2,
        eligibleRequesterCount: 1,
        eligibleSubscriberCount: 2,
      });
    }
  });

  it('treats all subscribed users as subscribers when the requester is not subscribed', async () => {
    const reader = makePublicDebateEntityAudienceSummaryReader({
      db: makeUserDb([
        {
          user_id: 'user-2',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
      ]),
      logger: testLogger,
    });

    const result = await reader.summarize([
      {
        entityCui: '12345678',
        requesterUserId: 'user-1',
      },
    ]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect([...result.value.values()][0]).toEqual({
        requesterCount: 0,
        subscriberCount: 1,
        eligibleRequesterCount: 0,
        eligibleSubscriberCount: 1,
      });
    }
  });

  it('filters eligible counts when a user is globally unsubscribed', async () => {
    const reader = makePublicDebateEntityAudienceSummaryReader({
      db: makeUserDb([
        {
          user_id: 'user-1',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
        {
          user_id: 'user-1',
          entity_cui: null,
          notification_type: 'global_unsubscribe',
          is_active: false,
          config: { channels: { email: false } },
        },
        {
          user_id: 'user-2',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
      ]),
      logger: testLogger,
    });

    const result = await reader.summarize([
      {
        entityCui: '12345678',
        requesterUserId: 'user-1',
      },
    ]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect([...result.value.values()][0]).toEqual({
        requesterCount: 1,
        subscriberCount: 1,
        eligibleRequesterCount: 0,
        eligibleSubscriberCount: 1,
      });
    }
  });

  it('filters eligible counts when the campaign preference is disabled', async () => {
    const reader = makePublicDebateEntityAudienceSummaryReader({
      db: makeUserDb([
        {
          user_id: 'user-1',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
        {
          user_id: 'user-1',
          entity_cui: null,
          notification_type: 'funky:notification:global',
          is_active: false,
          config: null,
        },
        {
          user_id: 'user-2',
          entity_cui: '12345678',
          notification_type: 'funky:notification:entity_updates',
          is_active: true,
          config: null,
        },
      ]),
      logger: testLogger,
    });

    const result = await reader.summarize([
      {
        entityCui: '12345678',
        requesterUserId: null,
      },
    ]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect([...result.value.values()][0]).toEqual({
        requesterCount: 0,
        subscriberCount: 2,
        eligibleRequesterCount: 0,
        eligibleSubscriberCount: 1,
      });
    }
  });
});
