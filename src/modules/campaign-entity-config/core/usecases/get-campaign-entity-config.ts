import { err, ok, type Result } from 'neverthrow';

import {
  buildCampaignEntityConfigUserId,
  buildCampaignEntityConfigRecordKey,
  createDefaultCampaignEntityConfig,
  parseCampaignEntityConfigRecord,
} from '../config-record.js';
import {
  mapLearningProgressError,
  loadRequiredEntityByCui,
  normalizeEntityCui,
  type CampaignEntityConfigDeps,
  withCampaignEntityConfigEntityName,
} from './shared.js';

import type { CampaignEntityConfigError } from '../errors.js';
import type { CampaignEntityConfigDto, GetCampaignEntityConfigInput } from '../types.js';

export type GetCampaignEntityConfigDeps = CampaignEntityConfigDeps;

export const getCampaignEntityConfig = async (
  deps: GetCampaignEntityConfigDeps,
  input: GetCampaignEntityConfigInput
): Promise<Result<CampaignEntityConfigDto, CampaignEntityConfigError>> => {
  const entityCuiResult = normalizeEntityCui(input.entityCui);
  if (entityCuiResult.isErr()) {
    return err(entityCuiResult.error);
  }

  const entityCui = entityCuiResult.value;
  const entityResult = await loadRequiredEntityByCui(deps, entityCui);
  if (entityResult.isErr()) {
    return err(entityResult.error);
  }

  const rowResult = await deps.learningProgressRepo.getRecord(
    buildCampaignEntityConfigUserId(input.campaignKey),
    buildCampaignEntityConfigRecordKey(entityCui)
  );
  if (rowResult.isErr()) {
    return err(mapLearningProgressError(rowResult.error));
  }

  if (rowResult.value === null) {
    return ok(
      withCampaignEntityConfigEntityName(
        createDefaultCampaignEntityConfig({
          campaignKey: input.campaignKey,
          entityCui,
        }),
        entityResult.value
      )
    );
  }

  const parsedRowResult = parseCampaignEntityConfigRecord({
    campaignKey: input.campaignKey,
    row: rowResult.value,
    expectedEntityCui: entityCui,
  });
  if (parsedRowResult.isErr()) {
    return err(parsedRowResult.error);
  }

  return ok(withCampaignEntityConfigEntityName(parsedRowResult.value.dto, entityResult.value));
};
