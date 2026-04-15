import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { makeWeeklyProgressDigestRunnableDefinition } from './weekly-progress-digest-runnable.js';
import {
  createTestInteractiveRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeLearningProgressRepo,
} from '../../../../../tests/fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

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
    const record = createTestInteractiveRecord({
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
    });

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
      platformBaseUrl: 'https://transparenta.eu',
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
    const record = createTestInteractiveRecord({
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
    });
    const now = vi.fn(() => new Date('2026-04-19T20:59:59.999Z'));
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
      platformBaseUrl: 'https://transparenta.eu',
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
      expect(result.value.watermark).toBe('2026-04-19T20:59:59.999Z');
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toEqual(
        expect.objectContaining({
          executionData: {
            kind: 'weekly_progress_digest',
            notificationInput: expect.objectContaining({
              weekKey: '2026-W16',
              periodLabel: '13 aprilie - 19 aprilie',
              watermarkAt: '2026-04-19T20:59:59.999Z',
            }),
          },
        })
      );
    }
  });
});
