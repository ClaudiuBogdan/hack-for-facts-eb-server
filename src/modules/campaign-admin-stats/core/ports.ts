import type { CampaignAdminStatsError } from './errors.js';
import type { CampaignAdminStatsOverview, GetCampaignAdminStatsOverviewInput } from './types.js';
import type { Result } from 'neverthrow';

export interface CampaignAdminStatsReader {
  getOverview(
    input: GetCampaignAdminStatsOverviewInput
  ): Promise<Result<CampaignAdminStatsOverview, CampaignAdminStatsError>>;
}
