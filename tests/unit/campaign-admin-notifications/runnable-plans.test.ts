import { Type } from '@sinclair/typebox';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createCampaignNotificationRunnablePlan,
  sendCampaignNotificationRunnablePlan,
  type CampaignNotificationStoredPlan,
} from '@/modules/campaign-admin-notifications/index.js';

describe('campaign notification runnable plans', () => {
  it('returns ValidationError when dry-run selectors contain unknown fields', async () => {
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
              selectorSchema: Type.Object(
                {
                  userId: Type.Optional(Type.String({ minLength: 1 })),
                },
                { additionalProperties: false }
              ),
              filterSchema: Type.Object({}, { additionalProperties: false }),
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
          selectors: {
            unexpected: 'value',
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

  it('aggregates stored skipped rows and live send outcomes', async () => {
    const storedPlan: CampaignNotificationStoredPlan = {
      planId: 'plan-1',
      actorUserId: 'admin-1',
      campaignKey: 'funky',
      runnableId: 'runnable',
      templateId: 'template',
      templateVersion: '1.0.0',
      payloadHash: 'hash',
      watermark: '2026-04-14T20:00:00.000Z',
      summary: {
        totalRowCount: 2,
        willSendCount: 1,
        alreadySentCount: 0,
        alreadyPendingCount: 1,
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
            status: 'already_pending',
            reasonCode: 'existing_pending',
            statusMessage: 'A notification is already pending for this reviewed interaction.',
            hasExistingDelivery: true,
            existingDeliveryStatus: 'pending',
            sendMode: null,
          },
          executionData: null,
        },
        {
          preview: {
            rowKey: 'row-2',
            userId: 'user-2',
            entityCui: '87654321',
            entityName: 'Municipiul Test',
            recordKey: 'record-2',
            interactionId: 'interaction-2',
            interactionLabel: 'Interaction 2',
            reviewStatus: 'approved',
            reviewedAt: '2026-04-14T19:30:00.000Z',
            status: 'will_send',
            reasonCode: 'eligible_now',
            statusMessage: 'Ready to send.',
            hasExistingDelivery: false,
            existingDeliveryStatus: null,
            sendMode: 'create',
          },
          executionData: {
            kind: 'test',
          },
        },
      ],
      createdAt: '2026-04-14T20:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      consumedAt: null,
    };

    const executeStoredRow = vi.fn(async () => ok({ outcome: 'queued' as const }));
    const releasePlan = vi.fn(async () => ok(true));

    const result = await sendCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(storedPlan);
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
              runnableId: 'runnable',
              campaignKey: 'funky' as const,
              templateId: 'template',
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
      expect(result.value).toEqual({
        planId: 'plan-1',
        runnableId: 'runnable',
        templateId: 'template',
        evaluatedCount: 2,
        queuedCount: 1,
        alreadySentCount: 0,
        alreadyPendingCount: 1,
        ineligibleCount: 0,
        missingDataCount: 0,
        enqueueFailedCount: 0,
      });
    }
    expect(executeStoredRow).toHaveBeenCalledTimes(1);
    expect(releasePlan).not.toHaveBeenCalled();
  });

  it('keeps the plan consumed when row execution records enqueue_failed', async () => {
    const storedPlan: CampaignNotificationStoredPlan = {
      planId: 'plan-2',
      actorUserId: 'admin-1',
      campaignKey: 'funky',
      runnableId: 'runnable',
      templateId: 'template',
      templateVersion: '1.0.0',
      payloadHash: 'hash',
      watermark: '2026-04-14T20:00:00.000Z',
      summary: {
        totalRowCount: 2,
        willSendCount: 2,
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
          executionData: {
            kind: 'test',
          },
        },
        {
          preview: {
            rowKey: 'row-2',
            userId: 'user-2',
            entityCui: '87654321',
            entityName: 'Municipiul Test',
            recordKey: 'record-2',
            interactionId: 'interaction-2',
            interactionLabel: 'Interaction 2',
            reviewStatus: 'approved',
            reviewedAt: '2026-04-14T19:30:00.000Z',
            status: 'will_send',
            reasonCode: 'eligible_now',
            statusMessage: 'Ready to send.',
            hasExistingDelivery: false,
            existingDeliveryStatus: null,
            sendMode: 'create',
          },
          executionData: {
            kind: 'test',
          },
        },
      ],
      createdAt: '2026-04-14T20:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      consumedAt: null,
    };

    const executeStoredRow = vi
      .fn()
      .mockResolvedValueOnce(ok({ outcome: 'enqueue_failed' as const }))
      .mockResolvedValueOnce(ok({ outcome: 'queued' as const }));
    const releasePlan = vi.fn(async () => ok(true));

    const result = await sendCampaignNotificationRunnablePlan(
      {
        planRepository: {
          async createPlan() {
            throw new Error('not used');
          },
          async findPlanById() {
            return ok(storedPlan);
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
              runnableId: 'runnable',
              campaignKey: 'funky' as const,
              templateId: 'template',
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
        planId: 'plan-2',
        actorUserId: 'admin-1',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        planId: 'plan-2',
        runnableId: 'runnable',
        templateId: 'template',
        evaluatedCount: 2,
        queuedCount: 1,
        alreadySentCount: 0,
        alreadyPendingCount: 0,
        ineligibleCount: 0,
        missingDataCount: 0,
        enqueueFailedCount: 1,
      });
    }
    expect(executeStoredRow).toHaveBeenCalledTimes(2);
    expect(releasePlan).not.toHaveBeenCalled();
  });
});
