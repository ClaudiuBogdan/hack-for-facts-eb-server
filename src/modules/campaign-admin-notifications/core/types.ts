export type CampaignNotificationAdminCampaignKey = 'funky';

export type CampaignNotificationTriggerSource =
  | 'campaign_admin'
  | 'user_event_worker'
  | 'system'
  | 'clerk_webhook';

export type CampaignNotificationSafeErrorCategory =
  | 'skipped_unsubscribed'
  | 'skipped_no_email'
  | 'suppressed'
  | 'webhook_timeout'
  | 'compose_validation'
  | 'render_error'
  | 'email_lookup'
  | 'send_retryable'
  | 'send_permanent'
  | 'provider_bounce'
  | 'provider_suppressed'
  | 'unknown';

export interface CampaignNotificationSafeError {
  readonly category: CampaignNotificationSafeErrorCategory | null;
  readonly code: string | null;
}

export interface PublicDebateCampaignWelcomeProjection {
  readonly kind: 'public_debate_campaign_welcome';
  readonly userId: string | null;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly acceptedTermsAt: string | null;
  readonly triggerSource: CampaignNotificationTriggerSource | null;
}

export interface PublicDebateEntitySubscriptionProjection {
  readonly kind: 'public_debate_entity_subscription';
  readonly userId: string | null;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly acceptedTermsAt: string | null;
  readonly selectedEntitiesCount: number | null;
  readonly triggerSource: CampaignNotificationTriggerSource | null;
}

export interface PublicDebateEntityUpdateProjection {
  readonly kind: 'public_debate_entity_update';
  readonly userId: string | null;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly threadId: string;
  readonly threadKey: string | null;
  readonly eventType: string | null;
  readonly phase: string | null;
  readonly replyEntryId: string | null;
  readonly basedOnEntryId: string | null;
  readonly resolutionCode: string | null;
  readonly triggerSource: CampaignNotificationTriggerSource | null;
}

export interface PublicDebateAdminFailureProjection {
  readonly kind: 'public_debate_admin_failure';
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly threadId: string;
  readonly phase: string | null;
}

export type CampaignNotificationProjection =
  | PublicDebateCampaignWelcomeProjection
  | PublicDebateEntitySubscriptionProjection
  | PublicDebateEntityUpdateProjection
  | PublicDebateAdminFailureProjection;

export interface CampaignNotificationAuditItem {
  readonly outboxId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly notificationType: string;
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly templateVersion: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly attemptCount: number;
  readonly safeError: CampaignNotificationSafeError;
  readonly projection: CampaignNotificationProjection;
}

export type CampaignNotificationAuditSortBy = 'createdAt' | 'sentAt' | 'status' | 'attemptCount';
export type CampaignNotificationAuditSortOrder = 'asc' | 'desc';

export interface CampaignNotificationAuditCursor {
  readonly sortBy: CampaignNotificationAuditSortBy;
  readonly sortOrder: CampaignNotificationAuditSortOrder;
  readonly id: string;
  readonly value: string | number | null;
}

export interface ListCampaignNotificationAuditInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly notificationType?: string;
  readonly templateId?: string;
  readonly userId?: string;
  readonly status?: string;
  readonly eventType?: string;
  readonly entityCui?: string;
  readonly threadId?: string;
  readonly source?: CampaignNotificationTriggerSource;
  readonly sortBy: CampaignNotificationAuditSortBy;
  readonly sortOrder: CampaignNotificationAuditSortOrder;
  readonly cursor?: CampaignNotificationAuditCursor;
  readonly limit: number;
}

export interface ListCampaignNotificationAuditOutput {
  readonly items: readonly CampaignNotificationAuditItem[];
  readonly nextCursor: CampaignNotificationAuditCursor | null;
  readonly hasMore: boolean;
}

export interface CampaignNotificationFieldDescriptor {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface CampaignNotificationTriggerDescriptor {
  readonly triggerId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly templateId: string;
  readonly description: string;
  readonly inputFields: readonly CampaignNotificationFieldDescriptor[];
  readonly targetKind: string;
}

export interface CampaignNotificationTriggerExecutionResult {
  readonly status: 'queued' | 'skipped' | 'partial';
  readonly reason?: string;
  readonly createdOutboxIds: readonly string[];
  readonly reusedOutboxIds: readonly string[];
  readonly queuedOutboxIds: readonly string[];
  readonly enqueueFailedOutboxIds: readonly string[];
}

export interface CampaignNotificationTemplateDescriptor {
  readonly templateId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly requiredFields: readonly CampaignNotificationFieldDescriptor[];
}

export interface CampaignNotificationTemplatePreview extends CampaignNotificationTemplateDescriptor {
  readonly exampleSubject: string;
  readonly html: string;
  readonly text: string;
}
