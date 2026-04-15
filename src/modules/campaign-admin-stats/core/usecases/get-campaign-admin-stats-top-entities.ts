import type { CampaignAdminStatsError } from '../errors.js';
import type { CampaignAdminStatsReader } from '../ports.js';
import type {
  CampaignAdminStatsTopEntities,
  GetCampaignAdminStatsTopEntitiesInput,
} from '../types.js';
import type { Result } from 'neverthrow';

export interface GetCampaignAdminStatsTopEntitiesDeps {
  readonly reader: CampaignAdminStatsReader;
}

export const getCampaignAdminStatsTopEntities = (
  deps: GetCampaignAdminStatsTopEntitiesDeps,
  input: GetCampaignAdminStatsTopEntitiesInput
): Promise<Result<CampaignAdminStatsTopEntities, CampaignAdminStatsError>> => {
  return deps.reader.getTopEntities(input);
};
