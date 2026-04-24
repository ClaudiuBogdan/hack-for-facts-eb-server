import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeDeliveriesRepo } from '@/modules/notifications/index.js';

import type { UserDbClient } from '@/infra/database/client.js';

const testLogger = pinoLogger({ level: 'silent' });

function makeUserDb(rows: Record<string, unknown>[]) {
  const state = {
    selectedColumns: [] as string[],
    whereClauses: [] as { column: string; operator: string; value: unknown }[],
  };

  const queryAfterOffset = {
    execute: async () =>
      rows.filter((row) =>
        state.whereClauses.every((clause) => {
          if (clause.operator === '=') {
            return row[clause.column] === clause.value;
          }

          if (clause.operator === 'is not') {
            return row[clause.column] !== clause.value;
          }

          if (clause.operator === 'in' && Array.isArray(clause.value)) {
            return clause.value.includes(row[clause.column]);
          }

          return true;
        })
      ),
  };

  const queryAfterLimit = {
    offset: (_offset: number) => queryAfterOffset,
  };

  const queryAfterOrderBy = {
    orderBy: (_column: string, _direction: string) => queryAfterOrderBy,
    limit: (_limit: number) => queryAfterLimit,
  };

  const queryAfterWhere = {
    where: (column: string, operator: string, value: unknown) => {
      state.whereClauses.push({ column, operator, value });
      return queryAfterWhere;
    },
    orderBy: (_column: string, _direction: string) => queryAfterOrderBy,
  };

  const queryAfterSelect = {
    where: (column: string, operator: string, value: unknown) => {
      state.whereClauses.push({ column, operator, value });
      return queryAfterWhere;
    },
  };

  const query = {
    select: (columns: string[]) => {
      state.selectedColumns = columns;
      return queryAfterSelect;
    },
  };

  return {
    db: {
      selectFrom: (_table: string) => query,
    } as unknown as UserDbClient,
    getSelectedColumns: () => state.selectedColumns,
  };
}

describe('makeDeliveriesRepo', () => {
  it('preserves toEmail in the domain result', async () => {
    const { db, getSelectedColumns } = makeUserDb([
      {
        id: 'delivery-1',
        user_id: 'user-1',
        notification_type: 'newsletter_entity_monthly',
        reference_id: 'notification-1',
        scope_key: '2025-01',
        delivery_key: 'user-1:notification-1:2025-01',
        status: 'sent',
        rendered_subject: 'Subject',
        rendered_html: '<p>Hello</p>',
        rendered_text: 'Hello',
        content_hash: 'hash-1',
        template_name: 'newsletter_entity',
        template_version: '1.0.0',
        to_email: 'user@example.com',
        resend_email_id: 're_123',
        last_error: null,
        attempt_count: 1,
        last_attempt_at: '2025-01-15T12:00:00.000Z',
        sent_at: '2025-01-15T12:00:00.000Z',
        metadata: { source: 'test' },
        created_at: '2025-01-15T11:00:00.000Z',
      },
    ]);

    const repo = makeDeliveriesRepo({ db, logger: testLogger });
    const result = await repo.findByUserId('user-1', 10, 0);

    expect(getSelectedColumns()).toContain('to_email');
    expect(getSelectedColumns()).toContain('reference_id');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value[0]?.toEmail).toBe('user@example.com');
      expect(result.value[0]?.sentAt).toBeInstanceOf(Date);
    }
  });

  it('filters transactional welcome rows out of subscription delivery history', async () => {
    const { db } = makeUserDb([
      {
        id: 'delivery-1',
        user_id: 'user-1',
        notification_type: 'newsletter_entity_monthly',
        reference_id: 'notification-1',
        scope_key: '2025-01',
        delivery_key: 'user-1:notification-1:2025-01',
        status: 'sent',
        rendered_subject: 'Subject',
        rendered_html: '<p>Hello</p>',
        rendered_text: 'Hello',
        content_hash: 'hash-1',
        template_name: 'newsletter_entity',
        template_version: '1.0.0',
        to_email: 'user@example.com',
        resend_email_id: 're_123',
        last_error: null,
        attempt_count: 1,
        last_attempt_at: '2025-01-15T12:00:00.000Z',
        sent_at: '2025-01-15T12:00:00.000Z',
        metadata: { source: 'subscription' },
        created_at: '2025-01-15T11:00:00.000Z',
      },
      {
        id: 'delivery-2',
        user_id: 'user-1',
        notification_type: 'transactional_welcome',
        reference_id: null,
        scope_key: 'welcome',
        delivery_key: 'transactional_welcome:user-1',
        status: 'sent',
        rendered_subject: 'Welcome',
        rendered_html: '<p>Welcome</p>',
        rendered_text: 'Welcome',
        content_hash: 'hash-2',
        template_name: 'welcome',
        template_version: '1.0.0',
        to_email: 'user@example.com',
        resend_email_id: 're_456',
        last_error: null,
        attempt_count: 1,
        last_attempt_at: '2025-01-15T12:10:00.000Z',
        sent_at: '2025-01-15T12:10:00.000Z',
        metadata: { source: 'clerk_webhook.user_created' },
        created_at: '2025-01-15T11:10:00.000Z',
      },
    ]);

    const repo = makeDeliveriesRepo({ db, logger: testLogger });
    const result = await repo.findByUserId('user-1', 10, 0);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.notificationId).toBe('notification-1');
    }
  });

  it('maps null reference_id to notificationId null', async () => {
    const { db } = makeUserDb([
      {
        id: 'delivery-1',
        user_id: 'user-1',
        notification_type: 'newsletter_entity_monthly',
        reference_id: null,
        scope_key: '2025-01',
        delivery_key: 'user-1:no-reference:2025-01',
        status: 'sent',
        rendered_subject: 'Subject',
        rendered_html: '<p>Hello</p>',
        rendered_text: 'Hello',
        content_hash: 'hash-1',
        template_name: 'newsletter_entity',
        template_version: '1.0.0',
        to_email: 'user@example.com',
        resend_email_id: 're_123',
        last_error: null,
        attempt_count: 1,
        last_attempt_at: '2025-01-15T12:00:00.000Z',
        sent_at: '2025-01-15T12:00:00.000Z',
        metadata: { source: 'test' },
        created_at: '2025-01-15T11:00:00.000Z',
      },
    ]);

    const repo = makeDeliveriesRepo({ db, logger: testLogger });
    const result = await repo.findByUserId('user-1', 10, 0);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value[0]?.notificationId).toBeNull();
    }
  });

  it('hides unsent outbox rows from delivery history', async () => {
    const { db } = makeUserDb([
      {
        id: 'delivery-sent',
        user_id: 'user-1',
        notification_type: 'newsletter_entity_monthly',
        reference_id: 'notification-1',
        scope_key: '2025-01',
        delivery_key: 'user-1:notification-1:2025-01',
        status: 'sent',
        rendered_subject: 'Sent',
        rendered_html: '<p>Sent</p>',
        rendered_text: 'Sent',
        content_hash: 'hash-1',
        template_name: 'newsletter_entity',
        template_version: '1.0.0',
        to_email: 'user@example.com',
        resend_email_id: 're_123',
        last_error: null,
        attempt_count: 1,
        last_attempt_at: '2025-01-15T12:00:00.000Z',
        sent_at: '2025-01-15T12:00:00.000Z',
        metadata: { source: 'test' },
        created_at: '2025-01-15T11:00:00.000Z',
      },
      {
        id: 'delivery-pending',
        user_id: 'user-1',
        notification_type: 'newsletter_entity_monthly',
        reference_id: 'notification-2',
        scope_key: '2025-02',
        delivery_key: 'user-1:notification-2:2025-02',
        status: 'pending',
        rendered_subject: 'Pending',
        rendered_html: '<p>Pending</p>',
        rendered_text: 'Pending',
        content_hash: 'hash-2',
        template_name: 'newsletter_entity',
        template_version: '1.0.0',
        to_email: null,
        resend_email_id: null,
        last_error: null,
        attempt_count: 0,
        last_attempt_at: null,
        sent_at: null,
        metadata: { source: 'test' },
        created_at: '2025-02-15T11:00:00.000Z',
      },
    ]);

    const repo = makeDeliveriesRepo({ db, logger: testLogger });
    const result = await repo.findByUserId('user-1', 10, 0);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('delivery-sent');
    }
  });
});
