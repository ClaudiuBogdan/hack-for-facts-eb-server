import { ok, err } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  makeClerkUserDeletedAnonymizationHandler,
  type ClerkWebhookEvent,
  type UserDataAnonymizer,
  type UserDataAnonymizationSummary,
} from '@/modules/clerk-webhooks/index.js';

const logger = pinoLogger({ level: 'silent' });

const summary: UserDataAnonymizationSummary = {
  anonymizedUserId: 'deleted-user:abc123',
  shortLinksDeleted: 0,
  shortLinksUpdated: 0,
  notificationsUpdated: 1,
  outboxRowsUpdated: 1,
  userInteractionsUpdated: 1,
  userInteractionConflictsDeleted: 0,
  campaignRunPlansDeleted: 0,
  institutionThreadsUpdated: 0,
  resendWebhookEventsUpdated: 0,
  advancedMapRowsUpdated: 0,
  advancedMapSnapshotsUpdated: 0,
  advancedDatasetRowsUpdated: 0,
  advancedDatasetValueRowsDeleted: 0,
};

const createEvent = (overrides: Partial<ClerkWebhookEvent> = {}): ClerkWebhookEvent => ({
  data: {
    id: 'user_123',
  },
  object: 'event',
  type: 'user.deleted',
  timestamp: 1_654_012_591_835,
  instance_id: 'ins_123',
  ...overrides,
});

describe('makeClerkUserDeletedAnonymizationHandler', () => {
  it('anonymizes all user data for Clerk user.deleted events', async () => {
    const anonymizeDeletedUser = vi.fn(async () => ok(summary));
    const handler = makeClerkUserDeletedAnonymizationHandler({
      userDataAnonymizer: { anonymizeDeletedUser },
      logger,
    });

    await handler({ event: createEvent(), svixId: 'msg_1' });

    expect(anonymizeDeletedUser).toHaveBeenCalledWith({
      userId: 'user_123',
      svixId: 'msg_1',
      eventType: 'user.deleted',
      eventTimestamp: 1_654_012_591_835,
    });
  });

  it('does nothing for non-delete Clerk events', async () => {
    const anonymizeDeletedUser = vi.fn();
    const handler = makeClerkUserDeletedAnonymizationHandler({
      userDataAnonymizer: { anonymizeDeletedUser },
      logger,
    });

    await handler({ event: createEvent({ type: 'user.created' }), svixId: 'msg_1' });

    expect(anonymizeDeletedUser).not.toHaveBeenCalled();
  });

  it('fails when a Clerk user.deleted event has no usable user id', async () => {
    const anonymizeDeletedUser = vi.fn();
    const handler = makeClerkUserDeletedAnonymizationHandler({
      userDataAnonymizer: { anonymizeDeletedUser },
      logger,
    });

    await expect(
      handler({ event: createEvent({ data: { id: '   ' } }), svixId: 'msg_1' })
    ).rejects.toThrow('Clerk user.deleted webhook is missing a usable data.id');
    expect(anonymizeDeletedUser).not.toHaveBeenCalled();
  });

  it('fails when anonymization cannot be persisted', async () => {
    const anonymizer: UserDataAnonymizer = {
      anonymizeDeletedUser: async () =>
        err({
          type: 'DatabaseError',
          message: 'Simulated database error',
          retryable: true,
        }),
    };
    const handler = makeClerkUserDeletedAnonymizationHandler({
      userDataAnonymizer: anonymizer,
      logger,
    });

    await expect(handler({ event: createEvent(), svixId: 'msg_1' })).rejects.toThrow(
      'Simulated database error'
    );
  });
});
