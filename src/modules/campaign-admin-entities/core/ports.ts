import type { CampaignAdminEntitiesError } from './errors.js';
import type {
  CampaignAdminEntitiesMetaCounts,
  GetCampaignAdminEntitiesMetaCountsInput,
  ListCampaignAdminEntitiesInput,
  ListCampaignAdminEntitiesOutput,
} from './types.js';
import type { Result } from 'neverthrow';

export interface CampaignAdminEntitiesRepository {
  listCampaignAdminEntities(
    input: ListCampaignAdminEntitiesInput
  ): Promise<Result<ListCampaignAdminEntitiesOutput, CampaignAdminEntitiesError>>;

  getCampaignAdminEntitiesMetaCounts(
    input: GetCampaignAdminEntitiesMetaCountsInput
  ): Promise<Result<CampaignAdminEntitiesMetaCounts, CampaignAdminEntitiesError>>;
}
