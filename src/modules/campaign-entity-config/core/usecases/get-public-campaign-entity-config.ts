import { err, ok, type Result } from 'neverthrow';

import { authorizePublicCampaignEntityConfigAccess } from './authorize-public-campaign-entity-config-access.js';
import { getCampaignEntityConfig } from './get-campaign-entity-config.js';

import type { CampaignEntityConfigError } from '../errors.js';
import type {
  CampaignEntityConfigDto,
  CampaignEntityConfigPublicDto,
  GetPublicCampaignEntityConfigInput,
} from '../types.js';
import type { CampaignEntityConfigDeps } from './shared.js';

export type GetPublicCampaignEntityConfigDeps = CampaignEntityConfigDeps;

function toPublicCampaignEntityConfigDto(
  input: CampaignEntityConfigDto
): CampaignEntityConfigPublicDto {
  return {
    campaignKey: input.campaignKey,
    entityCui: input.entityCui,
    entityName: input.entityName,
    isConfigured: input.isConfigured,
    values: input.values,
  };
}

export const getPublicCampaignEntityConfig = async (
  deps: GetPublicCampaignEntityConfigDeps,
  input: GetPublicCampaignEntityConfigInput
): Promise<Result<CampaignEntityConfigPublicDto, CampaignEntityConfigError>> => {
  const accessResult = await authorizePublicCampaignEntityConfigAccess(
    {
      learningProgressRepo: deps.learningProgressRepo,
    },
    input
  );
  if (accessResult.isErr()) {
    return err(accessResult.error);
  }

  const configResult = await getCampaignEntityConfig(deps, {
    campaignKey: accessResult.value.campaignKey,
    entityCui: accessResult.value.entityCui,
  });
  if (configResult.isErr()) {
    return err(configResult.error);
  }

  return ok(toPublicCampaignEntityConfigDto(configResult.value));
};
