import { err, ok, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createValidationError,
  type CampaignAdminEntitiesError,
} from '../errors.js';

import type { CampaignAdminEntitiesRepository } from '../ports.js';
import type { CampaignAdminEntityRow, GetCampaignAdminEntityInput } from '../types.js';

export interface GetCampaignAdminEntityDeps {
  readonly entitiesRepository: CampaignAdminEntitiesRepository;
}

export const getCampaignAdminEntity = async (
  deps: GetCampaignAdminEntityDeps,
  input: GetCampaignAdminEntityInput
): Promise<Result<CampaignAdminEntityRow, CampaignAdminEntitiesError>> => {
  const entityCui = input.entityCui.trim();
  if (entityCui === '') {
    return err(createValidationError('Entity CUI is required.'));
  }

  const result = await deps.entitiesRepository.listCampaignAdminEntities({
    campaignKey: input.campaignKey,
    interactions: input.interactions,
    reviewableInteractions: input.reviewableInteractions,
    entityCui,
    sortBy: 'entityCui',
    sortOrder: 'asc',
    limit: 1,
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const entity = result.value.items[0];
  if (entity === undefined) {
    return err(createNotFoundError(`Campaign entity "${entityCui}" not found.`));
  }

  return ok(entity);
};
