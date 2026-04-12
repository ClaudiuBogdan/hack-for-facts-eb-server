import type { CampaignNotificationTemplatePreviewService } from '../ports.js';
import type { CampaignNotificationAdminCampaignKey } from '../types.js';

export const getCampaignNotificationTemplatePreview = (
  deps: {
    templatePreviewService: CampaignNotificationTemplatePreviewService;
  },
  input: {
    campaignKey: CampaignNotificationAdminCampaignKey;
    templateId: string;
  }
) => {
  return deps.templatePreviewService.getTemplatePreview(input);
};
