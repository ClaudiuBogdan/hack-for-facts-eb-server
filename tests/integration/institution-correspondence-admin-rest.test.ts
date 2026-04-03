import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER,
  makeInstitutionCorrespondenceAdminRoutes,
} from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../unit/institution-correspondence/fake-repo.js';

describe('Institution Correspondence Admin REST API', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app != null) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('publishes a reply_reviewed update after reviewing a reply', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '11111111-1111-1111-1111-111111111111',
          entityCui: '12345678',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-1',
                direction: 'inbound',
                source: 'institution_reply',
                occurredAt: '2026-03-31T10:00:00.000Z',
              }),
            ],
          }),
        }),
      ],
    });
    const publish = vi.fn().mockResolvedValue(
      ok({
        status: 'queued',
        notificationIds: ['notif-1'],
        createdOutboxIds: ['outbox-1'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-1'],
        enqueueFailedOutboxIds: [],
      })
    );
    app = fastifyLib({ logger: false });

    await app.register(
      makeInstitutionCorrespondenceAdminRoutes({
        repo,
        apiKey: 'test-admin-key',
        updatePublisher: {
          publish,
        },
      })
    );

    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/institution-correspondence/threads/11111111-1111-1111-1111-111111111111/review',
      headers: {
        [INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER]: 'test-admin-key',
        'content-type': 'application/json',
      },
      payload: {
        basedOnEntryId: 'reply-1',
        resolutionCode: 'debate_announced',
        reviewNotes: 'Debate was confirmed by the institution.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          notificationStatus: 'queued',
        }),
      })
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'reply_reviewed',
        basedOnEntryId: 'reply-1',
        resolutionCode: 'debate_announced',
        reviewNotes: 'Debate was confirmed by the institution.',
      })
    );
  });

  it('returns notificationStatus=failed when publishing the review update fails', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '22222222-2222-2222-2222-222222222222',
          entityCui: '12345678',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-2',
                direction: 'inbound',
                source: 'institution_reply',
                occurredAt: '2026-03-31T10:00:00.000Z',
              }),
            ],
          }),
        }),
      ],
    });
    const publish = vi.fn().mockResolvedValue(
      err({
        type: 'CorrespondenceDatabaseError',
        message: 'queue down',
        retryable: true,
      })
    );
    app = fastifyLib({ logger: false });

    await app.register(
      makeInstitutionCorrespondenceAdminRoutes({
        repo,
        apiKey: 'test-admin-key',
        updatePublisher: {
          publish,
        },
      })
    );

    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/institution-correspondence/threads/22222222-2222-2222-2222-222222222222/review',
      headers: {
        [INSTITUTION_CORRESPONDENCE_ADMIN_API_KEY_HEADER]: 'test-admin-key',
        'content-type': 'application/json',
      },
      payload: {
        basedOnEntryId: 'reply-2',
        resolutionCode: 'debate_announced',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          notificationStatus: 'failed',
        }),
      })
    );
  });
});
