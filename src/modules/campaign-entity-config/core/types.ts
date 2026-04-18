import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

export type CampaignEntityConfigCampaignKey = typeof FUNKY_CAMPAIGN_KEY;

export interface CampaignEntityConfigValues {
  readonly budgetPublicationDate: string | null;
  readonly officialBudgetUrl: string | null;
}

export interface CampaignEntityConfigDto {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
  readonly isConfigured: boolean;
  readonly values: CampaignEntityConfigValues;
  readonly updatedAt: string | null;
  readonly updatedByUserId: string | null;
}

export type CampaignEntityConfigSortBy = 'updatedAt' | 'entityCui';
export type CampaignEntityConfigSortOrder = 'asc' | 'desc';

export interface CampaignEntityConfigListCursor {
  readonly sortBy: CampaignEntityConfigSortBy;
  readonly sortOrder: CampaignEntityConfigSortOrder;
  readonly updatedAt: string | null;
  readonly entityCui: string;
}

export interface GetCampaignEntityConfigInput {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
}

export interface UpsertCampaignEntityConfigInput {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
  readonly values: CampaignEntityConfigValues;
  readonly expectedUpdatedAt: string | null;
  readonly actorUserId: string;
}

export interface ListCampaignEntityConfigsInput {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly query?: string;
  readonly entityCui?: string;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly sortBy: CampaignEntityConfigSortBy;
  readonly sortOrder: CampaignEntityConfigSortOrder;
  readonly limit: number;
  readonly cursor?: CampaignEntityConfigListCursor;
}

export interface ListCampaignEntityConfigsOutput {
  readonly items: readonly CampaignEntityConfigDto[];
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: CampaignEntityConfigListCursor | null;
}
