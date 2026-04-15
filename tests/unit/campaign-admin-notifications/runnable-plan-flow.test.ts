import { Type } from '@sinclair/typebox';
import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createCampaignNotificationRunnablePlan,
  createDatabaseError,
  getCampaignNotificationRunnablePlan,
  sendCampaignNotificationRunnablePlan,
  type CampaignNotificationStoredPlan,
} from '@/modules/campaign-admin-notifications/index.js';

const createStoredPlan = (
  overrides: Partial<CampaignNotificationStoredPlan> = {}
): CampaignNotificationStoredPlan => ({
  planId: 'plan-1',
  actorUserId: 'admin-1',
  campaignKey: 'funky',
  runnableId: 'runnable-1',
  templateId: 'template-1',
  templateVersion: '1.0.0',
  payloadHash: 'hash',
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
        interactionId: 'interaction-1',
        interactionLabel: 'Interaction 1',
        reviewStatus: 'rejected',
        reviewedAt: '2026-04-14T19:00:00.000Z',
        status: 'will_send',
        reasonCode: 'eligible_now',
        statusMessage: 'Ready to send.',
        hasExistingDelivery: false,
        existingDeliveryStatus: null,
        sendMode: 'create',
      },
      executionData: { kind: 'test' },
    },
  ],
  createdAt: '2026-04-14T20:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  consumedAt: null,
  ...overrides,
});

describe('campaign notification runnable plan flow', () => {
  it('returns NotFoundError when creating a dry-run plan for an unknown runnable', async () => {
    const createPlan = vi.fn();

    const result = await createCampaignNotificationRunnablePlan(
      {
        runnableTemplateRegistry: {
          list() {
            return [];
          },
          get() {
            return null;
          },
        },
        planRepository: {
          createPlan,
          async findPlanById() {
            return ok(null);
          },
          async consumePlan() {
            return ok(false);
          },
          async releasePlan() {
            return ok(false);
          },
        },
      },
      {
        campaignKey: 'funky',
        runnableId: 'unknown-runnable',
        actorUserId: 'admin-1',
        payload: {},
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NotFoundError');
    }
    expect(createPlan).not.toHaveBeenCalled();
  });

  it('returns ValidationError when dry-run filters contain unknown fields', async () => {
    const createPlan = vi.fn();

    const result = await createCampaignNotificationRunnablePlan(
      {
        runnableTemplateRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              runnableId: 'runnable',
              campaignKey: 'funky' as const,
              templateId: 'template',
              templateVersion: '1.0.0',
              description: 'test runnable',
              selectorSchema: Type.Object({}, { additionalProperties: false }),
              filterSchema: Type.Object(
                {
                  reviewStatus: Type.Optional(
                    Type.Union([Type.Literal('approved'), Type.Literal('rejected')])
                  ),
                },
                { additionalProperties: false }
              ),
              selectors: [],
              filters: [],
              targetKind: 'user',
              dryRunRequired: true,
              maxPlanRowCount: 100,
              defaultPageSize: 25,
              maxPageSize: 100,
              async dryRun() {
                return ok({
                  watermark: '2026-04-14T20:00:00.000Z',
                  summary: {
                    totalRowCount: 0,
                    willSendCount: 0,
                    alreadySentCount: 0,
                    alreadyPendingCount: 0,
                    ineligibleCount: 0,
                    missingDataCount: 0,
                  },
                  rows: [],
                });
              },
              async executeStoredRow() {
                return ok({ outcome: 'queued' as const });
              },
            };
          },
        },
        planRepository: {
          createPlan,
          async findPlanById() {
            return ok(null);
          },
          async consumePlan() {
            return ok(false);
          },
          async releasePlan() {
            return ok(false);
          },
        },
      },
      {
        campaignKey: 'funky',
        runnableId: 'runnable',
        actorUserId: 'admin-1',
        payload: {
          filters: {
            unexpected: true,
          },
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
    expect(createPlan).not.toHaveBeenCalled();
  });

  it('returns ValidationError when reading a stored plan with a cursor from another plan', async () => {
    const result = await getCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(createStoredPlan());
          },
          async consumePlan() {
            return ok(false);
          },
          async releasePlan() {
            return ok(false);
          },
        },
      },
      {
        campaignKey: 'funky',
        planId: 'plan-1',
        actorUserId: 'admin-1',
        cursor: Buffer.from(
          JSON.stringify({
            planId: 'plan-2',
            offset: 1,
          }),
          'utf-8'
        ).toString('base64url'),
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
      expect(result.error.message).toBe('Invalid campaign notification plan cursor.');
    }
  });

  it('returns ValidationError when reading a consumed stored plan', async () => {
    const result = await getCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(
              createStoredPlan({
                consumedAt: '2026-04-14T21:00:00.000Z',
              })
            );
          },
          async consumePlan() {
            return ok(false);
          },
          async releasePlan() {
            return ok(false);
          },
        },
      },
      {
        campaignKey: 'funky',
        planId: 'plan-1',
        actorUserId: 'admin-1',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
      expect(result.error.message).toBe('Invalid campaign notification plan.');
    }
  });

  it('returns ValidationError when sending a plan that no longer matches the runnable definition', async () => {
    const consumePlan = vi.fn(async () => ok(true));

    const result = await sendCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(createStoredPlan());
          },
          consumePlan,
          async releasePlan() {
            return ok(false);
          },
        },
        runnableTemplateRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              runnableId: 'runnable-1',
              campaignKey: 'funky' as const,
              templateId: 'template-1',
              templateVersion: '2.0.0',
              description: 'test runnable',
              selectorSchema: Type.Object({}, { additionalProperties: false }),
              filterSchema: Type.Object({}, { additionalProperties: false }),
              selectors: [],
              filters: [],
              targetKind: 'user',
              dryRunRequired: true,
              maxPlanRowCount: 100,
              defaultPageSize: 25,
              maxPageSize: 100,
              async dryRun() {
                throw new Error('not used');
              },
              async executeStoredRow() {
                return ok({ outcome: 'queued' as const });
              },
            };
          },
        },
      },
      {
        campaignKey: 'funky',
        planId: 'plan-1',
        actorUserId: 'admin-1',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
      expect(result.error.message).toBe('Invalid campaign notification plan.');
    }
    expect(consumePlan).not.toHaveBeenCalled();
  });

  it('releases the claimed plan when row execution returns Err', async () => {
    const executeStoredRow = vi
      .fn()
      .mockResolvedValueOnce(err(createDatabaseError('temporary send failure')))
      .mockResolvedValueOnce(ok({ outcome: 'queued' as const }));
    const releasePlan = vi.fn(async () => ok(true));

    const result = await sendCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(
              createStoredPlan({
                rows: [
                  createStoredPlan().rows[0]!,
                  {
                    ...createStoredPlan().rows[0]!,
                    preview: {
                      ...createStoredPlan().rows[0]!.preview,
                      rowKey: 'row-2',
                      userId: 'user-2',
                    },
                  },
                ],
                summary: {
                  totalRowCount: 2,
                  willSendCount: 2,
                  alreadySentCount: 0,
                  alreadyPendingCount: 0,
                  ineligibleCount: 0,
                  missingDataCount: 0,
                },
              })
            );
          },
          async consumePlan() {
            return ok(true);
          },
          releasePlan,
        },
        runnableTemplateRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              runnableId: 'runnable-1',
              campaignKey: 'funky' as const,
              templateId: 'template-1',
              templateVersion: '1.0.0',
              description: 'test runnable',
              selectorSchema: Type.Object({}, { additionalProperties: false }),
              filterSchema: Type.Object({}, { additionalProperties: false }),
              selectors: [],
              filters: [],
              targetKind: 'user',
              dryRunRequired: true,
              maxPlanRowCount: 100,
              defaultPageSize: 25,
              maxPageSize: 100,
              async dryRun() {
                throw new Error('not used');
              },
              executeStoredRow,
            };
          },
        },
      },
      {
        campaignKey: 'funky',
        planId: 'plan-1',
        actorUserId: 'admin-1',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.enqueueFailedCount).toBe(1);
      expect(result.value.queuedCount).toBe(1);
      expect(result.value.evaluatedCount).toBe(2);
    }
    expect(executeStoredRow).toHaveBeenCalledTimes(2);
    expect(releasePlan).toHaveBeenCalledWith({
      planId: 'plan-1',
    });
  });
});
