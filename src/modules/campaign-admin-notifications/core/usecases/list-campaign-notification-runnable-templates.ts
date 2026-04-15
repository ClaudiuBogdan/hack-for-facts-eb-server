import type { CampaignNotificationRunnableTemplateRegistry } from '../ports.js';
import type { CampaignNotificationAdminCampaignKey } from '../types.js';

export const listCampaignNotificationRunnableTemplates = (
  deps: {
    runnableTemplateRegistry: CampaignNotificationRunnableTemplateRegistry;
  },
  campaignKey: CampaignNotificationAdminCampaignKey
) => {
  return deps.runnableTemplateRegistry.list(campaignKey);
};
