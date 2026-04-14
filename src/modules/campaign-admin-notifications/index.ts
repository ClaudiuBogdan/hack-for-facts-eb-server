export type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationTriggerSource,
  CampaignNotificationSafeErrorCategory,
  CampaignNotificationSafeError,
  CampaignNotificationProjection,
  CampaignNotificationAuditItem,
  CampaignNotificationAuditSortBy,
  CampaignNotificationAuditSortOrder,
  CampaignNotificationAuditCursor,
  ListCampaignNotificationAuditInput,
  ListCampaignNotificationAuditOutput,
  CampaignNotificationMetaCounts,
  CampaignNotificationFieldDescriptor,
  CampaignNotificationTriggerDescriptor,
  CampaignNotificationTriggerCapabilities,
  CampaignNotificationTriggerExecutionResult,
  CampaignNotificationTriggerBulkExecutionResult,
  CampaignNotificationFamilySingleExecutionResult,
  CampaignNotificationTemplateDescriptor,
  CampaignNotificationTemplatePreview,
} from './core/types.js';

export type {
  CampaignAdminNotificationError,
  CampaignAdminNotificationDatabaseError,
  CampaignAdminNotificationValidationError,
  CampaignAdminNotificationNotFoundError,
  CampaignAdminNotificationConflictError,
} from './core/errors.js';

export {
  createDatabaseError,
  createValidationError,
  createNotFoundError,
  createConflictError,
  getHttpStatusForError,
} from './core/errors.js';

export type {
  CampaignNotificationAuditRepository,
  CampaignNotificationTriggerExecutionInput,
  CampaignNotificationTriggerBulkExecutionInput,
  CampaignNotificationTriggerDefinition,
  CampaignNotificationTriggerRegistry,
  CampaignNotificationTemplatePreviewService,
} from './core/ports.js';

export { listCampaignNotificationAudit } from './core/usecases/list-campaign-notification-audit.js';
export { executeCampaignNotificationTrigger } from './core/usecases/execute-campaign-notification-trigger.js';
export { executeCampaignNotificationTriggerBulk } from './core/usecases/execute-campaign-notification-trigger-bulk.js';
export { listCampaignNotificationTemplates } from './core/usecases/list-campaign-notification-templates.js';
export { getCampaignNotificationTemplatePreview } from './core/usecases/get-campaign-notification-template-preview.js';
export { runCampaignNotificationFamilySingle } from './core/usecases/run-campaign-notification-family-single.js';
export { runCampaignNotificationFamilyBulk } from './core/usecases/run-campaign-notification-family-bulk.js';
export type {
  CampaignNotificationFamilyContext,
  CampaignNotificationFamilyPlan,
  CampaignNotificationFamilyCandidatePage,
  CampaignNotificationFamilyExecutionOutcome,
  CampaignNotificationFamilyDefinition,
  CampaignNotificationFamilyBulkExecutionInput,
  CampaignNotificationFamilyBulkAggregation,
} from './core/family-runner.js';
export {
  ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  ADMIN_REVIEWED_USER_INTERACTION_TRIGGER_ID,
  ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID,
  REVIEWED_INTERACTION_BULK_DEFAULT_LIMIT,
  REVIEWED_INTERACTION_BULK_MAX_LIMIT,
} from './core/reviewed-interaction.js';

export { makeCampaignNotificationOutboxAuditRepo } from './shell/repo/outbox-audit-repo.js';
export { makeCampaignNotificationTemplatePreviewService } from './shell/preview/template-preview-service.js';
export { makeCampaignNotificationTriggerRegistry } from './shell/registry/trigger-definitions.js';
export { makeAdminReviewedInteractionTriggerDefinition } from './shell/registry/admin-reviewed-interaction-trigger.js';
export {
  makeCampaignAdminNotificationRoutes,
  type MakeCampaignAdminNotificationRoutesDeps,
} from './shell/rest/routes.js';
export {
  CampaignKeyParamsSchema,
  CampaignNotificationListQuerySchema,
  CampaignNotificationListResponseSchema,
  CampaignNotificationMetaResponseSchema,
  CampaignNotificationTriggerListResponseSchema,
  CampaignNotificationTriggerExecutionResponseSchema,
  CampaignNotificationTemplateListResponseSchema,
  CampaignNotificationTemplatePreviewResponseSchema,
  CampaignNotificationTriggerBulkRequestSchema,
  CampaignNotificationTriggerBulkExecutionResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignNotificationListQuery,
  type CampaignNotificationTemplateIdParams,
} from './shell/rest/schemas.js';
