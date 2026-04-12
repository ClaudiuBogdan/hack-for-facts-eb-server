import type { CampaignNotificationTemplatePreviewService } from '../ports.js';
import type { CampaignNotificationAdminCampaignKey } from '../types.js';

export const listCampaignNotificationTemplates = (
  deps: {
    templatePreviewService: CampaignNotificationTemplatePreviewService;
  },
  campaignKey: CampaignNotificationAdminCampaignKey
) => {
  return deps.templatePreviewService.listTemplates(campaignKey);
};
