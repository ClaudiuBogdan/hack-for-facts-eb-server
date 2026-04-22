import { listCampaignEntityConfigs } from './list-campaign-entity-configs.js';

import type { CampaignEntityConfigError } from '../errors.js';
import type {
  CampaignEntityConfigListCursor,
  CampaignEntityConfigListItem,
  GetCampaignEntityConfigInput,
} from '../types.js';
import type { CampaignEntityConfigDeps } from './shared.js';
import type { Result } from 'neverthrow';

export interface ListPublicDebateCampaignEntityConfigsInput extends Pick<
  GetCampaignEntityConfigInput,
  'campaignKey'
> {
  readonly entityCui?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly limit: number;
  readonly cursor?: CampaignEntityConfigListCursor;
}

export interface ListPublicDebateCampaignEntityConfigsOutput {
  readonly items: readonly CampaignEntityConfigListItem[];
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: CampaignEntityConfigListCursor | null;
}

export const listPublicDebateCampaignEntityConfigs = async (
  deps: Pick<CampaignEntityConfigDeps, 'learningProgressRepo' | 'entityRepo'>,
  input: ListPublicDebateCampaignEntityConfigsInput
): Promise<Result<ListPublicDebateCampaignEntityConfigsOutput, CampaignEntityConfigError>> => {
  return listCampaignEntityConfigs(deps, {
    campaignKey: input.campaignKey,
    ...(input.entityCui !== undefined ? { entityCui: input.entityCui } : {}),
    hasPublicDebate: true,
    ...(input.updatedAtFrom !== undefined ? { updatedAtFrom: input.updatedAtFrom } : {}),
    ...(input.updatedAtTo !== undefined ? { updatedAtTo: input.updatedAtTo } : {}),
    sortBy: 'entityCui',
    sortOrder: 'asc',
    limit: input.limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  });
};
