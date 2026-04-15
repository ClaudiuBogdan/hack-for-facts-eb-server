export type {
  CampaignAdminStatsCampaignKey,
  CampaignAdminStatsOverviewCoverage,
  CampaignAdminStatsOverviewUsers,
  CampaignAdminStatsOverviewInteractionReviewStatusCounts,
  CampaignAdminStatsOverviewInteractionPhaseCounts,
  CampaignAdminStatsOverviewInteractionThreadPhaseCounts,
  CampaignAdminStatsOverviewInteractions,
  CampaignAdminStatsOverviewEntities,
  CampaignAdminStatsOverviewNotifications,
  CampaignAdminStatsOverview,
  GetCampaignAdminStatsOverviewInput,
} from './core/types.js';

export type { CampaignAdminStatsError } from './core/errors.js';
export type { CampaignAdminStatsReader } from './core/ports.js';

export {
  createCampaignNotFoundError,
  createDatabaseError,
  getHttpStatusForError,
} from './core/errors.js';

export {
  getCampaignAdminStatsOverview,
  type GetCampaignAdminStatsOverviewDeps,
} from './core/usecases/get-campaign-admin-stats-overview.js';

export {
  makeCampaignAdminStatsReader,
  type CampaignAdminStatsRepoOptions,
} from './shell/repo/campaign-admin-stats-repo.js';

export {
  makeCampaignAdminStatsRoutes,
  type MakeCampaignAdminStatsRoutesDeps,
} from './shell/rest/routes.js';

export {
  CampaignKeyParamsSchema,
  CampaignAdminStatsOverviewSchema,
  CampaignAdminStatsOverviewResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
} from './shell/rest/schemas.js';
