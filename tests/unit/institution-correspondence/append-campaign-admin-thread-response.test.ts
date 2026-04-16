import { describe, expect, it } from 'vitest';

import {
  appendCampaignAdminThreadResponse,
  projectCampaignAdminThread,
} from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('appendCampaignAdminThreadResponse', () => {
  it('appends a pending response event without changing outbound-send timestamps', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '11111111-1111-1111-1111-111111111111',
          campaignKey: 'funky',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-03-24T12:00:00.000Z'),
          updatedAt: new Date('2026-03-24T12:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });

    const result = await appendCampaignAdminThreadResponse(
      { repo },
      {
        campaignKey: 'funky',
        threadId: '11111111-1111-1111-1111-111111111111',
        actorUserId: 'admin-user-1',
        expectedUpdatedAt: new Date('2026-03-24T12:00:00.000Z'),
        responseDate: new Date('2026-03-24T12:30:00.000Z'),
        messageContent: '  Institutia a trimis numarul de inregistrare.  ',
        responseStatus: 'registration_number_received',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.createdResponseEventId).toBeTruthy();
    expect(result.value.thread.lastEmailAt?.toISOString()).toBe('2026-03-24T12:00:00.000Z');
    expect(result.value.thread.lastReplyAt?.toISOString()).toBe('2026-03-24T12:30:00.000Z');
    expect(result.value.thread.phase).toBe('awaiting_reply');
    expect(projectCampaignAdminThread(result.value.thread)).toMatchObject({
      threadState: 'pending',
      currentResponseStatus: 'registration_number_received',
      latestResponseAt: '2026-03-24T12:30:00.000Z',
      responseEventCount: 1,
    });
    expect(result.value.thread.record.adminWorkflow?.responseEvents).toEqual([
      expect.objectContaining({
        id: result.value.createdResponseEventId,
        messageContent: 'Institutia a trimis numarul de inregistrare.',
        responseStatus: 'registration_number_received',
        actorUserId: 'admin-user-1',
      }),
    ]);
  });

  it('keeps registration-number updates from mutating low-level compatibility fields', async () => {
    const reviewedReply = createCorrespondenceEntry({
      id: 'reply-0',
      direction: 'inbound',
      occurredAt: '2026-03-24T12:20:00.000Z',
    });

    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '11111111-1111-1111-1111-111111111112',
          campaignKey: 'funky',
          phase: 'manual_follow_up_needed',
          lastEmailAt: new Date('2026-03-24T12:00:00.000Z'),
          lastReplyAt: new Date('2026-03-24T12:20:00.000Z'),
          nextActionAt: new Date('2026-03-24T15:00:00.000Z'),
          updatedAt: new Date('2026-03-24T13:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            correspondence: [reviewedReply],
            latestReview: {
              basedOnEntryId: reviewedReply.id,
              resolutionCode: 'wrong_contact',
              notes: null,
              reviewedAt: '2026-03-24T12:25:00.000Z',
            },
          }),
        }),
      ],
    });

    const result = await appendCampaignAdminThreadResponse(
      { repo },
      {
        campaignKey: 'funky',
        threadId: '11111111-1111-1111-1111-111111111112',
        actorUserId: 'admin-user-1',
        expectedUpdatedAt: new Date('2026-03-24T13:00:00.000Z'),
        responseDate: new Date('2026-03-24T13:05:00.000Z'),
        messageContent: 'Numarul de inregistrare a fost transmis.',
        responseStatus: 'registration_number_received',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.thread.phase).toBe('manual_follow_up_needed');
    expect(result.value.thread.lastEmailAt?.toISOString()).toBe('2026-03-24T12:00:00.000Z');
    expect(result.value.thread.lastReplyAt?.toISOString()).toBe('2026-03-24T13:05:00.000Z');
    expect(result.value.thread.nextActionAt?.toISOString()).toBe('2026-03-24T15:00:00.000Z');
    expect(result.value.thread.closedAt).toBeNull();
    expect(projectCampaignAdminThread(result.value.thread)).toMatchObject({
      threadState: 'pending',
      currentResponseStatus: 'registration_number_received',
    });
  });

  it('maps terminal admin responses to low-level resolved phases and rejects later appends', async () => {
    const reviewedReply = createCorrespondenceEntry({
      id: 'reply-1',
      direction: 'inbound',
      occurredAt: '2026-03-24T12:50:00.000Z',
    });

    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '22222222-2222-2222-2222-222222222222',
          campaignKey: 'funky',
          phase: 'manual_follow_up_needed',
          updatedAt: new Date('2026-03-24T13:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            correspondence: [reviewedReply],
            latestReview: {
              basedOnEntryId: reviewedReply.id,
              resolutionCode: 'wrong_contact',
              notes: null,
              reviewedAt: '2026-03-24T12:55:00.000Z',
            },
          }),
        }),
      ],
    });

    const resolveResult = await appendCampaignAdminThreadResponse(
      { repo },
      {
        campaignKey: 'funky',
        threadId: '22222222-2222-2222-2222-222222222222',
        actorUserId: 'admin-user-1',
        expectedUpdatedAt: new Date('2026-03-24T13:00:00.000Z'),
        responseDate: new Date('2026-03-24T13:05:00.000Z'),
        messageContent: 'Cererea a fost confirmata.',
        responseStatus: 'request_confirmed',
      }
    );

    expect(resolveResult.isOk()).toBe(true);
    if (resolveResult.isErr()) {
      return;
    }

    expect(resolveResult.value.thread.phase).toBe('resolved_positive');
    expect(resolveResult.value.thread.lastEmailAt).toBeNull();
    expect(resolveResult.value.thread.lastReplyAt?.toISOString()).toBe('2026-03-24T13:05:00.000Z');
    expect(resolveResult.value.thread.nextActionAt).toBeNull();
    expect(resolveResult.value.thread.closedAt?.toISOString()).toBe('2026-03-24T13:05:00.000Z');
    expect(projectCampaignAdminThread(resolveResult.value.thread)).toMatchObject({
      threadState: 'resolved',
      currentResponseStatus: 'request_confirmed',
    });

    const retryResult = await appendCampaignAdminThreadResponse(
      { repo },
      {
        campaignKey: 'funky',
        threadId: '22222222-2222-2222-2222-222222222222',
        actorUserId: 'admin-user-1',
        expectedUpdatedAt: resolveResult.value.thread.updatedAt,
        responseDate: new Date('2026-03-24T13:10:00.000Z'),
        messageContent: 'A doua actualizare nu ar trebui acceptată.',
        responseStatus: 'registration_number_received',
      }
    );

    expect(retryResult.isErr()).toBe(true);
    if (retryResult.isOk()) {
      return;
    }

    expect(retryResult.error.type).toBe('CorrespondenceConflictError');
  });

  it('uses historical responseDate for terminal closure without regressing lastReplyAt', async () => {
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: '33333333-3333-3333-3333-333333333333',
          campaignKey: 'funky',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-03-24T12:00:00.000Z'),
          lastReplyAt: new Date('2026-03-24T12:45:00.000Z'),
          updatedAt: new Date('2026-03-24T13:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
          }),
        }),
      ],
    });

    const result = await appendCampaignAdminThreadResponse(
      { repo },
      {
        campaignKey: 'funky',
        threadId: '33333333-3333-3333-3333-333333333333',
        actorUserId: 'admin-user-1',
        expectedUpdatedAt: new Date('2026-03-24T13:00:00.000Z'),
        responseDate: new Date('2026-03-24T12:30:00.000Z'),
        messageContent: 'Solicitarea a fost respinsa.',
        responseStatus: 'request_denied',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.thread.phase).toBe('resolved_negative');
    expect(result.value.thread.lastEmailAt?.toISOString()).toBe('2026-03-24T12:00:00.000Z');
    expect(result.value.thread.lastReplyAt?.toISOString()).toBe('2026-03-24T12:45:00.000Z');
    expect(result.value.thread.nextActionAt).toBeNull();
    expect(result.value.thread.closedAt?.toISOString()).toBe('2026-03-24T12:30:00.000Z');
    expect(projectCampaignAdminThread(result.value.thread)).toMatchObject({
      threadState: 'resolved',
      currentResponseStatus: 'request_denied',
    });
  });
});
