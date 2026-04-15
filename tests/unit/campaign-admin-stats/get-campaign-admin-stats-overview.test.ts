import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseError,
  getCampaignAdminStatsOverview,
} from '@/modules/campaign-admin-stats/index.js';

describe('getCampaignAdminStatsOverview', () => {
  it('delegates to the stats reader', async () => {
    const reader = {
      getOverview: vi.fn(async () =>
        ok({
          coverage: {
            hasClientTelemetry: false,
            hasNotificationAttribution: true,
          },
          users: {
            totalUsers: 4,
            usersWithPendingReviews: 1,
          },
          interactions: {
            totalInteractions: 6,
            interactionsWithInstitutionThread: 2,
            reviewStatusCounts: {
              pending: 1,
              approved: 2,
              rejected: 1,
              notReviewed: 2,
            },
            phaseCounts: {
              idle: 0,
              draft: 1,
              pending: 1,
              resolved: 3,
              failed: 1,
            },
            threadPhaseCounts: {
              sending: 0,
              awaitingReply: 0,
              replyReceivedUnreviewed: 0,
              manualFollowUpNeeded: 0,
              resolvedPositive: 1,
              resolvedNegative: 0,
              closedNoResponse: 0,
              failed: 0,
              none: 5,
            },
          },
          entities: {
            totalEntities: 3,
            entitiesWithPendingReviews: 1,
            entitiesWithSubscribers: 2,
            entitiesWithNotificationActivity: 2,
            entitiesWithFailedNotifications: 0,
          },
          notifications: {
            pendingDeliveryCount: 1,
            failedDeliveryCount: 0,
            deliveredCount: 2,
            openedCount: 1,
            clickedCount: 1,
            suppressedCount: 0,
          },
        })
      ),
    };

    const result = await getCampaignAdminStatsOverview(
      {
        reader,
      },
      {
        campaignKey: 'funky',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(reader.getOverview).toHaveBeenCalledWith({
      campaignKey: 'funky',
    });
  });

  it('returns reader errors unchanged', async () => {
    const readerError = createDatabaseError('boom');
    const reader = {
      getOverview: vi.fn(async () => err(readerError)),
    };

    const result = await getCampaignAdminStatsOverview(
      {
        reader,
      },
      {
        campaignKey: 'funky',
      }
    );

    expect(result).toEqual(err(readerError));
  });
});
