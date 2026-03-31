import { describe, expect, it, vi } from 'vitest';

import { createLearningProgressUserEventSyncHook } from '@/modules/user-events/index.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
} from '../../fixtures/fakes.js';

function createLoggerSpy() {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  logger.child.mockReturnValue(logger);

  return logger;
}

describe('createLearningProgressUserEventSyncHook', () => {
  it('short-circuits when there are no applied events to publish', async () => {
    const publishMany = vi.fn(async () => undefined);
    const hook = createLearningProgressUserEventSyncHook({
      publisher: {
        publish: vi.fn(async () => undefined),
        publishMany,
      },
      logger: createLoggerSpy() as never,
    });

    await hook({
      userId: 'user-1',
      events: [],
    });

    expect(publishMany).not.toHaveBeenCalled();
  });

  it('builds lean queue payloads for applied learning progress events', async () => {
    const publishMany = vi.fn(async () => undefined);
    const logger = createLoggerSpy();
    const hook = createLearningProgressUserEventSyncHook({
      publisher: {
        publish: vi.fn(async () => undefined),
        publishMany,
      },
      logger: logger as never,
    });
    const interactiveRecord = createTestInteractiveRecord({
      key: 'campaign:debate-request::entity:12345678',
      updatedAt: '2026-03-31T09:00:00.000Z',
    });

    await hook({
      userId: 'user-1',
      events: [
        createTestInteractiveUpdatedEvent({
          eventId: 'event-interactive',
          occurredAt: interactiveRecord.updatedAt,
          payload: {
            record: interactiveRecord,
          },
        }),
        createTestProgressResetEvent({
          eventId: 'event-reset',
          occurredAt: '2026-03-31T09:05:00.000Z',
        }),
      ],
    });

    expect(publishMany).toHaveBeenCalledTimes(1);
    expect(publishMany).toHaveBeenCalledWith([
      {
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-interactive',
        eventType: 'interactive.updated',
        occurredAt: '2026-03-31T09:00:00.000Z',
        recordKey: 'campaign:debate-request::entity:12345678',
      },
      {
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-reset',
        eventType: 'progress.reset',
        occurredAt: '2026-03-31T09:05:00.000Z',
      },
    ]);
  });

  it('bubbles publisher failures to the caller', async () => {
    const hook = createLearningProgressUserEventSyncHook({
      publisher: {
        publish: vi.fn(async () => undefined),
        publishMany: vi.fn(async () => {
          throw new Error('queue unavailable');
        }),
      },
      logger: createLoggerSpy() as never,
    });

    await expect(
      hook({
        userId: 'user-1',
        events: [createTestProgressResetEvent({ eventId: 'event-reset' })],
      })
    ).rejects.toThrow('queue unavailable');
  });
});
