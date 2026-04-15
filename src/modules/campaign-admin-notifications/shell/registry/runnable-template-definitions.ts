import { makeAdminReviewedInteractionRunnableDefinition } from './admin-reviewed-interaction-runnable.js';

import type { ReviewedInteractionTriggerDeps } from './admin-reviewed-interaction-trigger.js';
import type {
  CampaignNotificationRunnableTemplateDefinition,
  CampaignNotificationRunnableTemplateRegistry,
} from '../../core/ports.js';
import type { CampaignNotificationAdminCampaignKey } from '../../core/types.js';

export const makeCampaignNotificationRunnableTemplateRegistry = (
  deps: ReviewedInteractionTriggerDeps
): CampaignNotificationRunnableTemplateRegistry => {
  const definitions = [
    makeAdminReviewedInteractionRunnableDefinition(deps),
  ] as const satisfies readonly CampaignNotificationRunnableTemplateDefinition[];
  const byCampaign = new Map<
    CampaignNotificationAdminCampaignKey,
    Map<string, CampaignNotificationRunnableTemplateDefinition>
  >();

  for (const definition of definitions) {
    const campaignDefinitions =
      byCampaign.get(definition.campaignKey) ??
      new Map<string, CampaignNotificationRunnableTemplateDefinition>();
    campaignDefinitions.set(definition.runnableId, definition);
    byCampaign.set(definition.campaignKey, campaignDefinitions);
  }

  return {
    list(campaignKey) {
      const campaignDefinitions = byCampaign.get(campaignKey);
      if (campaignDefinitions === undefined) {
        return [];
      }

      return [...campaignDefinitions.values()].map((definition) => ({
        runnableId: definition.runnableId,
        campaignKey: definition.campaignKey,
        templateId: definition.templateId,
        templateVersion: definition.templateVersion,
        description: definition.description,
        targetKind: definition.targetKind,
        selectors: definition.selectors,
        filters: definition.filters,
        dryRunRequired: definition.dryRunRequired,
        maxPlanRowCount: definition.maxPlanRowCount,
        defaultPageSize: definition.defaultPageSize,
        maxPageSize: definition.maxPageSize,
      }));
    },
    get(campaignKey, runnableId) {
      return byCampaign.get(campaignKey)?.get(runnableId) ?? null;
    },
  };
};
