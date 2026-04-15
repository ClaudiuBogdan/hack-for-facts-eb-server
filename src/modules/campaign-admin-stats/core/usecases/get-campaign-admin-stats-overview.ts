import type { CampaignAdminStatsError } from '../errors.js';
import type { CampaignAdminStatsReader } from '../ports.js';
import type { CampaignAdminStatsOverview, GetCampaignAdminStatsOverviewInput } from '../types.js';
import type { Result } from 'neverthrow';

export interface GetCampaignAdminStatsOverviewDeps {
  readonly reader: CampaignAdminStatsReader;
}

export const getCampaignAdminStatsOverview = (
  deps: GetCampaignAdminStatsOverviewDeps,
  input: GetCampaignAdminStatsOverviewInput
): Promise<Result<CampaignAdminStatsOverview, CampaignAdminStatsError>> => {
  return deps.reader.getOverview(input);
};
