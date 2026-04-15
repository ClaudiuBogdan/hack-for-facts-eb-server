import type { CampaignAdminCampaignKey } from '@/modules/learning-progress/index.js';

export type CampaignAdminStatsCampaignKey = CampaignAdminCampaignKey;

export type CampaignAdminStatsTopEntitiesSortBy =
  | 'interactionCount'
  | 'userCount'
  | 'pendingReviewCount';

export interface CampaignAdminStatsOverviewCoverage {
  readonly hasClientTelemetry: boolean;
  readonly hasNotificationAttribution: boolean;
}

export interface CampaignAdminStatsOverviewUsers {
  readonly totalUsers: number;
  readonly usersWithPendingReviews: number;
}

export interface CampaignAdminStatsOverviewInteractionReviewStatusCounts {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notReviewed: number;
}

export interface CampaignAdminStatsOverviewInteractionPhaseCounts {
  readonly idle: number;
  readonly draft: number;
  readonly pending: number;
  readonly resolved: number;
  readonly failed: number;
}

export interface CampaignAdminStatsOverviewInteractionThreadPhaseCounts {
  readonly sending: number;
  readonly awaitingReply: number;
  readonly replyReceivedUnreviewed: number;
  readonly manualFollowUpNeeded: number;
  readonly resolvedPositive: number;
  readonly resolvedNegative: number;
  readonly closedNoResponse: number;
  readonly failed: number;
  readonly none: number;
}

export interface CampaignAdminStatsOverviewInteractions {
  readonly totalInteractions: number;
  readonly interactionsWithInstitutionThread: number;
  readonly reviewStatusCounts: CampaignAdminStatsOverviewInteractionReviewStatusCounts;
  readonly phaseCounts: CampaignAdminStatsOverviewInteractionPhaseCounts;
  readonly threadPhaseCounts: CampaignAdminStatsOverviewInteractionThreadPhaseCounts;
}

export interface CampaignAdminStatsOverviewEntities {
  readonly totalEntities: number;
  readonly entitiesWithPendingReviews: number;
  readonly entitiesWithSubscribers: number;
  readonly entitiesWithNotificationActivity: number;
  readonly entitiesWithFailedNotifications: number;
}

export interface CampaignAdminStatsOverviewNotifications {
  readonly pendingDeliveryCount: number;
  readonly failedDeliveryCount: number;
  readonly deliveredCount: number;
  readonly openedCount: number;
  readonly clickedCount: number;
  readonly suppressedCount: number;
}

export interface CampaignAdminStatsOverview {
  readonly coverage: CampaignAdminStatsOverviewCoverage;
  readonly users: CampaignAdminStatsOverviewUsers;
  readonly interactions: CampaignAdminStatsOverviewInteractions;
  readonly entities: CampaignAdminStatsOverviewEntities;
  readonly notifications: CampaignAdminStatsOverviewNotifications;
}

export interface GetCampaignAdminStatsOverviewInput {
  readonly campaignKey: CampaignAdminStatsCampaignKey;
}

export interface CampaignAdminStatsInteractionsByTypeItem {
  readonly interactionId: string;
  readonly label: string | null;
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notReviewed: number;
}

export interface CampaignAdminStatsInteractionsByType {
  readonly items: readonly CampaignAdminStatsInteractionsByTypeItem[];
}

export interface GetCampaignAdminStatsInteractionsByTypeInput {
  readonly campaignKey: CampaignAdminStatsCampaignKey;
}

export interface CampaignAdminStatsTopEntityItem {
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly interactionCount: number;
  readonly userCount: number;
  readonly pendingReviewCount: number;
}

export interface CampaignAdminStatsTopEntities {
  readonly sortBy: CampaignAdminStatsTopEntitiesSortBy;
  readonly limit: number;
  readonly items: readonly CampaignAdminStatsTopEntityItem[];
}

export interface GetCampaignAdminStatsTopEntitiesInput {
  readonly campaignKey: CampaignAdminStatsCampaignKey;
  readonly sortBy: CampaignAdminStatsTopEntitiesSortBy;
  readonly limit: number;
}
