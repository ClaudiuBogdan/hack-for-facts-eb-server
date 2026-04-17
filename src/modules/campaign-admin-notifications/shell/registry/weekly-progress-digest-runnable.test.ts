import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCampaignProvocariStepPath,
  getCampaignAdminInteractionConfig,
  getCampaignAdminReviewConfig,
  type LearningProgressRecordRow,
} from '@/modules/learning-progress/index.js';

import { makeWeeklyProgressDigestRunnableDefinition } from './weekly-progress-digest-runnable.js';
import {
  createTestDeliveryRecord,
  createTestInteractiveRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeLearningProgressRepo,
} from '../../../../../tests/fixtures/fakes.js';

const PLATFORM_BASE_URL = 'https://transparenta.eu';
const FIXED_NOW_ISO = '2026-04-19T20:59:59.999Z';
const FIXED_WEEK_KEY = '2026-W16';
const FIXED_PERIOD_LABEL = '13 aprilie - 19 aprilie';

function makeRow(userId: string, record: LearningProgressRecordRow['record'], updatedSeq: string) {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  } satisfies LearningProgressRecordRow;
}

function createBudgetDocumentRecord(
  overrides: Partial<LearningProgressRecordRow['record']> = {}
): LearningProgressRecordRow['record'] {
  return {
    ...createTestInteractiveRecord({
      key: 'funky:interaction:budget_document::entity:12345678',
      interactionId: 'funky:interaction:budget_document',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      scope: { type: 'entity', entityCui: '12345678' },
      phase: 'draft',
      updatedAt: '2026-04-15T08:00:00.000Z',
      value: {
        kind: 'json',
        json: {
          value: {
            documentUrl: 'https://example.invalid/budget.pdf',
          },
        },
      },
    }),
    ...overrides,
  };
}

function createGlobalNotification(userId = 'user-1') {
  return createTestNotification({
    id: `notif-global-${userId}`,
    userId,
    entityCui: null,
    notificationType: 'funky:notification:global',
    isActive: true,
  });
}

function makeDefinitionForUser(input: {
  userId?: string;
  records?: LearningProgressRecordRow[];
  deliveries?: ReturnType<typeof createTestDeliveryRecord>[];
  now?: () => Date;
}) {
  const userId = input.userId ?? 'user-1';

  return makeWeeklyProgressDigestRunnableDefinition({
    learningProgressRepo: makeFakeLearningProgressRepo({
      initialRecords: input.records === undefined ? new Map() : new Map([[userId, input.records]]),
    }),
    extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
      notifications: [createGlobalNotification(userId)],
    }),
    deliveryRepo: makeFakeDeliveryRepo(
      input.deliveries === undefined ? {} : { deliveries: input.deliveries }
    ),
    composeJobScheduler: {
      enqueue: vi.fn(async () => ok(undefined)),
    },
    entityRepo: {
      getById: vi.fn(async () =>
        ok({
          name: 'Municipiul Exemplu',
        })
      ),
    } as never,
    platformBaseUrl: PLATFORM_BASE_URL,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

function getCanonicalStepUrl(entityCui: string, interactionId: string): string {
  const campaignConfig = getCampaignAdminReviewConfig('funky');
  if (campaignConfig === null) {
    throw new Error('Missing Funky campaign config for weekly digest test.');
  }

  const interactionConfig = getCampaignAdminInteractionConfig(campaignConfig, interactionId);
  if (interactionConfig?.interactionStepLocation === null || interactionConfig === null) {
    throw new Error(`Missing step location for interaction "${interactionId}".`);
  }

  return new URL(
    buildCampaignProvocariStepPath(entityCui, interactionConfig.interactionStepLocation),
    PLATFORM_BASE_URL
  ).toString();
}

function getNotificationInput(executionData: Record<string, unknown> | null | undefined): {
  primaryCta: { url: string };
  secondaryCtas: { label: string; url: string }[];
  items: { actionLabel: string; actionUrl: string }[];
} | null {
  if (executionData === null || executionData === undefined) {
    return null;
  }

  const notificationInput = executionData['notificationInput'];
  if (typeof notificationInput !== 'object' || notificationInput === null) {
    return null;
  }

  return notificationInput as {
    primaryCta: { url: string };
    secondaryCtas: { label: string; url: string }[];
    items: { actionLabel: string; actionUrl: string }[];
  };
}

describe('weekly progress digest runnable', () => {
  it('dry run yields no sendable rows when no digest-worthy changes exist', async () => {
    const definition = makeWeeklyProgressDigestRunnableDefinition({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
        notifications: [
          createTestNotification({
            id: 'notif-global-1',
            userId: 'user-1',
            entityCui: null,
            notificationType: 'funky:notification:global',
            isActive: true,
          }),
        ],
      }),
      deliveryRepo: makeFakeDeliveryRepo(),
      composeJobScheduler: {
        enqueue: vi.fn(async () => ok(undefined)),
      },
      entityRepo: {
        getById: vi.fn(async () => ok(null)),
      } as never,
      platformBaseUrl: 'https://transparenta.eu',
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: {},
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary).toEqual({
        totalRowCount: 0,
        willSendCount: 0,
        alreadySentCount: 0,
        alreadyPendingCount: 0,
        ineligibleCount: 0,
        missingDataCount: 0,
      });
      expect(result.value.rows).toEqual([]);
    }
  });

  it('returns an explicit ineligible row for a selected user with changes but no active global preference', async () => {
    const record = createBudgetDocumentRecord();

    const definition = makeWeeklyProgressDigestRunnableDefinition({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([['user-2', [makeRow('user-2', record, '1')]]]),
      }),
      extendedNotificationsRepo: makeFakeExtendedNotificationsRepo(),
      deliveryRepo: makeFakeDeliveryRepo(),
      composeJobScheduler: {
        enqueue: vi.fn(async () => ok(undefined)),
      },
      entityRepo: {
        getById: vi.fn(async () =>
          ok({
            name: 'Municipiul Exemplu',
          })
        ),
      } as never,
      platformBaseUrl: PLATFORM_BASE_URL,
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-2' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary.ineligibleCount).toBe(1);
      expect(result.value.rows).toEqual([
        expect.objectContaining({
          preview: expect.objectContaining({
            userId: 'user-2',
            status: 'ineligible',
            reasonCode: 'missing_preference',
          }),
        }),
      ]);
    }
  });

  it('captures a single instant for week key, watermark, and period label', async () => {
    const record = createBudgetDocumentRecord();
    const now = vi.fn(() => new Date(FIXED_NOW_ISO));
    const definition = makeWeeklyProgressDigestRunnableDefinition({
      learningProgressRepo: makeFakeLearningProgressRepo({
        initialRecords: new Map([['user-1', [makeRow('user-1', record, '1')]]]),
      }),
      extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
        notifications: [
          createTestNotification({
            id: 'notif-global-1',
            userId: 'user-1',
            entityCui: null,
            notificationType: 'funky:notification:global',
            isActive: true,
          }),
        ],
      }),
      deliveryRepo: makeFakeDeliveryRepo(),
      composeJobScheduler: {
        enqueue: vi.fn(async () => ok(undefined)),
      },
      entityRepo: {
        getById: vi.fn(async () =>
          ok({
            name: 'Municipiul Exemplu',
          })
        ),
      } as never,
      platformBaseUrl: PLATFORM_BASE_URL,
      now,
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-1' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    expect(now).toHaveBeenCalledTimes(1);
    if (result.isOk()) {
      expect(result.value.watermark).toBe(FIXED_NOW_ISO);
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toEqual(
        expect.objectContaining({
          executionData: {
            kind: 'weekly_progress_digest',
            notificationInput: expect.objectContaining({
              weekKey: FIXED_WEEK_KEY,
              periodLabel: FIXED_PERIOD_LABEL,
              watermarkAt: FIXED_NOW_ISO,
            }),
          },
        })
      );
    }
  });

  it('canonicalizes digest CTA URLs and strips sourceUrl query/hash state before freezing metadata', async () => {
    const entityCui = '12345678';
    const budgetDocumentUrl = getCanonicalStepUrl(entityCui, 'funky:interaction:budget_document');
    const debateRequestUrl = getCanonicalStepUrl(
      entityCui,
      'funky:interaction:public_debate_request'
    );

    const definition = makeDefinitionForUser({
      records: [
        makeRow(
          'user-1',
          createBudgetDocumentRecord({
            sourceUrl: `${budgetDocumentUrl}?next=https://evil.example#steal-session`,
          }),
          '1'
        ),
        makeRow(
          'user-1',
          {
            ...createTestInteractiveRecord({
              key: 'funky:interaction:public_debate_request::entity:12345678',
              interactionId: 'funky:interaction:public_debate_request',
              lessonId: 'civic-monitor-and-request',
              kind: 'custom',
              completionRule: { type: 'resolved' },
              scope: { type: 'entity', entityCui },
              phase: 'draft',
              updatedAt: '2026-04-15T07:00:00.000Z',
              value: {
                kind: 'json',
                json: {
                  value: {
                    text: 'Cerere salvată',
                  },
                },
              },
            }),
            sourceUrl: `${debateRequestUrl}?draft=open#keep-going`,
          },
          '2'
        ),
      ],
      now: () => new Date(FIXED_NOW_ISO),
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-1' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const notificationInput = getNotificationInput(result.value.rows[0]?.executionData);
      expect(notificationInput).not.toBeNull();

      if (notificationInput !== null) {
        expect(notificationInput.primaryCta.url).toBe(budgetDocumentUrl);
        expect(notificationInput.secondaryCtas).toEqual([
          {
            label: 'Continuă Public debate request',
            url: debateRequestUrl,
          },
        ]);
        expect(
          notificationInput.items.map((item) => ({
            actionUrl: item.actionUrl,
            actionLabel: item.actionLabel,
          }))
        ).toEqual([
          {
            actionUrl: budgetDocumentUrl,
            actionLabel: 'Continuă Budget document',
          },
          {
            actionUrl: debateRequestUrl,
            actionLabel: 'Continuă Public debate request',
          },
        ]);

        for (const url of [
          notificationInput.primaryCta.url,
          ...notificationInput.secondaryCtas.map((cta) => cta.url),
          ...notificationInput.items.map((item) => item.actionUrl),
        ]) {
          expect(url).not.toContain('?');
          expect(url).not.toContain('#');
        }
      }
    }
  });

  it('shows an existing_pending preview when the same week digest is already queued', async () => {
    const definition = makeDefinitionForUser({
      records: [makeRow('user-1', createBudgetDocumentRecord(), '1')],
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-weekly-pending',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-user-1',
          scopeKey: `digest:weekly_progress:funky:${FIXED_WEEK_KEY}`,
          deliveryKey: `digest:weekly_progress:funky:user-1:${FIXED_WEEK_KEY}`,
          status: 'pending',
          metadata: {},
        }),
      ],
      now: () => new Date(FIXED_NOW_ISO),
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-1' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary).toEqual({
        totalRowCount: 1,
        willSendCount: 0,
        alreadySentCount: 0,
        alreadyPendingCount: 1,
        ineligibleCount: 0,
        missingDataCount: 0,
      });
      expect(result.value.rows).toEqual([
        expect.objectContaining({
          preview: expect.objectContaining({
            userId: 'user-1',
            status: 'already_pending',
            reasonCode: 'existing_pending',
            hasExistingDelivery: true,
            existingDeliveryStatus: 'pending',
          }),
          executionData: null,
        }),
      ]);
    }
  });

  it('shows an existing_sent preview when the same week digest was already delivered', async () => {
    const definition = makeDefinitionForUser({
      records: [makeRow('user-1', createBudgetDocumentRecord(), '1')],
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-weekly-sent',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-user-1',
          scopeKey: `digest:weekly_progress:funky:${FIXED_WEEK_KEY}`,
          deliveryKey: `digest:weekly_progress:funky:user-1:${FIXED_WEEK_KEY}`,
          status: 'delivered',
          metadata: {},
        }),
      ],
      now: () => new Date(FIXED_NOW_ISO),
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-1' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary).toEqual({
        totalRowCount: 1,
        willSendCount: 0,
        alreadySentCount: 1,
        alreadyPendingCount: 0,
        ineligibleCount: 0,
        missingDataCount: 0,
      });
      expect(result.value.rows).toEqual([
        expect.objectContaining({
          preview: expect.objectContaining({
            userId: 'user-1',
            status: 'already_sent',
            reasonCode: 'existing_sent',
            hasExistingDelivery: true,
            existingDeliveryStatus: 'delivered',
          }),
          executionData: null,
        }),
      ]);
    }
  });

  it('shows an invalid_existing_snapshot preview when replayable weekly metadata cannot be loaded safely', async () => {
    const definition = makeDefinitionForUser({
      records: [makeRow('user-1', createBudgetDocumentRecord(), '1')],
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-weekly-invalid-snapshot',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-user-1',
          scopeKey: `digest:weekly_progress:funky:${FIXED_WEEK_KEY}`,
          deliveryKey: `digest:weekly_progress:funky:user-1:${FIXED_WEEK_KEY}`,
          status: 'skipped_unsubscribed',
          metadata: {
            digestType: 'weekly_progress_digest',
            campaignKey: 'funky',
          },
        }),
      ],
      now: () => new Date(FIXED_NOW_ISO),
    });

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { userId: 'user-1' },
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary).toEqual({
        totalRowCount: 1,
        willSendCount: 0,
        alreadySentCount: 0,
        alreadyPendingCount: 0,
        ineligibleCount: 0,
        missingDataCount: 1,
      });
      expect(result.value.rows).toEqual([
        expect.objectContaining({
          preview: expect.objectContaining({
            userId: 'user-1',
            status: 'missing_data',
            reasonCode: 'invalid_existing_snapshot',
            hasExistingDelivery: true,
            existingDeliveryStatus: 'skipped_unsubscribed',
          }),
          executionData: null,
        }),
      ]);
    }
  });
});
