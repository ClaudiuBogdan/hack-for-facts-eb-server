import { UnrecoverableError } from 'bullmq';
import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { processUserEventJob } from '@/modules/user-events/index.js';

describe('processUserEventJob', () => {
  it('returns handled status when a matched handler succeeds', async () => {
    const result = await processUserEventJob(
      {
        handlers: [
          {
            name: 'handled',
            matches: () => true,
            async handle() {
              return undefined;
            },
          },
        ],
        logger: pinoLogger({ level: 'silent' }),
      },
      {
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'progress.reset',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result).toEqual({
      status: 'handled',
      matchedHandlerNames: ['handled'],
    });
  });

  it('completes successfully when no handler matches', async () => {
    const result = await processUserEventJob(
      {
        handlers: [
          {
            name: 'never',
            matches: () => false,
            async handle() {
              throw new Error('should not run');
            },
          },
        ],
        logger: pinoLogger({ level: 'silent' }),
      },
      {
        source: 'learning_progress',
        userId: 'user-1',
        eventId: 'event-1',
        eventType: 'progress.reset',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result).toEqual({
      status: 'skipped_unmatched',
      matchedHandlerNames: [],
    });
  });

  it('rejects invalid timestamps with UnrecoverableError', async () => {
    await expect(
      processUserEventJob(
        {
          handlers: [],
          logger: pinoLogger({ level: 'silent' }),
        },
        {
          source: 'learning_progress',
          userId: 'user-1',
          eventId: 'event-1',
          eventType: 'progress.reset',
          occurredAt: 'not-a-timestamp',
        }
      )
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws when a matched handler fails so BullMQ can retry', async () => {
    await expect(
      processUserEventJob(
        {
          handlers: [
            {
              name: 'broken',
              matches: () => true,
              async handle() {
                throw new Error('boom');
              },
            },
          ],
          logger: pinoLogger({ level: 'silent' }),
        },
        {
          source: 'learning_progress',
          userId: 'user-1',
          eventId: 'event-1',
          eventType: 'progress.reset',
          occurredAt: '2026-03-31T10:00:00.000Z',
        }
      )
    ).rejects.toThrow('boom');
  });

  it('attempts all matched handlers before rethrowing a single failure', async () => {
    const calls: string[] = [];

    await expect(
      processUserEventJob(
        {
          handlers: [
            {
              name: 'first',
              matches: () => true,
              async handle() {
                calls.push('first');
                throw new Error('boom');
              },
            },
            {
              name: 'second',
              matches: () => true,
              async handle() {
                calls.push('second');
              },
            },
          ],
          logger: pinoLogger({ level: 'silent' }),
        },
        {
          source: 'learning_progress',
          userId: 'user-1',
          eventId: 'event-1',
          eventType: 'progress.reset',
          occurredAt: '2026-03-31T10:00:00.000Z',
        }
      )
    ).rejects.toThrow('boom');

    expect(calls).toEqual(['first', 'second']);
  });

  it('aggregates multiple matched handler failures', async () => {
    await expect(
      processUserEventJob(
        {
          handlers: [
            {
              name: 'first',
              matches: () => true,
              async handle() {
                throw new Error('boom-1');
              },
            },
            {
              name: 'second',
              matches: () => true,
              async handle() {
                throw new Error('boom-2');
              },
            },
          ],
          logger: pinoLogger({ level: 'silent' }),
        },
        {
          source: 'learning_progress',
          userId: 'user-1',
          eventId: 'event-1',
          eventType: 'progress.reset',
          occurredAt: '2026-03-31T10:00:00.000Z',
        }
      )
    ).rejects.toBeInstanceOf(AggregateError);
  });
});
