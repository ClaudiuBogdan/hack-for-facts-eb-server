import { describe, expect, it } from 'vitest';

import { buildSubscriptionComposeJob } from '@/modules/notification-delivery/shell/queue/compose-job-options.js';

describe('buildSubscriptionComposeJob', () => {
  it('adds retry and backoff options for collect-worker compose jobs', () => {
    const job = buildSubscriptionComposeJob({
      runId: 'run-1',
      kind: 'subscription',
      notificationId: 'notification-1',
      periodKey: '2026-03',
    });

    expect(job).toEqual({
      name: 'compose',
      data: {
        runId: 'run-1',
        kind: 'subscription',
        notificationId: 'notification-1',
        periodKey: '2026-03',
      },
      opts: {
        jobId: 'compose-notification-1-2026-03',
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  });
});
