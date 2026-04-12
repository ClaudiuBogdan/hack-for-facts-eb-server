import type { CampaignAdminEntitiesError } from '../errors.js';
import type { CampaignAdminEntitiesRepository } from '../ports.js';
import type { ListCampaignAdminEntitiesInput, ListCampaignAdminEntitiesOutput } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListCampaignAdminEntitiesDeps {
  readonly entitiesRepository: CampaignAdminEntitiesRepository;
}

export const listCampaignAdminEntities = (
  deps: ListCampaignAdminEntitiesDeps,
  input: ListCampaignAdminEntitiesInput
): Promise<Result<ListCampaignAdminEntitiesOutput, CampaignAdminEntitiesError>> => {
  return deps.entitiesRepository.listCampaignAdminEntities(input);
};
