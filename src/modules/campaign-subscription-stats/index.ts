export type { CampaignSubscriptionStats } from './core/types.js';
export type { CampaignSubscriptionStatsError } from './core/errors.js';
export type { CampaignSubscriptionStatsReader } from './core/ports.js';

export {
  createCampaignNotFoundError,
  createDatabaseError,
  getHttpStatusForError,
} from './core/errors.js';

export {
  makeCampaignSubscriptionStatsReader,
  type CampaignSubscriptionStatsRepoOptions,
} from './shell/repo/campaign-subscription-stats-repo.js';

export {
  makeCampaignSubscriptionStatsRoutes,
  type MakeCampaignSubscriptionStatsRoutesDeps,
} from './shell/rest/routes.js';

export {
  CampaignSubscriptionStatsParamsSchema,
  CampaignSubscriptionStatsResponseSchema,
  ErrorResponseSchema,
  type CampaignSubscriptionStatsParams,
} from './shell/rest/schemas.js';
