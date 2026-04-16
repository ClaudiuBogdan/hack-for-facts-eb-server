import { describe, expect, it } from 'vitest';

import {
  isCampaignAdminThreadInScope,
  projectCampaignAdminThread,
  readAdminResponseEvents,
} from '@/modules/institution-correspondence/index.js';

import {
  createAdminResponseEvent,
  createThreadAggregateRecord,
  createThreadRecord,
} from './fake-repo.js';

describe('campaign admin thread projection', () => {
  it('falls back to low-level phases when no admin response events exist', () => {
    const sendingThread = createThreadRecord({
      phase: 'sending',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const startedThread = createThreadRecord({
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const pendingThread = createThreadRecord({
      phase: 'reply_received_unreviewed',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const resolvedThread = createThreadRecord({
      phase: 'resolved_negative',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });

    expect(projectCampaignAdminThread(startedThread)).toMatchObject({
      threadState: 'started',
      currentResponseStatus: null,
      latestResponseAt: null,
      responseEventCount: 0,
    });
    expect(isCampaignAdminThreadInScope(sendingThread)).toBe(false);
    expect(isCampaignAdminThreadInScope(startedThread)).toBe(true);
    expect(projectCampaignAdminThread(pendingThread)).toMatchObject({
      threadState: 'pending',
    });
    expect(projectCampaignAdminThread(resolvedThread)).toMatchObject({
      threadState: 'resolved',
    });
  });

  it('makes the latest appended admin response authoritative over low-level phases', () => {
    const responseEvent = createAdminResponseEvent({
      id: 'response-1',
      responseDate: '2026-03-26T10:00:00.000Z',
      responseStatus: 'registration_number_received',
    });

    const thread = createThreadRecord({
      phase: 'resolved_positive',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        adminWorkflow: {
          currentResponseStatus: 'registration_number_received',
          responseEvents: [responseEvent],
        },
      }),
    });

    expect(readAdminResponseEvents(thread.record)).toEqual([responseEvent]);
    expect(projectCampaignAdminThread(thread)).toMatchObject({
      threadState: 'pending',
      currentResponseStatus: 'registration_number_received',
      latestResponseAt: '2026-03-26T10:00:00.000Z',
      responseEventCount: 1,
    });
  });
});
