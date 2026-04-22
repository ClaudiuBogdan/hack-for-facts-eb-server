export type {
  CampaignEntityConfigCampaignKey,
  CampaignEntityConfigPublicDebate,
  CampaignEntityConfigValues,
  CampaignEntityConfigDto,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
  CampaignEntityConfigListCursor,
  GetCampaignEntityConfigInput,
  UpsertCampaignEntityConfigInput,
  ListCampaignEntityConfigsInput,
  ListCampaignEntityConfigsOutput,
} from './core/types.js';

export {
  CampaignEntityConfigPublicDebateSchema,
  CampaignEntityConfigValuesSchema,
  CampaignEntityConfigStoredPayloadSchema,
  createDefaultCampaignEntityConfig,
  normalizeCampaignEntityConfigValues,
} from './core/config-record.js';

export type {
  CampaignEntityConfigDatabaseError,
  CampaignEntityConfigValidationError,
  CampaignEntityConfigNotFoundError,
  CampaignEntityConfigConflictError,
  CampaignEntityConfigError,
} from './core/errors.js';

export {
  createDatabaseError,
  createValidationError,
  createNotFoundError,
  createConflictError,
  getHttpStatusForError,
} from './core/errors.js';

export {
  getCampaignEntityConfig,
  type GetCampaignEntityConfigDeps,
} from './core/usecases/get-campaign-entity-config.js';
export {
  upsertCampaignEntityConfig,
  type UpsertCampaignEntityConfigDeps,
} from './core/usecases/upsert-campaign-entity-config.js';
export {
  listCampaignEntityConfigs,
  type ListCampaignEntityConfigsDeps,
} from './core/usecases/list-campaign-entity-configs.js';
export {
  listPublicDebateCampaignEntityConfigs,
  type ListPublicDebateCampaignEntityConfigsInput,
  type ListPublicDebateCampaignEntityConfigsOutput,
} from './core/usecases/list-public-debate-campaign-entity-configs.js';

export {
  makeCampaignEntityConfigRoutes,
  type MakeCampaignEntityConfigRoutesDeps,
} from './shell/rest/routes.js';

export {
  CampaignKeyParamsSchema,
  CampaignEntityConfigParamsSchema,
  CampaignEntityConfigCursorSchema,
  CampaignEntityConfigSortBySchema,
  CampaignEntityConfigSortOrderSchema,
  CampaignEntityConfigListQuerySchema,
  CampaignEntityConfigExportQuerySchema,
  CampaignEntityConfigPutBodySchema,
  CampaignEntityConfigDtoSchema,
  CampaignEntityConfigResponseSchema,
  CampaignEntityConfigListResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignEntityConfigParams,
  type CampaignEntityConfigListQuery,
  type CampaignEntityConfigExportQuery,
  type CampaignEntityConfigPutBody,
} from './shell/rest/schemas.js';
