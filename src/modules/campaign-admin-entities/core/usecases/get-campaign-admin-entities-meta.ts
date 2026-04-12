import { err, ok, type Result } from 'neverthrow';

import type { CampaignAdminEntitiesError } from '../errors.js';
import type { CampaignAdminEntitiesRepository } from '../ports.js';
import type {
  GetCampaignAdminEntitiesMetaInput,
  GetCampaignAdminEntitiesMetaOutput,
} from '../types.js';

export interface GetCampaignAdminEntitiesMetaDeps {
  readonly entitiesRepository: CampaignAdminEntitiesRepository;
}

export const getCampaignAdminEntitiesMeta = async (
  deps: GetCampaignAdminEntitiesMetaDeps,
  input: GetCampaignAdminEntitiesMetaInput
): Promise<Result<GetCampaignAdminEntitiesMetaOutput, CampaignAdminEntitiesError>> => {
  const metaCountsResult = await deps.entitiesRepository.getCampaignAdminEntitiesMetaCounts({
    campaignKey: input.campaignKey,
    interactions: input.interactions,
    reviewableInteractions: input.reviewableInteractions,
  });

  if (metaCountsResult.isErr()) {
    return err(metaCountsResult.error);
  }

  return ok({
    ...metaCountsResult.value,
    availableInteractionTypes: input.availableInteractionTypes,
  });
};
