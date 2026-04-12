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
  CampaignNotificationFieldDescriptor,
  CampaignNotificationTriggerDescriptor,
  CampaignNotificationTriggerExecutionResult,
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
  CampaignNotificationTriggerDefinition,
  CampaignNotificationTriggerRegistry,
  CampaignNotificationTemplatePreviewService,
} from './core/ports.js';

export { listCampaignNotificationAudit } from './core/usecases/list-campaign-notification-audit.js';
export { executeCampaignNotificationTrigger } from './core/usecases/execute-campaign-notification-trigger.js';
export { listCampaignNotificationTemplates } from './core/usecases/list-campaign-notification-templates.js';
export { getCampaignNotificationTemplatePreview } from './core/usecases/get-campaign-notification-template-preview.js';

export { makeCampaignNotificationOutboxAuditRepo } from './shell/repo/outbox-audit-repo.js';
export { makeCampaignNotificationTemplatePreviewService } from './shell/preview/template-preview-service.js';
export { makeCampaignNotificationTriggerRegistry } from './shell/registry/trigger-definitions.js';
export {
  makeCampaignAdminNotificationRoutes,
  type MakeCampaignAdminNotificationRoutesDeps,
} from './shell/rest/routes.js';
export {
  CampaignKeyParamsSchema,
  CampaignNotificationListQuerySchema,
  CampaignNotificationListResponseSchema,
  CampaignNotificationTriggerListResponseSchema,
  CampaignNotificationTriggerExecutionResponseSchema,
  CampaignNotificationTemplateListResponseSchema,
  CampaignNotificationTemplatePreviewResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignNotificationListQuery,
  type CampaignNotificationTemplateIdParams,
} from './shell/rest/schemas.js';
