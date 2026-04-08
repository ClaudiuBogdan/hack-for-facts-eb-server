import type { CampaignSubscriptionStatsError } from './errors.js';
import type { CampaignSubscriptionStats } from './types.js';
import type { Result } from 'neverthrow';

export interface CampaignSubscriptionStatsReader {
  getByCampaignId(
    campaignId: string
  ): Promise<Result<CampaignSubscriptionStats, CampaignSubscriptionStatsError>>;
}
