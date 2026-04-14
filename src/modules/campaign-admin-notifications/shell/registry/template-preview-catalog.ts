import type { CampaignNotificationAdminCampaignKey } from '../../core/types.js';

export const CAMPAIGN_NOTIFICATION_TEMPLATE_PREVIEW_CATALOG: Readonly<
  Record<CampaignNotificationAdminCampaignKey, readonly string[]>
> = {
  funky: [
    'admin_reviewed_user_interaction',
    'public_debate_campaign_welcome',
    'public_debate_entity_subscription',
    'public_debate_entity_update',
    'public_debate_admin_failure',
  ],
};
