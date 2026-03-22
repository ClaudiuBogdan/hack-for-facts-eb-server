import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeDeliveriesRepo } from '@/modules/notifications/index.js';

import type { UserDbClient } from '@/infra/database/client.js';

const testLogger = pinoLogger({ level: 'silent' });

function makeUserDb(rows: Record<string, unknown>[]) {
  const state = {
    selectedColumns: [] as string[],
  };

  const queryAfterOffset = {
    execute: async () => rows,
  };

  const queryAfterLimit = {
    offset: (_offset: number) => queryAfterOffset,
  };

  const queryAfterOrderBy = {
    limit: (_limit: number) => queryAfterLimit,
  };

  const queryAfterWhere = {
    orderBy: (_column: string, _direction: string) => queryAfterOrderBy,
  };

  const queryAfterSelect = {
    where: (_column: string, _operator: string, _value: string) => queryAfterWhere,
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
        notification_id: 'notification-1',
        period_key: '2025-01',
        delivery_key: 'user-1:notification-1:2025-01',
        status: 'sent',
        unsubscribe_token: null,
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
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value[0]?.toEmail).toBe('user@example.com');
    }
  });
});
