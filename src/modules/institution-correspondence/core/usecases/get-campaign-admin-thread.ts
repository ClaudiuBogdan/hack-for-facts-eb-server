import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type InstitutionCorrespondenceError } from '../errors.js';

import type { InstitutionCorrespondenceRepository } from '../ports.js';
import type { CampaignAdminThreadLookupInput, ThreadRecord } from '../types.js';

export interface GetCampaignAdminThreadDeps {
  repo: Pick<InstitutionCorrespondenceRepository, 'findCampaignAdminThreadById'>;
}

export async function getCampaignAdminThread(
  deps: GetCampaignAdminThreadDeps,
  input: CampaignAdminThreadLookupInput
): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>> {
  const result = await deps.repo.findCampaignAdminThreadById(input);
  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError(`Thread "${input.threadId}" was not found.`));
  }

  return ok(result.value);
}
