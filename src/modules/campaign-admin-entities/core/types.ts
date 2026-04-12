import type {
  CampaignAdminAvailableInteractionType,
  CampaignAdminCampaignKey,
  CampaignAdminInteractionFilter,
  CampaignAdminSortOrder,
} from '@/modules/learning-progress/index.js';

export type CampaignAdminEntitiesCampaignKey = CampaignAdminCampaignKey;
export type CampaignAdminEntitySortOrder = CampaignAdminSortOrder;

export const CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES = [
  'funky:outbox:welcome',
  'funky:outbox:entity_subscription',
  'funky:outbox:entity_update',
] as const;

export type CampaignAdminEntityNotificationType =
  (typeof CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES)[number];

export const CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES = [
  'pending',
  'composing',
  'sending',
  'sent',
  'delivered',
  'webhook_timeout',
  'failed_transient',
  'failed_permanent',
  'suppressed',
  'skipped_unsubscribed',
  'skipped_no_email',
] as const;

export type CampaignAdminEntityNotificationStatus =
  (typeof CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES)[number];

export const CAMPAIGN_ADMIN_ENTITY_FAILED_NOTIFICATION_STATUSES = [
  'webhook_timeout',
  'failed_transient',
  'failed_permanent',
  'suppressed',
] as const;

export type CampaignAdminEntityFailedNotificationStatus =
  (typeof CAMPAIGN_ADMIN_ENTITY_FAILED_NOTIFICATION_STATUSES)[number];

export const CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS = [
  'entityCui',
  'userCount',
  'interactionCount',
  'pendingReviewCount',
  'notificationSubscriberCount',
  'notificationOutboxCount',
  'latestInteractionAt',
  'latestNotificationAt',
] as const;

export type CampaignAdminEntitySortBy = (typeof CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS)[number];

export type { CampaignAdminAvailableInteractionType };

export interface CampaignAdminEntityListCursor {
  readonly sortBy: CampaignAdminEntitySortBy;
  readonly sortOrder: CampaignAdminEntitySortOrder;
  readonly entityCui: string;
  readonly value: string | number | null;
}

export interface CampaignAdminEntityRow {
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly userCount: number;
  readonly interactionCount: number;
  readonly pendingReviewCount: number;
  readonly notificationSubscriberCount: number;
  readonly notificationOutboxCount: number;
  readonly failedNotificationCount: number;
  readonly hasPendingReviews: boolean;
  readonly hasSubscribers: boolean;
  readonly hasNotificationActivity: boolean;
  readonly hasFailedNotifications: boolean;
  readonly latestInteractionAt: string | null;
  readonly latestInteractionId: string | null;
  readonly latestNotificationAt: string | null;
  readonly latestNotificationType: CampaignAdminEntityNotificationType | null;
  readonly latestNotificationStatus: CampaignAdminEntityNotificationStatus | null;
}

export interface ListCampaignAdminEntitiesInput {
  readonly campaignKey: CampaignAdminEntitiesCampaignKey;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly reviewableInteractions: readonly CampaignAdminInteractionFilter[];
  readonly entityCui?: string;
  readonly query?: string;
  readonly interactionId?: string;
  readonly hasPendingReviews?: boolean;
  readonly hasSubscribers?: boolean;
  readonly hasNotificationActivity?: boolean;
  readonly hasFailedNotifications?: boolean;
  readonly updatedAtFrom?: string;
  readonly updatedAtTo?: string;
  readonly latestNotificationType?: CampaignAdminEntityNotificationType;
  readonly latestNotificationStatus?: CampaignAdminEntityNotificationStatus;
  readonly sortBy: CampaignAdminEntitySortBy;
  readonly sortOrder: CampaignAdminEntitySortOrder;
  readonly limit: number;
  readonly cursor?: CampaignAdminEntityListCursor;
}

export interface ListCampaignAdminEntitiesOutput {
  readonly items: readonly CampaignAdminEntityRow[];
  readonly hasMore: boolean;
  readonly nextCursor: CampaignAdminEntityListCursor | null;
}

export interface GetCampaignAdminEntityInput {
  readonly campaignKey: CampaignAdminEntitiesCampaignKey;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly reviewableInteractions: readonly CampaignAdminInteractionFilter[];
  readonly entityCui: string;
}

export interface CampaignAdminEntitiesMetaCounts {
  readonly totalEntities: number;
  readonly entitiesWithPendingReviews: number;
  readonly entitiesWithSubscribers: number;
  readonly entitiesWithNotificationActivity: number;
  readonly entitiesWithFailedNotifications: number;
}

export interface GetCampaignAdminEntitiesMetaInput {
  readonly campaignKey: CampaignAdminEntitiesCampaignKey;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly reviewableInteractions: readonly CampaignAdminInteractionFilter[];
  readonly availableInteractionTypes: readonly CampaignAdminAvailableInteractionType[];
}

export type GetCampaignAdminEntitiesMetaCountsInput = Omit<
  GetCampaignAdminEntitiesMetaInput,
  'availableInteractionTypes'
>;

export interface GetCampaignAdminEntitiesMetaOutput extends CampaignAdminEntitiesMetaCounts {
  readonly availableInteractionTypes: readonly CampaignAdminAvailableInteractionType[];
}
