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
  CampaignNotificationRunnableTemplateDescriptor,
  CampaignNotificationRunnablePlanRow,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationStoredPlan,
  CampaignNotificationRunnablePlanView,
  CampaignNotificationRunnablePlanSendResult,
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
  CampaignNotificationRunnablePlanCreationInput,
  CampaignNotificationRunnablePlanRepository,
  CampaignNotificationRunnableTemplateDefinition,
  CampaignNotificationRunnableTemplateRegistry,
  CampaignNotificationTemplatePreviewService,
} from './core/ports.js';

export { listCampaignNotificationAudit } from './core/usecases/list-campaign-notification-audit.js';
export { createCampaignNotificationRunnablePlan } from './core/usecases/create-campaign-notification-runnable-plan.js';
export { executeCampaignNotificationTrigger } from './core/usecases/execute-campaign-notification-trigger.js';
export { executeCampaignNotificationTriggerBulk } from './core/usecases/execute-campaign-notification-trigger-bulk.js';
export { getCampaignNotificationRunnablePlan } from './core/usecases/get-campaign-notification-runnable-plan.js';
export { listCampaignNotificationTemplates } from './core/usecases/list-campaign-notification-templates.js';
export { listCampaignNotificationRunnableTemplates } from './core/usecases/list-campaign-notification-runnable-templates.js';
export { getCampaignNotificationTemplatePreview } from './core/usecases/get-campaign-notification-template-preview.js';
export { runCampaignNotificationFamilySingle } from './core/usecases/run-campaign-notification-family-single.js';
export { runCampaignNotificationFamilyBulk } from './core/usecases/run-campaign-notification-family-bulk.js';
export { sendCampaignNotificationRunnablePlan } from './core/usecases/send-campaign-notification-runnable-plan.js';
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
export { makeCampaignNotificationRunnablePlanRepo } from './shell/repo/runnable-plan-repo.js';
export { makeCampaignNotificationTemplatePreviewService } from './shell/preview/template-preview-service.js';
export { makeCampaignNotificationRunnableTemplateRegistry } from './shell/registry/runnable-template-definitions.js';
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
  CampaignNotificationRunnableTemplateListResponseSchema,
  CampaignNotificationRunnablePlanResponseSchema,
  CampaignNotificationRunnablePlanSendResponseSchema,
  CampaignNotificationTemplateListResponseSchema,
  CampaignNotificationTemplatePreviewResponseSchema,
  CampaignNotificationRunnableIdParamsSchema,
  CampaignNotificationPlanIdParamsSchema,
  CampaignNotificationRunnablePlanReadQuerySchema,
  CampaignNotificationTriggerBulkRequestSchema,
  CampaignNotificationTriggerBulkExecutionResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignNotificationListQuery,
  type CampaignNotificationRunnableIdParams,
  type CampaignNotificationPlanIdParams,
  type CampaignNotificationRunnablePlanReadQuery,
  type CampaignNotificationTemplateIdParams,
} from './shell/rest/schemas.js';
