import { Type } from '@sinclair/typebox';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { executeCampaignNotificationTriggerBulk } from '@/modules/campaign-admin-notifications/index.js';

describe('executeCampaignNotificationTriggerBulk', () => {
  it('returns NotFoundError for an unknown trigger', async () => {
    const result = await executeCampaignNotificationTriggerBulk(
      {
        triggerRegistry: {
          list() {
            return [];
          },
          get() {
            return null;
          },
        },
      },
      {
        campaignKey: 'funky',
        triggerId: 'missing',
        actorUserId: 'admin-1',
        payload: {},
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NotFoundError');
    }
  });

  it('returns ValidationError when the trigger does not support bulk execution', async () => {
    const result = await executeCampaignNotificationTriggerBulk(
      {
        triggerRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              triggerId: 'single-only',
              campaignKey: 'funky' as const,
              templateId: 'template',
              description: 'single only',
              inputSchema: Type.Object({}, { additionalProperties: false }),
              inputFields: [],
              targetKind: 'user',
              async execute() {
                throw new Error('not used');
              },
            };
          },
        },
      },
      {
        campaignKey: 'funky',
        triggerId: 'single-only',
        actorUserId: 'admin-1',
        payload: {},
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
  });

  it('returns ValidationError for an invalid bulk payload', async () => {
    const executeBulk = vi.fn(async () =>
      ok({
        kind: 'family_bulk' as const,
        familyId: 'family',
        dryRun: true,
        watermark: '2026-04-13T12:00:00.000Z',
        limit: 10,
        hasMoreCandidates: false,
        candidateCount: 0,
        plannedCount: 0,
        eligibleCount: 0,
        queuedCount: 0,
        reusedCount: 0,
        skippedCount: 0,
        delegatedCount: 0,
        ineligibleCount: 0,
        notReplayableCount: 0,
        staleCount: 0,
        enqueueFailedCount: 0,
      })
    );

    const result = await executeCampaignNotificationTriggerBulk(
      {
        triggerRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              triggerId: 'bulk',
              campaignKey: 'funky' as const,
              templateId: 'template',
              description: 'bulk',
              inputSchema: Type.Object({}, { additionalProperties: false }),
              inputFields: [],
              targetKind: 'user',
              bulkInputSchema: Type.Object(
                {
                  filters: Type.Object(
                    {
                      userId: Type.String({ minLength: 1 }),
                    },
                    { additionalProperties: false }
                  ),
                },
                { additionalProperties: false }
              ),
              async execute() {
                throw new Error('not used');
              },
              executeBulk,
            };
          },
        },
      },
      {
        campaignKey: 'funky',
        triggerId: 'bulk',
        actorUserId: 'admin-1',
        payload: {
          filters: {
            userId: '',
          },
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
    expect(executeBulk).not.toHaveBeenCalled();
  });

  it('delegates to executeBulk for a valid payload', async () => {
    const executeBulk = vi.fn(async () =>
      ok({
        kind: 'family_bulk' as const,
        familyId: 'family',
        dryRun: true,
        watermark: '2026-04-13T12:00:00.000Z',
        limit: 10,
        hasMoreCandidates: false,
        candidateCount: 1,
        plannedCount: 1,
        eligibleCount: 1,
        queuedCount: 1,
        reusedCount: 0,
        skippedCount: 0,
        delegatedCount: 0,
        ineligibleCount: 0,
        notReplayableCount: 0,
        staleCount: 0,
        enqueueFailedCount: 0,
      })
    );

    const payload = {
      filters: {
        userId: 'user-1',
      },
    };

    const result = await executeCampaignNotificationTriggerBulk(
      {
        triggerRegistry: {
          list() {
            return [];
          },
          get() {
            return {
              triggerId: 'bulk',
              campaignKey: 'funky' as const,
              templateId: 'template',
              description: 'bulk',
              inputSchema: Type.Object({}, { additionalProperties: false }),
              inputFields: [],
              targetKind: 'user',
              bulkInputSchema: Type.Object(
                {
                  filters: Type.Object(
                    {
                      userId: Type.String({ minLength: 1 }),
                    },
                    { additionalProperties: false }
                  ),
                },
                { additionalProperties: false }
              ),
              async execute() {
                throw new Error('not used');
              },
              executeBulk,
            };
          },
        },
      },
      {
        campaignKey: 'funky',
        triggerId: 'bulk',
        actorUserId: 'admin-1',
        payload,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(executeBulk).toHaveBeenCalledWith({
      campaignKey: 'funky',
      triggerId: 'bulk',
      actorUserId: 'admin-1',
      payload,
    });
  });
});
