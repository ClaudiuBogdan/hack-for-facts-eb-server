import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeExtendedNotificationsRepo } from '@/modules/notification-delivery/index.js';

import type { UserDbClient } from '@/infra/database/client.js';

const testLogger = pinoLogger({ level: 'silent' });

interface QueryRow {
  id: string;
  user_id: string;
  entity_cui: string | null;
  notification_type: string;
  is_active: boolean;
  config: Record<string, unknown> | null;
  hash: string;
  created_at: string;
  updated_at: string;
}

interface NotificationOutboxRow {
  notification_type?: string;
  reference_id: string | null;
  scope_key: string;
  metadata?: Record<string, unknown>;
}

const toSortableValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

function makeUserDb(
  input:
    | QueryRow[]
    | {
        notifications: QueryRow[];
        outboxRows?: NotificationOutboxRow[];
      }
) {
  const notifications = Array.isArray(input) ? input : input.notifications;
  const outboxRows = Array.isArray(input) ? [] : (input.outboxRows ?? []);

  return {
    db: {
      selectFrom: (table: string) => {
        const rows = (table === 'notificationsoutbox'
          ? outboxRows
          : notifications) as unknown as Record<string, unknown>[];
        const state = {
          whereClauses: [] as { column: string; operator: string; value: unknown }[],
          limit: undefined as number | undefined,
          selectedColumns: undefined as readonly string[] | undefined,
          orderByClauses: [] as { column: string; direction: string }[],
        };

        const applyProjection = (row: Record<string, unknown>): Record<string, unknown> => {
          if (state.selectedColumns === undefined) {
            return row;
          }

          return Object.fromEntries(state.selectedColumns.map((column) => [column, row[column]]));
        };

        const executeRows = async () => {
          const filtered = rows.filter((row) =>
            state.whereClauses.every((clause) => {
              if (clause.operator === '=') {
                return row[clause.column] === clause.value;
              }

              if (clause.operator === 'in') {
                return Array.isArray(clause.value) && clause.value.includes(row[clause.column]);
              }

              return true;
            })
          );

          const ordered = [...filtered].sort((left, right) => {
            for (const clause of state.orderByClauses) {
              const leftValue = toSortableValue(left[clause.column]);
              const rightValue = toSortableValue(right[clause.column]);
              const comparison = leftValue.localeCompare(rightValue);

              if (comparison !== 0) {
                return clause.direction === 'desc' ? -comparison : comparison;
              }
            }

            return 0;
          });

          const projected = ordered.map((row) => applyProjection(row));
          return state.limit === undefined ? projected : projected.slice(0, state.limit);
        };

        const chain = {
          where: (column: string, operator: string, value: unknown) => {
            state.whereClauses.push({ column, operator, value });
            return chain;
          },
          orderBy: (column: string, direction: string) => {
            state.orderByClauses.push({ column, direction });
            return chain;
          },
          limit: (value: number) => {
            state.limit = value;
            return chain;
          },
          execute: executeRows,
          executeTakeFirst: async () => {
            const [first] = await executeRows();
            return first;
          },
        };

        return {
          select: (columns: readonly string[]) => {
            state.selectedColumns = columns;
            return chain;
          },
        };
      },
    } as unknown as UserDbClient,
  };
}

describe('makeExtendedNotificationsRepo', () => {
  it('returns all eligible notifications when no limit is provided', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-1',
        user_id: 'user-1',
        entity_cui: '1',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-2',
        user_id: 'user-2',
        entity_cui: '2',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'n-3',
        user_id: 'user-3',
        entity_cui: '3',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-3',
        created_at: '2026-03-03T10:00:00.000Z',
        updated_at: '2026-03-03T10:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-1', 'n-2', 'n-3']);
    }
  });

  it('excludes notifications that already have an outbox row for the requested period', async () => {
    const { db } = makeUserDb({
      notifications: [
        {
          id: 'n-1',
          user_id: 'user-1',
          entity_cui: '1',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-1',
          created_at: '2026-03-01T10:00:00.000Z',
          updated_at: '2026-03-01T10:00:00.000Z',
        },
        {
          id: 'n-2',
          user_id: 'user-2',
          entity_cui: '2',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-2',
          created_at: '2026-03-02T10:00:00.000Z',
          updated_at: '2026-03-02T10:00:00.000Z',
        },
      ],
      outboxRows: [
        {
          reference_id: 'n-1',
          scope_key: '2026-03',
          notification_type: 'newsletter_entity_monthly',
        },
      ],
    });

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-2']);
    }
  });

  it('excludes source notifications already bundled in a digest for the requested period', async () => {
    const { db } = makeUserDb({
      notifications: [
        {
          id: 'n-1',
          user_id: 'user-1',
          entity_cui: '1',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-1',
          created_at: '2026-03-01T10:00:00.000Z',
          updated_at: '2026-03-01T10:00:00.000Z',
        },
        {
          id: 'n-2',
          user_id: 'user-2',
          entity_cui: '2',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-2',
          created_at: '2026-03-02T10:00:00.000Z',
          updated_at: '2026-03-02T10:00:00.000Z',
        },
      ],
      outboxRows: [
        {
          reference_id: null,
          scope_key: 'digest:anaf_forexebug:2026-03',
          notification_type: 'anaf_forexebug_digest',
          metadata: {
            sourceNotificationIds: ['n-1'],
          },
        },
      ],
    });

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-2']);
    }
  });

  it('does not treat digest bundle membership as materialized when only direct rows should count', async () => {
    const { db } = makeUserDb({
      notifications: [
        {
          id: 'n-1',
          user_id: 'user-1',
          entity_cui: '1',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-1',
          created_at: '2026-03-01T10:00:00.000Z',
          updated_at: '2026-03-01T10:00:00.000Z',
        },
        {
          id: 'n-2',
          user_id: 'user-2',
          entity_cui: '2',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-2',
          created_at: '2026-03-02T10:00:00.000Z',
          updated_at: '2026-03-02T10:00:00.000Z',
        },
      ],
      outboxRows: [
        {
          reference_id: null,
          scope_key: 'digest:anaf_forexebug:2026-03',
          notification_type: 'anaf_forexebug_digest',
          metadata: {
            sourceNotificationIds: ['n-1'],
          },
        },
      ],
    });

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery(
      'newsletter_entity_monthly',
      '2026-03',
      undefined,
      false,
      'direct'
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-1', 'n-2']);
    }
  });

  it('includes already materialized notifications when ignoreMaterialized is true', async () => {
    const { db } = makeUserDb({
      notifications: [
        {
          id: 'n-1',
          user_id: 'user-1',
          entity_cui: '1',
          notification_type: 'newsletter_entity_monthly',
          is_active: true,
          config: null,
          hash: 'hash-1',
          created_at: '2026-03-01T10:00:00.000Z',
          updated_at: '2026-03-01T10:00:00.000Z',
        },
      ],
      outboxRows: [
        {
          reference_id: 'n-1',
          scope_key: '2026-03',
          notification_type: 'newsletter_entity_monthly',
        },
      ],
    });

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery(
      'newsletter_entity_monthly',
      '2026-03',
      undefined,
      true
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-1']);
    }
  });

  it('still honors an explicit limit after ordering deterministically', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-3',
        user_id: 'user-3',
        entity_cui: '3',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-3',
        created_at: '2026-03-03T10:00:00.000Z',
        updated_at: '2026-03-03T10:00:00.000Z',
      },
      {
        id: 'n-1',
        user_id: 'user-1',
        entity_cui: '1',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-2',
        user_id: 'user-2',
        entity_cui: '2',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03', 2);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-1', 'n-2']);
    }
  });

  it('excludes notifications for users with inactive global unsubscribe rows', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-1',
        user_id: 'user-1',
        entity_cui: '1',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-2',
        user_id: 'user-2',
        entity_cui: '2',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'global-user-1',
        user_id: 'user-1',
        entity_cui: null,
        notification_type: 'global_unsubscribe',
        is_active: false,
        config: { channels: { email: false } },
        hash: 'hash-global-1',
        created_at: '2026-03-01T09:00:00.000Z',
        updated_at: '2026-03-01T09:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-2']);
    }
  });

  it('excludes notifications for users whose global unsubscribe row disables email', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-1',
        user_id: 'user-1',
        entity_cui: '1',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-2',
        user_id: 'user-2',
        entity_cui: '2',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'global-user-1',
        user_id: 'user-1',
        entity_cui: null,
        notification_type: 'global_unsubscribe',
        is_active: true,
        config: { channels: { email: false } },
        hash: 'hash-global-1',
        created_at: '2026-03-01T09:00:00.000Z',
        updated_at: '2026-03-01T09:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-2']);
    }
  });

  it('applies limit after filtering globally unsubscribed users', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-1',
        user_id: 'user-1',
        entity_cui: '1',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-2',
        user_id: 'user-2',
        entity_cui: '2',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'n-3',
        user_id: 'user-3',
        entity_cui: '3',
        notification_type: 'newsletter_entity_monthly',
        is_active: true,
        config: null,
        hash: 'hash-3',
        created_at: '2026-03-03T10:00:00.000Z',
        updated_at: '2026-03-03T10:00:00.000Z',
      },
      {
        id: 'global-user-1',
        user_id: 'user-1',
        entity_cui: null,
        notification_type: 'global_unsubscribe',
        is_active: false,
        config: { channels: { email: false } },
        hash: 'hash-global-1',
        created_at: '2026-03-01T09:00:00.000Z',
        updated_at: '2026-03-01T09:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findEligibleForDelivery('newsletter_entity_monthly', '2026-03', 2);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-2', 'n-3']);
    }
  });

  it('excludes globally unsubscribed users from findActiveByTypeAndEntity', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-public-1',
        user_id: 'user-1',
        entity_cui: '12345678',
        notification_type: 'funky:notification:entity_updates',
        is_active: true,
        config: null,
        hash: 'hash-public-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-public-2',
        user_id: 'user-2',
        entity_cui: '12345678',
        notification_type: 'funky:notification:entity_updates',
        is_active: true,
        config: null,
        hash: 'hash-public-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'global-user-1',
        user_id: 'user-1',
        entity_cui: null,
        notification_type: 'global_unsubscribe',
        is_active: true,
        config: { channels: { email: false } },
        hash: 'hash-global-user-1',
        created_at: '2026-03-01T09:00:00.000Z',
        updated_at: '2026-03-01T09:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findActiveByTypeAndEntity(
      'funky:notification:entity_updates',
      '12345678'
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-public-2']);
    }
  });

  it('excludes users with a disabled public debate campaign preference from findActiveByTypeAndEntity', async () => {
    const { db } = makeUserDb([
      {
        id: 'n-public-1',
        user_id: 'user-1',
        entity_cui: '12345678',
        notification_type: 'funky:notification:entity_updates',
        is_active: true,
        config: null,
        hash: 'hash-public-1',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'n-public-2',
        user_id: 'user-2',
        entity_cui: '12345678',
        notification_type: 'funky:notification:entity_updates',
        is_active: true,
        config: null,
        hash: 'hash-public-2',
        created_at: '2026-03-02T10:00:00.000Z',
        updated_at: '2026-03-02T10:00:00.000Z',
      },
      {
        id: 'campaign-global-user-1',
        user_id: 'user-1',
        entity_cui: null,
        notification_type: 'funky:notification:global',
        is_active: false,
        config: null,
        hash: 'hash-campaign-global-user-1',
        created_at: '2026-03-01T09:00:00.000Z',
        updated_at: '2026-03-01T09:00:00.000Z',
      },
    ]);

    const repo = makeExtendedNotificationsRepo({ db, logger: testLogger });
    const result = await repo.findActiveByTypeAndEntity(
      'funky:notification:entity_updates',
      '12345678'
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((notification) => notification.id)).toEqual(['n-public-2']);
    }
  });
});
