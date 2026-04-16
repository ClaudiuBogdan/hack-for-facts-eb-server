import type { InstitutionCorrespondenceError } from '../errors.js';
import type { InstitutionCorrespondenceRepository } from '../ports.js';
import type { CampaignAdminThreadPage, ListCampaignAdminThreadsInput } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListCampaignAdminThreadsDeps {
  repo: Pick<InstitutionCorrespondenceRepository, 'listCampaignAdminThreads'>;
}

export async function listCampaignAdminThreads(
  deps: ListCampaignAdminThreadsDeps,
  input: ListCampaignAdminThreadsInput
): Promise<Result<CampaignAdminThreadPage, InstitutionCorrespondenceError>> {
  return deps.repo.listCampaignAdminThreads(input);
}
