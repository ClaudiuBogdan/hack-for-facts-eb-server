import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseError,
  getCampaignAdminStatsInteractionsByType,
  getCampaignAdminStatsOverview,
  getCampaignAdminStatsTopEntities,
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
      getInteractionsByType: vi.fn(),
      getTopEntities: vi.fn(),
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
      getInteractionsByType: vi.fn(),
      getTopEntities: vi.fn(),
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

  it('delegates interactions-by-type to the stats reader', async () => {
    const reader = {
      getOverview: vi.fn(),
      getInteractionsByType: vi.fn(async () =>
        ok({
          items: [
            {
              interactionId: 'funky:interaction:city_hall_website',
              label: 'City hall website',
              total: 3,
              pending: 1,
              approved: 1,
              rejected: 0,
              notReviewed: 1,
            },
          ],
        })
      ),
      getTopEntities: vi.fn(),
    };

    const result = await getCampaignAdminStatsInteractionsByType(
      {
        reader,
      },
      {
        campaignKey: 'funky',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(reader.getInteractionsByType).toHaveBeenCalledWith({
      campaignKey: 'funky',
    });
  });

  it('delegates top-entities to the stats reader', async () => {
    const reader = {
      getOverview: vi.fn(),
      getInteractionsByType: vi.fn(),
      getTopEntities: vi.fn(async () =>
        ok({
          sortBy: 'interactionCount' as const,
          limit: 10,
          items: [
            {
              entityCui: '11111111',
              entityName: 'Entity One',
              interactionCount: 5,
              userCount: 2,
              pendingReviewCount: 1,
            },
          ],
        })
      ),
    };

    const result = await getCampaignAdminStatsTopEntities(
      {
        reader,
      },
      {
        campaignKey: 'funky',
        sortBy: 'interactionCount',
        limit: 10,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(reader.getTopEntities).toHaveBeenCalledWith({
      campaignKey: 'funky',
      sortBy: 'interactionCount',
      limit: 10,
    });
  });
});
