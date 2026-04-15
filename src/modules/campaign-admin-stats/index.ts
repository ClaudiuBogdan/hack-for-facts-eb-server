export type {
  CampaignAdminStatsCampaignKey,
  CampaignAdminStatsTopEntitiesSortBy,
  CampaignAdminStatsOverviewCoverage,
  CampaignAdminStatsOverviewUsers,
  CampaignAdminStatsOverviewInteractionReviewStatusCounts,
  CampaignAdminStatsOverviewInteractionPhaseCounts,
  CampaignAdminStatsOverviewInteractionThreadPhaseCounts,
  CampaignAdminStatsOverviewInteractions,
  CampaignAdminStatsOverviewEntities,
  CampaignAdminStatsOverviewNotifications,
  CampaignAdminStatsOverview,
  CampaignAdminStatsInteractionsByTypeItem,
  CampaignAdminStatsInteractionsByType,
  CampaignAdminStatsTopEntityItem,
  CampaignAdminStatsTopEntities,
  GetCampaignAdminStatsInteractionsByTypeInput,
  GetCampaignAdminStatsOverviewInput,
  GetCampaignAdminStatsTopEntitiesInput,
} from './core/types.js';

export type { CampaignAdminStatsError } from './core/errors.js';
export type { CampaignAdminStatsReader } from './core/ports.js';

export {
  createCampaignNotFoundError,
  createDatabaseError,
  getHttpStatusForError,
} from './core/errors.js';

export {
  getCampaignAdminStatsInteractionsByType,
  type GetCampaignAdminStatsInteractionsByTypeDeps,
} from './core/usecases/get-campaign-admin-stats-interactions-by-type.js';

export {
  getCampaignAdminStatsOverview,
  type GetCampaignAdminStatsOverviewDeps,
} from './core/usecases/get-campaign-admin-stats-overview.js';

export {
  getCampaignAdminStatsTopEntities,
  type GetCampaignAdminStatsTopEntitiesDeps,
} from './core/usecases/get-campaign-admin-stats-top-entities.js';

export {
  makeCampaignAdminStatsReader,
  type CampaignAdminStatsRepoOptions,
} from './shell/repo/campaign-admin-stats-repo.js';

export {
  makeCampaignAdminStatsRoutes,
  type MakeCampaignAdminStatsRoutesDeps,
} from './shell/rest/routes.js';

export {
  CampaignAdminStatsInteractionsByTypeSchema,
  CampaignAdminStatsInteractionsByTypeResponseSchema,
  CampaignKeyParamsSchema,
  CampaignAdminStatsOverviewSchema,
  CampaignAdminStatsOverviewResponseSchema,
  CampaignAdminStatsTopEntitiesSchema,
  CampaignAdminStatsTopEntitiesQuerySchema,
  CampaignAdminStatsTopEntitiesResponseSchema,
  CampaignAdminStatsTopEntitiesSortBySchema,
  ErrorResponseSchema,
  type CampaignAdminStatsTopEntitiesQuery,
  type CampaignKeyParams,
} from './shell/rest/schemas.js';
