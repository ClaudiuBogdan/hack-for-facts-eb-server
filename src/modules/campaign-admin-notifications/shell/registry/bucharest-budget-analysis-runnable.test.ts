import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
  buildBucharestBudgetAnalysisDeliveryKey,
  buildBucharestBudgetAnalysisScopeKey,
} from '@/modules/notification-delivery/index.js';

import { makeBucharestBudgetAnalysisRunnableDefinition } from './bucharest-budget-analysis-runnable.js';
import {
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeLearningProgressRepo,
} from '../../../../../tests/fixtures/fakes.js';

function makeDefinition() {
  return makeBucharestBudgetAnalysisRunnableDefinition({
    learningProgressRepo: makeFakeLearningProgressRepo(),
    extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-bucharest',
          userId: 'user-bucharest',
          entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
          notificationType: 'funky:notification:entity_updates',
          isActive: true,
        }),
        createTestNotification({
          id: 'notification-other',
          userId: 'user-other',
          entityCui: '12345678',
          notificationType: 'funky:notification:entity_updates',
          isActive: true,
        }),
      ],
    }),
    deliveryRepo: makeFakeDeliveryRepo(),
    composeJobScheduler: {
      enqueue: vi.fn(async () => ok(undefined)),
    },
    entityRepo: {
      getById: vi.fn(),
      getByIds: vi.fn(),
    } as never,
    platformBaseUrl: 'https://transparenta.eu',
  });
}

describe('bucharest budget analysis runnable', () => {
  it('dry run only plans subscribers to Bucharest CUI', async () => {
    const definition = makeDefinition();

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: {},
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary.willSendCount).toBe(1);
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]?.preview).toMatchObject({
        userId: 'user-bucharest',
        entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
        interactionId: 'bucharest_budget_analysis',
        status: 'will_send',
        sendMode: 'create',
      });
    }
  });

  it('rejects non-Bucharest CUI selectors', async () => {
    const definition = makeDefinition();

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: { entityCui: '12345678' },
      filters: {},
    });

    expect(result.isErr()).toBe(true);
  });

  it('executeStoredRow enqueues the Bucharest analysis outbox row', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const enqueue = vi.fn(async () => ok(undefined));
    const definition = makeBucharestBudgetAnalysisRunnableDefinition({
      learningProgressRepo: makeFakeLearningProgressRepo(),
      extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
        notifications: [
          createTestNotification({
            id: 'notification-bucharest',
            userId: 'user-bucharest',
            entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
            notificationType: 'funky:notification:entity_updates',
            isActive: true,
          }),
        ],
      }),
      deliveryRepo,
      composeJobScheduler: { enqueue },
      entityRepo: {
        getById: vi.fn(),
        getByIds: vi.fn(),
      } as never,
      platformBaseUrl: 'https://transparenta.eu',
    });

    const dryRunResult = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: {},
      filters: {},
    });

    expect(dryRunResult.isOk()).toBe(true);
    if (dryRunResult.isErr()) {
      return;
    }

    const row = dryRunResult.value.rows[0];
    if (row === undefined) {
      throw new Error('Expected a stored row in test setup.');
    }

    const result = await definition.executeStoredRow({
      actorUserId: 'admin-1',
      row,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: 'queued' });
    expect(enqueue).toHaveBeenCalledTimes(1);

    const executionData = row.executionData;
    if (executionData === null || typeof executionData['analysisFingerprint'] !== 'string') {
      throw new Error('Expected analysis fingerprint in stored row.');
    }
    const scopeKey = buildBucharestBudgetAnalysisScopeKey(executionData['analysisFingerprint']);
    expect(scopeKey).toContain(BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI);
    const deliveryKey = buildBucharestBudgetAnalysisDeliveryKey({
      userId: 'user-bucharest',
      analysisFingerprint: executionData['analysisFingerprint'],
    });
    const storedDeliveryResult = await deliveryRepo.findByDeliveryKey(deliveryKey);

    expect(storedDeliveryResult.isOk()).toBe(true);
    if (storedDeliveryResult.isOk()) {
      expect(storedDeliveryResult.value?.notificationType).toBe(
        'funky:outbox:bucharest_budget_analysis'
      );
    }
  });
});
