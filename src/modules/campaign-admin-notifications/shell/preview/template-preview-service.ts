import { err, ok, type Result } from 'neverthrow';

import {
  makeEmailRenderer,
  makeTemplateRegistry,
  type EmailRenderer,
  type ShellTemplateRegistry,
} from '@/modules/email-templates/index.js';

import {
  createDatabaseError,
  createNotFoundError,
  type CampaignAdminNotificationError,
} from '../../core/errors.js';
import { CAMPAIGN_NOTIFICATION_TEMPLATE_PREVIEW_CATALOG } from '../registry/template-preview-catalog.js';
import { listSchemaFields } from '../shared/schema-field-descriptors.js';

import type { CampaignNotificationTemplatePreviewService } from '../../core/ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationTemplateDescriptor,
  CampaignNotificationTemplatePreview,
} from '../../core/types.js';
import type { Logger } from 'pino';

interface TemplatePreviewServiceDeps {
  logger: Logger;
  renderer?: EmailRenderer;
  registry?: ShellTemplateRegistry;
}

const PREVIEW_UNSUBSCRIBE_URL = 'https://example.invalid/unsubscribe/preview';
const PREVIEW_PREFERENCES_URL = 'https://example.invalid/preferences';
const PREVIEW_PLATFORM_BASE_URL = 'https://example.invalid';

const buildPreviewProps = (exampleProps: Record<string, unknown>): Record<string, unknown> => {
  return {
    ...exampleProps,
    unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL,
    preferencesUrl: PREVIEW_PREFERENCES_URL,
    platformBaseUrl: PREVIEW_PLATFORM_BASE_URL,
    isPreview: true,
    copyrightYear: new Date().getUTCFullYear(),
  };
};

const toTemplateDescriptor = (
  registration: ReturnType<ShellTemplateRegistry['getShell']>
): CampaignNotificationTemplateDescriptor | null => {
  if (registration === undefined) {
    return null;
  }

  return {
    templateId: registration.id,
    name: registration.name,
    version: registration.version,
    description: registration.description,
    requiredFields: listSchemaFields(registration.payloadSchema, { requiredOnly: true }),
  };
};

export const makeCampaignNotificationTemplatePreviewService = (
  deps: TemplatePreviewServiceDeps
): CampaignNotificationTemplatePreviewService => {
  const registry = deps.registry ?? makeTemplateRegistry();
  const renderer = deps.renderer ?? makeEmailRenderer({ logger: deps.logger });
  const log = deps.logger.child({ component: 'CampaignNotificationTemplatePreviewService' });

  return {
    listTemplates(
      campaignKey: CampaignNotificationAdminCampaignKey
    ): Promise<
      Result<readonly CampaignNotificationTemplateDescriptor[], CampaignAdminNotificationError>
    > {
      const allowedTemplateIds = CAMPAIGN_NOTIFICATION_TEMPLATE_PREVIEW_CATALOG[campaignKey];

      return Promise.resolve(
        ok(
          allowedTemplateIds
            .map((templateId) => toTemplateDescriptor(registry.getShell(templateId)))
            .filter(
              (descriptor): descriptor is CampaignNotificationTemplateDescriptor =>
                descriptor !== null
            )
        )
      );
    },

    async getTemplatePreview(
      input
    ): Promise<Result<CampaignNotificationTemplatePreview, CampaignAdminNotificationError>> {
      const allowedTemplateIds = CAMPAIGN_NOTIFICATION_TEMPLATE_PREVIEW_CATALOG[input.campaignKey];
      if (!allowedTemplateIds.includes(input.templateId)) {
        return err(
          createNotFoundError(
            `Template "${input.templateId}" is not previewable for this campaign.`
          )
        );
      }

      const registration = registry.getShell(input.templateId);
      if (registration === undefined) {
        return err(createNotFoundError(`Template "${input.templateId}" was not found.`));
      }

      const renderResult = await renderer.render(
        buildPreviewProps(registration.exampleProps as unknown as Record<string, unknown>) as never
      );
      if (renderResult.isErr()) {
        log.error(
          { error: renderResult.error, templateId: input.templateId },
          'Failed to render campaign notification template preview'
        );
        return err(
          createDatabaseError(`Failed to render template preview for "${input.templateId}".`, false)
        );
      }

      return ok({
        templateId: registration.id,
        name: registration.name,
        version: registration.version,
        description: registration.description,
        requiredFields: listSchemaFields(registration.payloadSchema, { requiredOnly: true }),
        exampleSubject: renderResult.value.subject,
        html: renderResult.value.html,
        text: renderResult.value.text,
      });
    },
  };
};
