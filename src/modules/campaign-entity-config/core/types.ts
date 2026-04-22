import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

export type CampaignEntityConfigCampaignKey = typeof FUNKY_CAMPAIGN_KEY;

export interface CampaignEntityConfigPublicDebate {
  readonly date: string;
  readonly time: string;
  readonly location: string;
  readonly announcement_link: string;
  readonly online_participation_link?: string;
  readonly description?: string;
}

export interface CampaignEntityConfigValues {
  readonly budgetPublicationDate: string | null;
  readonly officialBudgetUrl: string | null;
  readonly public_debate: CampaignEntityConfigPublicDebate | null;
}

export interface CampaignEntityConfigDto {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly isConfigured: boolean;
  readonly values: CampaignEntityConfigValues;
  readonly updatedAt: string | null;
  readonly updatedByUserId: string | null;
}

export interface CampaignEntityConfigPublicDto {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly isConfigured: boolean;
  readonly values: CampaignEntityConfigValues;
}

export interface CampaignEntityConfigListItem extends CampaignEntityConfigDto {
  readonly usersCount: number;
}

export type CampaignEntityConfigSortBy =
  | 'updatedAt'
  | 'entityCui'
  | 'budgetPublicationDate'
  | 'officialBudgetUrl'
  | 'usersCount';
export type CampaignEntityConfigSortOrder = 'asc' | 'desc';

export interface CampaignEntityConfigListCursor {
  readonly sortBy: CampaignEntityConfigSortBy;
  readonly sortOrder: CampaignEntityConfigSortOrder;
  readonly value: string | number | null;
  readonly entityCui: string;
}

export interface GetCampaignEntityConfigInput {
  readonly campaignKey: CampaignEntityConfigCampaignKey;
  readonly entityCui: string;
}

export interface GetPublicCampaignEntityConfigInput extends GetCampaignEntityConfigInput {
  readonly userId: string;
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
  readonly budgetPublicationDate?: string;
  readonly hasBudgetPublicationDate?: boolean;
  readonly officialBudgetUrl?: string;
  readonly hasOfficialBudgetUrl?: boolean;
  readonly hasPublicDebate?: boolean;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly sortBy: CampaignEntityConfigSortBy;
  readonly sortOrder: CampaignEntityConfigSortOrder;
  readonly limit: number;
  readonly cursor?: CampaignEntityConfigListCursor;
}

export interface ListCampaignEntityConfigsOutput {
  readonly items: readonly CampaignEntityConfigListItem[];
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: CampaignEntityConfigListCursor | null;
}
