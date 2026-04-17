import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeCampaignNotificationTemplatePreviewService } from '@/modules/campaign-admin-notifications/index.js';

describe('Campaign notification template preview service', () => {
  const logger = pinoLogger({ level: 'silent' });

  it('lists only previewable Funky templates with required fields', async () => {
    const service = makeCampaignNotificationTemplatePreviewService({ logger });

    const result = await service.listTemplates('funky');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.map((item) => item.templateId)).toEqual([
        'admin_reviewed_user_interaction',
        'public_debate_admin_response_requester',
        'public_debate_admin_response_subscriber',
        'public_debate_campaign_welcome',
        'public_debate_entity_subscription',
        'public_debate_entity_update',
        'public_debate_admin_failure',
        'weekly_progress_digest',
      ]);
      expect(
        result.value.find((item) => item.templateId === 'admin_reviewed_user_interaction')
      ).toEqual(
        expect.objectContaining({
          requiredFields: expect.arrayContaining([
            expect.objectContaining({ name: 'interactionId', required: true }),
            expect.objectContaining({ name: 'reviewStatus', required: true }),
          ]),
        })
      );
    }
  });

  it('renders preview output with preview-safe URLs', async () => {
    const service = makeCampaignNotificationTemplatePreviewService({ logger });

    const result = await service.getTemplatePreview({
      campaignKey: 'funky',
      templateId: 'public_debate_campaign_welcome',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.html).toContain('example.invalid');
      expect(result.value.exampleSubject).not.toHaveLength(0);
      expect(result.value.requiredFields).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'acceptedTermsAt' })])
      );
    }
  });

  it('renders the weekly progress digest preview', async () => {
    const service = makeCampaignNotificationTemplatePreviewService({ logger });

    const result = await service.getTemplatePreview({
      campaignKey: 'funky',
      templateId: 'weekly_progress_digest',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.html).toContain('example.invalid');
      expect(result.value.exampleSubject).not.toHaveLength(0);
      expect(result.value.requiredFields).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'weekKey', required: true })])
      );
    }
  });
});
