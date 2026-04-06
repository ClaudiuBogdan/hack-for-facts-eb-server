import { describe, expect, it, vi } from 'vitest';

import { buildBullmqJobId } from '@/infra/queue/job-id.js';
import {
  buildLearningProgressUserEventJobs,
  makeUserEventPublisher,
} from '@/modules/user-events/index.js';

import {
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
} from '../../fixtures/fakes.js';

describe('makeUserEventPublisher', () => {
  it('publishes a single user-event job with source-derived id and retry config', async () => {
    const add = vi.fn(async () => undefined);
    const publisher = makeUserEventPublisher({
      userEventQueue: {
        add,
        addBulk: vi.fn(async () => []),
      } as never,
    });

    await publisher.publish({
      source: 'learning_progress',
      userId: 'user-1',
      eventId: 'event-single',
      eventType: 'progress.reset',
      occurredAt: '2026-03-31T10:05:00.000Z',
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'user-event',
      expect.objectContaining({
        source: 'learning_progress',
        eventId: 'event-single',
      }),
      expect.objectContaining({
        jobId: buildBullmqJobId('learning-progress', 'user-1', 'event-single'),
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          count: 500,
        },
      })
    );
  });

  it('publishes one queue job per learning progress event with deterministic job ids', async () => {
    const add = vi.fn(async () => undefined);
    const addBulk = vi.fn(async () => []);
    const publisher = makeUserEventPublisher({
      userEventQueue: {
        add,
        addBulk,
      } as never,
    });
    const jobs = buildLearningProgressUserEventJobs('user-1', [
      createTestInteractiveUpdatedEvent({
        eventId: 'event-interactive',
      }),
      createTestProgressResetEvent({
        eventId: 'event-reset',
        occurredAt: '2026-03-31T10:05:00.000Z',
      }),
    ]);

    await publisher.publishMany(jobs);

    expect(add).not.toHaveBeenCalled();
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'user-event',
        data: expect.objectContaining({
          userId: 'user-1',
          eventId: 'event-interactive',
          eventType: 'interactive.updated',
        }),
        opts: expect.objectContaining({
          jobId: buildBullmqJobId('learning-progress', 'user-1', 'event-interactive'),
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: {
            count: 500,
          },
        }),
      }),
      expect.objectContaining({
        name: 'user-event',
        data: expect.objectContaining({
          userId: 'user-1',
          eventId: 'event-reset',
          eventType: 'progress.reset',
        }),
        opts: expect.objectContaining({
          jobId: buildBullmqJobId('learning-progress', 'user-1', 'event-reset'),
          attempts: 3,
          removeOnComplete: true,
          removeOnFail: {
            count: 500,
          },
        }),
      }),
    ]);
  });

  it('encodes user ids and event ids before building BullMQ job ids', async () => {
    const add = vi.fn(async () => undefined);
    const publisher = makeUserEventPublisher({
      userEventQueue: {
        add,
        addBulk: vi.fn(async () => []),
      } as never,
    });

    await publisher.publish({
      source: 'learning_progress',
      userId: 'user:unsafe',
      eventId: 'event:unsafe',
      eventType: 'progress.reset',
      occurredAt: '2026-03-31T10:05:00.000Z',
    });

    expect(add).toHaveBeenCalledWith(
      'user-event',
      expect.any(Object),
      expect.objectContaining({
        jobId: buildBullmqJobId('learning-progress', 'user:unsafe', 'event:unsafe'),
      })
    );
  });
});
