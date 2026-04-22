import { err, ok, type Result } from 'neverthrow';

import { FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX } from '@/common/campaign-keys.js';

import { createNotFoundError, type CampaignEntityConfigError } from '../errors.js';
import {
  mapLearningProgressError,
  normalizeEntityCui,
  type CampaignEntityConfigDeps,
} from './shared.js';

import type {
  CampaignEntityConfigCampaignKey,
  GetPublicCampaignEntityConfigInput,
} from '../types.js';
import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

const PUBLIC_CAMPAIGN_ENTITY_CONFIG_NOT_FOUND_MESSAGE = 'Campaign entity config not found.';

function buildTermsAcceptedRecordKey(entityCui: string): string {
  return `${FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX}${entityCui}`;
}

function hasPublicCampaignEntityConfigAccess(
  row: LearningProgressRecordRow | null,
  entityCui: string
): boolean {
  if (row === null || row.record.value?.kind !== 'json') {
    return false;
  }

  const payload = row.record.value.json.value;
  const acceptedTermsEntityCui =
    typeof payload['entityCui'] === 'string' ? payload['entityCui'].trim() : '';
  if (acceptedTermsEntityCui === '' || acceptedTermsEntityCui !== entityCui) {
    return false;
  }

  const acceptedTermsAt =
    typeof payload['acceptedTermsAt'] === 'string' ? payload['acceptedTermsAt'] : null;
  if (acceptedTermsAt === null || Number.isNaN(Date.parse(acceptedTermsAt))) {
    return false;
  }

  return true;
}

export interface AuthorizePublicCampaignEntityConfigAccessOutput {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
}

export const authorizePublicCampaignEntityConfigAccess = async (
  deps: Pick<CampaignEntityConfigDeps, 'learningProgressRepo'>,
  input: GetPublicCampaignEntityConfigInput
): Promise<Result<AuthorizePublicCampaignEntityConfigAccessOutput, CampaignEntityConfigError>> => {
  const normalizedEntityCuiResult = normalizeEntityCui(input.entityCui);
  if (normalizedEntityCuiResult.isErr()) {
    return err(normalizedEntityCuiResult.error);
  }

  const entityCui = normalizedEntityCuiResult.value;
  const recordResult = await deps.learningProgressRepo.getRecord(
    input.userId,
    buildTermsAcceptedRecordKey(entityCui)
  );
  if (recordResult.isErr()) {
    return err(mapLearningProgressError(recordResult.error));
  }

  if (!hasPublicCampaignEntityConfigAccess(recordResult.value, entityCui)) {
    return err(createNotFoundError(PUBLIC_CAMPAIGN_ENTITY_CONFIG_NOT_FOUND_MESSAGE));
  }

  return ok({
    campaignKey: input.campaignKey,
    entityCui,
  });
};
