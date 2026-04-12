export type {
  CampaignAdminEntitiesCampaignKey,
  CampaignAdminEntitySortOrder,
  CampaignAdminEntityNotificationType,
  CampaignAdminEntityNotificationStatus,
  CampaignAdminEntityFailedNotificationStatus,
  CampaignAdminEntitySortBy,
  CampaignAdminAvailableInteractionType,
  CampaignAdminEntityListCursor,
  CampaignAdminEntityRow,
  GetCampaignAdminEntityInput,
  ListCampaignAdminEntitiesInput,
  ListCampaignAdminEntitiesOutput,
  CampaignAdminEntitiesMetaCounts,
  GetCampaignAdminEntitiesMetaInput,
  GetCampaignAdminEntitiesMetaCountsInput,
  GetCampaignAdminEntitiesMetaOutput,
} from './core/types.js';

export {
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES,
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES,
  CAMPAIGN_ADMIN_ENTITY_FAILED_NOTIFICATION_STATUSES,
  CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS,
} from './core/types.js';

export type {
  CampaignAdminEntitiesError,
  CampaignAdminEntitiesDatabaseError,
  CampaignAdminEntitiesValidationError,
  CampaignAdminEntitiesNotFoundError,
  CampaignAdminEntitiesConflictError,
} from './core/errors.js';

export {
  createDatabaseError,
  createValidationError,
  createNotFoundError,
  createConflictError,
  CAMPAIGN_ADMIN_ENTITIES_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

export type { CampaignAdminEntitiesRepository } from './core/ports.js';

export {
  listCampaignAdminEntities,
  type ListCampaignAdminEntitiesDeps,
} from './core/usecases/list-campaign-admin-entities.js';

export {
  getCampaignAdminEntity,
  type GetCampaignAdminEntityDeps,
} from './core/usecases/get-campaign-admin-entity.js';

export {
  getCampaignAdminEntitiesMeta,
  type GetCampaignAdminEntitiesMetaDeps,
} from './core/usecases/get-campaign-admin-entities-meta.js';

export {
  makeCampaignAdminEntitiesRepo,
  type CampaignAdminEntitiesRepoOptions,
} from './shell/repo/campaign-admin-entities-repo.js';

export {
  makeCampaignAdminEntitiesRoutes,
  type MakeCampaignAdminEntitiesRoutesDeps,
} from './shell/rest/routes.js';

export {
  CampaignKeyParamsSchema,
  CampaignAdminEntityParamsSchema,
  CampaignAdminEntitiesNotificationTypeSchema,
  CampaignAdminEntitiesNotificationStatusSchema,
  CampaignAdminEntitiesSortBySchema,
  CampaignAdminEntitiesSortOrderSchema,
  CampaignAdminEntitiesCursorSchema,
  CampaignAdminEntitiesListQuerySchema,
  CampaignAdminEntityDetailQuerySchema,
  CampaignAdminAvailableInteractionTypeSchema,
  CampaignAdminEntityListItemSchema,
  CampaignAdminEntityResponseSchema,
  CampaignAdminEntitiesListResponseSchema,
  CampaignAdminEntitiesMetaSchema,
  CampaignAdminEntitiesMetaResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignAdminEntityParams,
  type CampaignAdminEntitiesCursor,
  type CampaignAdminEntityDetailQuery,
  type CampaignAdminEntitiesListQuery,
} from './shell/rest/schemas.js';
