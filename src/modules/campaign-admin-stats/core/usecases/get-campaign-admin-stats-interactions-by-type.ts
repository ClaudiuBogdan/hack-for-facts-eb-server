import type { CampaignAdminStatsError } from '../errors.js';
import type { CampaignAdminStatsReader } from '../ports.js';
import type {
  CampaignAdminStatsInteractionsByType,
  GetCampaignAdminStatsInteractionsByTypeInput,
} from '../types.js';
import type { Result } from 'neverthrow';

export interface GetCampaignAdminStatsInteractionsByTypeDeps {
  readonly reader: CampaignAdminStatsReader;
}

export const getCampaignAdminStatsInteractionsByType = (
  deps: GetCampaignAdminStatsInteractionsByTypeDeps,
  input: GetCampaignAdminStatsInteractionsByTypeInput
): Promise<Result<CampaignAdminStatsInteractionsByType, CampaignAdminStatsError>> => {
  return deps.reader.getInteractionsByType(input);
};
