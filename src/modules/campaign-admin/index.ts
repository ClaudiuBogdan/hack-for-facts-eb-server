export type { CampaignAdminPermissionAuthorizer } from './core/ports.js';
export { FUNKY_CAMPAIGN_ADMIN_PERMISSION } from './core/policies.js';

export {
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminAuthorizationFailure,
  type CampaignAdminAuthorizationResult,
} from './shell/rest/authorization.js';

export {
  makeClerkCampaignAdminPermissionAuthorizer,
  type ClerkCampaignAdminPermissionAuthorizerOptions,
} from './shell/security/clerk-permission-authorizer.js';
