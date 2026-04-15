import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { getWeeklyDigestCursor } from '@/modules/learning-progress/index.js';
import {
  createWeeklyProgressDigestPostSendReconciler,
  type WeeklyProgressDigestOutboxMetadata,
} from '@/modules/notification-delivery/index.js';

import { makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';

const testLogger = pinoLogger({ level: 'silent' });

const baseMetadata: WeeklyProgressDigestOutboxMetadata = {
  digestType: 'weekly_progress_digest',
  campaignKey: 'funky',
  userId: 'user-1',
  weekKey: '2026-W16',
  periodLabel: '7 aprilie - 13 aprilie',
  watermarkAt: '2026-04-15T09:00:00.000Z',
  summary: {
    totalItemCount: 1,
    visibleItemCount: 1,
    hiddenItemCount: 0,
    actionNowCount: 1,
    approvedCount: 0,
    rejectedCount: 1,
    pendingCount: 0,
    draftCount: 0,
    failedCount: 0,
  },
  items: [
    {
      itemKey: 'item-1',
      interactionId: 'funky:interaction:budget_document',
      interactionLabel: 'Documentul de buget',
      entityName: 'Municipiul Exemplu',
      statusLabel: 'Mai are nevoie de o corectură',
      statusTone: 'danger',
      title: 'Documentul de buget trebuie corectat',
      description: 'Am găsit o problemă care te împiedică să mergi mai departe.',
      updatedAt: '2026-04-15T08:00:00.000Z',
      feedbackSnippet: 'Fișierul trimis nu conține proiectul complet.',
      actionLabel: 'Corectează documentul',
      actionUrl: 'https://transparenta.eu/cta/document',
    },
  ],
  primaryCta: {
    label: 'Corectează documentul',
    url: 'https://transparenta.eu/cta/document',
  },
  secondaryCtas: [],
  allUpdatesUrl: null,
};

describe('weekly progress digest post-send reconciler', () => {
  it('writes the weekly digest cursor after a successful send', async () => {
    const repo = makeFakeLearningProgressRepo();
    const reconciler = createWeeklyProgressDigestPostSendReconciler({
      learningProgressRepo: repo,
      logger: testLogger,
    });

    const result = await reconciler.reconcile({
      outboxId: 'outbox-1',
      userId: 'user-1',
      sentAt: new Date('2026-04-15T09:05:00.000Z'),
      metadata: baseMetadata,
    });

    expect(result.isOk()).toBe(true);

    const cursor = await getWeeklyDigestCursor({ repo }, { userId: 'user-1' });
    expect(cursor.isOk()).toBe(true);
    if (cursor.isOk()) {
      expect(cursor.value).toEqual({
        campaignKey: 'funky',
        lastSentAt: '2026-04-15T09:05:00.000Z',
        watermarkAt: baseMetadata.watermarkAt,
        weekKey: baseMetadata.weekKey,
        outboxId: 'outbox-1',
      });
    }
  });

  it('does not regress an existing newer watermark', async () => {
    const repo = makeFakeLearningProgressRepo();
    const reconciler = createWeeklyProgressDigestPostSendReconciler({
      learningProgressRepo: repo,
      logger: testLogger,
    });

    const firstResult = await reconciler.reconcile({
      outboxId: 'outbox-newer',
      userId: 'user-1',
      sentAt: new Date('2026-04-22T09:05:00.000Z'),
      metadata: {
        ...baseMetadata,
        weekKey: '2026-W17',
        watermarkAt: '2026-04-22T09:00:00.000Z',
      },
    });
    expect(firstResult.isOk()).toBe(true);

    const secondResult = await reconciler.reconcile({
      outboxId: 'outbox-older',
      userId: 'user-1',
      sentAt: new Date('2026-04-15T09:05:00.000Z'),
      metadata: baseMetadata,
    });
    expect(secondResult.isOk()).toBe(true);

    const cursor = await getWeeklyDigestCursor({ repo }, { userId: 'user-1' });
    expect(cursor.isOk()).toBe(true);
    if (cursor.isOk()) {
      expect(cursor.value).toEqual({
        campaignKey: 'funky',
        lastSentAt: '2026-04-22T09:05:00.000Z',
        watermarkAt: '2026-04-22T09:00:00.000Z',
        weekKey: '2026-W17',
        outboxId: 'outbox-newer',
      });
    }
  });
});
