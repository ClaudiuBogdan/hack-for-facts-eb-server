import { describe, expect, it, vi } from 'vitest';

import { makeCampaignNotificationRunnablePlanRepo } from '@/modules/campaign-admin-notifications/index.js';

const createLogger = () => {
  const logger = {
    child: vi.fn(() => logger),
    error: vi.fn(),
  };

  return logger;
};

const createValidPlanInput = () => ({
  actorUserId: 'admin-1',
  campaignKey: 'funky' as const,
  runnableId: 'admin_reviewed_user_interaction',
  templateId: 'admin_reviewed_user_interaction',
  templateVersion: '1.0.0',
  payloadHash: 'payload-hash',
  watermark: '2026-04-14T20:00:00.000Z',
  summary: {
    totalRowCount: 1,
    willSendCount: 1,
    alreadySentCount: 0,
    alreadyPendingCount: 0,
    ineligibleCount: 0,
    missingDataCount: 0,
  },
  rows: [
    {
      preview: {
        rowKey: 'row-1',
        userId: 'user-1',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        recordKey: 'record-1',
        interactionId: 'funky:interaction:budget_document',
        interactionLabel: 'Document buget',
        reviewStatus: 'rejected' as const,
        reviewedAt: '2026-04-14 19:00:00',
        status: 'will_send' as const,
        reasonCode: 'eligible_now',
        statusMessage: 'Ready to send.',
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: 'create' as const,
      },
      executionData: {
        kind: 'admin_reviewed_interaction',
      },
    },
  ],
  expiresAt: '2099-01-01T00:00:00.000Z',
});

describe('campaign notification runnable plan repo', () => {
  it('validates rows before insert and avoids persisting malformed plans', async () => {
    const cleanupExecute = vi.fn(async () => undefined);
    const cleanupWhere = vi.fn(function () {
      return cleanupQuery;
    });
    const cleanupQuery = {
      where: cleanupWhere,
      execute: cleanupExecute,
    };

    const insertInto = vi.fn();
    const logger = createLogger();

    const repo = makeCampaignNotificationRunnablePlanRepo({
      db: {
        deleteFrom: vi.fn(() => cleanupQuery),
        insertInto,
      } as never,
      logger: logger as never,
    });

    const result = await repo.createPlan({
      ...createValidPlanInput(),
      rows: [
        {
          preview: {
            ...createValidPlanInput().rows[0]!.preview,
            rowKey: '',
          },
          executionData: null,
        },
      ] as never,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('DatabaseError');
      expect(result.error.message).toContain('rowKey');
    }
    expect(insertInto).not.toHaveBeenCalled();
    expect(cleanupExecute).toHaveBeenCalledTimes(1);
  });

  it('cleans up old plans before insert and accepts non-RFC3339 reviewedAt strings', async () => {
    const cleanupExecute = vi.fn(async () => undefined);
    const cleanupQuery = {
      where: vi.fn(function () {
        return cleanupQuery;
      }),
      execute: cleanupExecute,
    };

    const insertedRow = {
      id: 'plan-1',
      actor_user_id: 'admin-1',
      campaign_key: 'funky',
      runnable_id: 'admin_reviewed_user_interaction',
      template_id: 'admin_reviewed_user_interaction',
      template_version: '1.0.0',
      payload_hash: 'payload-hash',
      watermark: '2026-04-14T20:00:00.000Z',
      summary_json: createValidPlanInput().summary,
      rows_json: createValidPlanInput().rows,
      created_at: '2026-04-14T20:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      consumed_at: null,
    };

    const executeTakeFirst = vi.fn(async () => insertedRow);
    const insertQuery = {
      values: vi.fn(function () {
        return insertQuery;
      }),
      returningAll: vi.fn(function () {
        return insertQuery;
      }),
      executeTakeFirst,
    };

    const repo = makeCampaignNotificationRunnablePlanRepo({
      db: {
        deleteFrom: vi.fn(() => cleanupQuery),
        insertInto: vi.fn(() => insertQuery),
      } as never,
      logger: createLogger() as never,
    });

    const result = await repo.createPlan(createValidPlanInput());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.planId).toBe('plan-1');
      expect(result.value.rows[0]?.preview.reviewedAt).toBe('2026-04-14 19:00:00');
    }
    expect(cleanupExecute).toHaveBeenCalledTimes(1);
    expect(executeTakeFirst).toHaveBeenCalledTimes(1);
  });
});
