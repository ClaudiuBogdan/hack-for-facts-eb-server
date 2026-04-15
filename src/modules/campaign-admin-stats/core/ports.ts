import type { CampaignAdminStatsError } from './errors.js';
import type {
  CampaignAdminStatsInteractionsByType,
  CampaignAdminStatsOverview,
  CampaignAdminStatsTopEntities,
  GetCampaignAdminStatsInteractionsByTypeInput,
  GetCampaignAdminStatsOverviewInput,
  GetCampaignAdminStatsTopEntitiesInput,
} from './types.js';
import type { Result } from 'neverthrow';

export interface CampaignAdminStatsReader {
  getOverview(
    input: GetCampaignAdminStatsOverviewInput
  ): Promise<Result<CampaignAdminStatsOverview, CampaignAdminStatsError>>;

  getInteractionsByType(
    input: GetCampaignAdminStatsInteractionsByTypeInput
  ): Promise<Result<CampaignAdminStatsInteractionsByType, CampaignAdminStatsError>>;

  getTopEntities(
    input: GetCampaignAdminStatsTopEntitiesInput
  ): Promise<Result<CampaignAdminStatsTopEntities, CampaignAdminStatsError>>;
}
