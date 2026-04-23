import { ok } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaignEntityConfigRecord } from '@/modules/campaign-entity-config/core/config-record.js';

import { makePublicDebateAnnouncementRunnableDefinition } from './public-debate-announcement-runnable.js';
import {
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
  makeFakeLearningProgressRepo,
} from '../../../../../tests/fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

function makeConfigRow(input: {
  entityCui: string;
  updatedAt: string;
  date: string;
  time: string;
  location: string;
}): LearningProgressRecordRow {
  const record = createCampaignEntityConfigRecord({
    campaignKey: 'funky',
    entityCui: input.entityCui,
    values: {
      budgetPublicationDate: null,
      officialBudgetUrl: 'https://example.com/budget.pdf',
      public_debate: {
        date: input.date,
        time: input.time,
        location: input.location,
        announcement_link: 'https://example.com/public-debate',
      },
    },
    actorUserId: 'admin-1',
    recordUpdatedAt: input.updatedAt,
  });

  return {
    userId: 'internal:campaign-config:funky',
    recordKey: `internal:entity-config::${input.entityCui}`,
    record,
    auditEvents: [],
    updatedSeq: '1',
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
}

function makeDefinition(rows: LearningProgressRecordRow[]) {
  return makePublicDebateAnnouncementRunnableDefinition({
    learningProgressRepo: makeFakeLearningProgressRepo({
      initialRecords: new Map([['internal:campaign-config:funky', rows]]),
    }),
    extendedNotificationsRepo: makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
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
      getById: vi.fn(async () =>
        ok({
          cui: '12345678',
          name: 'Municipiul Exemplu',
        })
      ),
      getByIds: vi.fn(async () =>
        ok(
          new Map([
            [
              '12345678',
              {
                cui: '12345678',
                name: 'Municipiul Exemplu',
              },
            ],
          ])
        )
      ),
    } as never,
    platformBaseUrl: 'https://transparenta.eu',
  });
}

describe('public debate announcement runnable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dry run yields will_send rows for configured public debates', async () => {
    const definition = makeDefinition([
      makeConfigRow({
        entityCui: '12345678',
        updatedAt: '2026-05-01T12:00:00.000Z',
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
      }),
    ]);

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: {},
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary.willSendCount).toBe(1);
      expect(result.value.rows[0]?.preview).toMatchObject({
        userId: 'user-1',
        entityCui: '12345678',
        interactionId: 'public_debate_announcement',
        status: 'will_send',
        sendMode: 'create',
      });
    }
  });

  it('dry run excludes debates that are not strictly after the trigger time', async () => {
    vi.setSystemTime(new Date('2026-05-10T15:00:00.000Z'));
    const definition = makeDefinition([
      makeConfigRow({
        entityCui: '12345678',
        updatedAt: '2026-05-01T12:00:00.000Z',
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
      }),
    ]);

    const result = await definition.dryRun({
      actorUserId: 'admin-1',
      selectors: {},
      filters: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.summary.totalRowCount).toBe(0);
      expect(result.value.rows).toEqual([]);
    }
  });

  it('executeStoredRow skips when the debate has already taken place after planning', async () => {
    const definition = makeDefinition([
      makeConfigRow({
        entityCui: '12345678',
        updatedAt: '2026-05-01T12:00:00.000Z',
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
      }),
    ]);

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

    vi.setSystemTime(new Date('2026-05-10T15:01:00.000Z'));
    const result = await definition.executeStoredRow({
      actorUserId: 'admin-1',
      row,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      outcome: 'ineligible',
    });
  });

  it('treats changed public_debate payloads as missing_data on send', async () => {
    const initialDefinition = makeDefinition([
      makeConfigRow({
        entityCui: '12345678',
        updatedAt: '2026-05-01T12:00:00.000Z',
        date: '2026-05-10',
        time: '18:00',
        location: 'Council Hall',
      }),
    ]);

    const dryRunResult = await initialDefinition.dryRun({
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

    const updatedDefinition = makeDefinition([
      makeConfigRow({
        entityCui: '12345678',
        updatedAt: '2026-05-02T12:00:00.000Z',
        date: '2026-05-11',
        time: '18:00',
        location: 'Council Hall',
      }),
    ]);

    const result = await updatedDefinition.executeStoredRow({
      actorUserId: 'admin-1',
      row,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      outcome: 'missing_data',
    });
  });
});
