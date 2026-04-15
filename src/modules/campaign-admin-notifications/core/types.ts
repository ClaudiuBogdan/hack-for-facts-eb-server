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

export interface AdminReviewedInteractionProjection {
  readonly kind: 'admin_reviewed_interaction';
  readonly userId: string | null;
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly recordKey: string;
  readonly interactionId: string;
  readonly interactionLabel: string | null;
  readonly reviewStatus: 'approved' | 'rejected';
  readonly reviewedAt: string;
  readonly hasFeedbackText: boolean;
  readonly nextStepCount: number;
  readonly triggerSource: CampaignNotificationTriggerSource | null;
}

export interface WeeklyProgressDigestProjection {
  readonly kind: 'weekly_progress_digest';
  readonly userId: string | null;
  readonly weekKey: string;
  readonly totalItemCount: number | null;
  readonly actionNowCount: number | null;
  readonly triggerSource: CampaignNotificationTriggerSource | null;
}

export type CampaignNotificationProjection =
  | PublicDebateCampaignWelcomeProjection
  | PublicDebateEntitySubscriptionProjection
  | PublicDebateEntityUpdateProjection
  | PublicDebateAdminFailureProjection
  | AdminReviewedInteractionProjection
  | WeeklyProgressDigestProjection;

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
  readonly totalCount: number;
  readonly nextCursor: CampaignNotificationAuditCursor | null;
  readonly hasMore: boolean;
}

export interface CampaignNotificationMetaCounts {
  readonly pendingDeliveryCount: number;
  readonly failedDeliveryCount: number;
  readonly replyReceivedCount: number;
}

export interface CampaignNotificationFieldDescriptor {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface CampaignNotificationTriggerCapabilities {
  readonly supportsSingleExecution: boolean;
  readonly supportsBulkExecution: boolean;
  readonly supportsDryRun: boolean;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly bulkInputFields?: readonly CampaignNotificationFieldDescriptor[];
}

export interface CampaignNotificationTriggerDescriptor {
  readonly triggerId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly familyId?: string;
  readonly templateId: string;
  readonly description: string;
  readonly inputFields: readonly CampaignNotificationFieldDescriptor[];
  readonly targetKind: string;
  readonly capabilities?: CampaignNotificationTriggerCapabilities;
}

export interface CampaignNotificationTriggerExecutionLegacyResult {
  readonly status: 'queued' | 'skipped' | 'partial';
  readonly reason?: string;
  readonly createdOutboxIds: readonly string[];
  readonly reusedOutboxIds: readonly string[];
  readonly queuedOutboxIds: readonly string[];
  readonly enqueueFailedOutboxIds: readonly string[];
}

export interface CampaignNotificationFamilySingleExecutionResult {
  readonly kind: 'family_single';
  readonly familyId: string;
  readonly status: 'queued' | 'skipped' | 'partial' | 'delegated';
  readonly reason: string;
  readonly delegateTarget?: string;
  readonly createdOutboxIds: readonly string[];
  readonly reusedOutboxIds: readonly string[];
  readonly queuedOutboxIds: readonly string[];
  readonly enqueueFailedOutboxIds: readonly string[];
}

export type CampaignNotificationTriggerExecutionResult =
  | CampaignNotificationTriggerExecutionLegacyResult
  | CampaignNotificationFamilySingleExecutionResult;

export interface CampaignNotificationTriggerBulkExecutionResult {
  readonly kind: 'family_bulk';
  readonly familyId: string;
  readonly dryRun: boolean;
  readonly watermark: string;
  readonly limit: number;
  readonly hasMoreCandidates: boolean;
  readonly candidateCount: number;
  readonly plannedCount: number;
  readonly eligibleCount: number;
  readonly queuedCount: number;
  readonly reusedCount: number;
  readonly skippedCount: number;
  readonly delegatedCount: number;
  readonly ineligibleCount: number;
  readonly notReplayableCount: number;
  readonly staleCount: number;
  readonly enqueueFailedCount: number;
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

export interface CampaignNotificationRunnableTemplateDescriptor {
  readonly runnableId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly description: string;
  readonly targetKind: string;
  readonly selectors: readonly CampaignNotificationFieldDescriptor[];
  readonly filters: readonly CampaignNotificationFieldDescriptor[];
  readonly dryRunRequired: boolean;
  readonly maxPlanRowCount: number;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
}

export type CampaignNotificationRunnablePlanRowStatus =
  | 'will_send'
  | 'already_sent'
  | 'already_pending'
  | 'ineligible'
  | 'missing_data';

export type CampaignNotificationRunnablePlanSendMode = 'create' | 'reuse_claimable';

export interface CampaignNotificationRunnablePlanRow {
  readonly rowKey: string;
  readonly userId: string;
  readonly entityCui: string | null;
  readonly entityName: string | null;
  readonly recordKey: string | null;
  readonly interactionId: string | null;
  readonly interactionLabel: string | null;
  readonly reviewStatus: 'approved' | 'rejected' | null;
  readonly reviewedAt: string | null;
  readonly status: CampaignNotificationRunnablePlanRowStatus;
  readonly reasonCode: string;
  readonly statusMessage: string;
  readonly hasExistingDelivery: boolean;
  readonly existingDeliveryStatus: string | null;
  readonly sendMode: CampaignNotificationRunnablePlanSendMode | null;
}

export interface CampaignNotificationRunnablePlanSummary {
  readonly totalRowCount: number;
  readonly willSendCount: number;
  readonly alreadySentCount: number;
  readonly alreadyPendingCount: number;
  readonly ineligibleCount: number;
  readonly missingDataCount: number;
}

export interface CampaignNotificationStoredPlanRow {
  readonly preview: CampaignNotificationRunnablePlanRow;
  readonly executionData: Record<string, unknown> | null;
}

export interface CampaignNotificationStoredPlan {
  readonly planId: string;
  readonly actorUserId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly runnableId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly payloadHash: string;
  readonly watermark: string;
  readonly summary: CampaignNotificationRunnablePlanSummary;
  readonly rows: readonly CampaignNotificationStoredPlanRow[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface CampaignNotificationRunnablePlanPage {
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface CampaignNotificationRunnablePlanView {
  readonly planId: string;
  readonly runnableId: string;
  readonly templateId: string;
  readonly watermark: string;
  readonly summary: CampaignNotificationRunnablePlanSummary;
  readonly rows: readonly CampaignNotificationRunnablePlanRow[];
  readonly page: CampaignNotificationRunnablePlanPage;
}

export interface CampaignNotificationRunnablePlanSendResult {
  readonly planId: string;
  readonly runnableId: string;
  readonly templateId: string;
  readonly evaluatedCount: number;
  readonly queuedCount: number;
  readonly alreadySentCount: number;
  readonly alreadyPendingCount: number;
  readonly ineligibleCount: number;
  readonly missingDataCount: number;
  readonly enqueueFailedCount: number;
}
