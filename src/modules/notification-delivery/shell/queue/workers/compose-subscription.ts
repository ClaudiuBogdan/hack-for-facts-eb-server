import { err, ok, type Result } from 'neverthrow';

import { formatPeriodLabel } from '@/common/utils/format-period-label.js';

import {
  buildEntityReportUrl,
  buildNotificationSettingsUrl,
  getPeriodType,
  getPeriodYear,
  hashContent,
  hasMonthlyNewsletterTemplateFields,
  mapNewsletterDataToTemplateFields,
  mapTriggeredConditionsToTemplateFields,
} from './compose-helpers.js';
import { generateDeliveryKey, type Notification } from '../../../../notifications/core/types.js';
import {
  createValidationError,
  getErrorMessage,
  type DeliveryError,
} from '../../../core/errors.js';
import {
  isReadyToSendDelivery,
  type ComposeSubscriptionJobPayload,
  type SendJobPayload,
} from '../../../core/types.js';
import { enqueueSendJob } from '../send-job-options.js';

import type { EmailRenderer } from '../../../../email-templates/core/ports.js';
import type {
  AlertSeriesProps,
  EmailTemplateProps,
  NewsletterEntityProps,
} from '../../../../email-templates/core/types.js';
import type {
  DataFetcher,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../../../core/ports.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

export interface ComposeSubscriptionDeps {
  sendQueue: Queue<SendJobPayload>;
  deliveryRepo: DeliveryRepository;
  notificationsRepo: ExtendedNotificationsRepository;
  tokenSigner: UnsubscribeTokenSigner;
  dataFetcher: DataFetcher;
  emailRenderer: EmailRenderer;
  platformBaseUrl: string;
  apiBaseUrl: string;
  log: Logger;
}

const maybeRequeueExistingDelivery = async (
  deps: Pick<ComposeSubscriptionDeps, 'deliveryRepo' | 'sendQueue' | 'log'>,
  input: {
    deliveryKey: string;
    runId: string;
    notificationId: string;
  }
): Promise<{
  runId: string;
  notificationId: string;
  outboxId: string;
  status: 'requeued_send';
} | null> => {
  const existingResult = await deps.deliveryRepo.findByDeliveryKey(input.deliveryKey);
  if (existingResult.isErr()) {
    deps.log.error(
      { error: existingResult.error, deliveryKey: input.deliveryKey },
      'Failed to load duplicate outbox row'
    );
    throw new Error(getErrorMessage(existingResult.error));
  }

  const existing = existingResult.value;
  if (existing === null || !isReadyToSendDelivery(existing)) {
    return null;
  }

  await enqueueSendJob(deps.sendQueue, existing.id);
  deps.log.info(
    { deliveryKey: input.deliveryKey, outboxId: existing.id },
    'Re-enqueued send job for duplicate subscription outbox row'
  );

  return {
    runId: input.runId,
    notificationId: input.notificationId,
    outboxId: existing.id,
    status: 'requeued_send',
  };
};

const buildSubscriptionTemplateProps = async (
  notification: Notification,
  periodKey: string,
  unsubscribeUrl: string,
  platformBaseUrl: string,
  dataFetcher: DataFetcher,
  log: Logger
): Promise<Result<EmailTemplateProps | null, DeliveryError>> => {
  const notificationType = notification.notificationType;

  if (notificationType.startsWith('newsletter_entity')) {
    const periodType = getPeriodType(notificationType);
    const entityCui = notification.entityCui;

    if (entityCui === null) {
      log.warn({ notificationId: notification.id }, 'Newsletter notification missing entityCui');
      return ok(null);
    }

    const dataResult = await dataFetcher.fetchNewsletterData(entityCui, periodKey, periodType);

    if (dataResult.isErr()) {
      log.warn(
        { notificationId: notification.id, error: dataResult.error },
        'Failed to fetch newsletter data'
      );
      return err(dataResult.error);
    }

    const data = dataResult.value;

    const newsletterFields = mapNewsletterDataToTemplateFields(data);
    const commonProps = {
      templateType: 'newsletter_entity' as const,
      lang: 'ro' as const,
      unsubscribeUrl,
      preferencesUrl: buildNotificationSettingsUrl(platformBaseUrl),
      platformBaseUrl,
      copyrightYear: getPeriodYear(periodKey),
      periodLabel: formatPeriodLabel(periodKey, periodType),
      detailsUrl: buildEntityReportUrl(platformBaseUrl, entityCui, periodKey, periodType),
      ...newsletterFields,
    };

    if (periodType === 'monthly') {
      if (!hasMonthlyNewsletterTemplateFields(newsletterFields)) {
        return err(createValidationError('Monthly newsletter data is missing monthly/YTD totals'));
      }

      const props: NewsletterEntityProps = {
        ...commonProps,
        periodType,
        monthlyDelta: newsletterFields.monthlyDelta,
        ytdSummary: newsletterFields.ytdSummary,
      };

      return ok(props);
    }

    const props: NewsletterEntityProps = {
      ...commonProps,
      periodType,
    };

    return ok(props);
  }

  if (notificationType.startsWith('alert_')) {
    const config = notification.config ?? {};
    const dataResult = await dataFetcher.fetchAlertData(config, periodKey);

    if (dataResult.isErr()) {
      log.warn(
        { notificationId: notification.id, error: dataResult.error },
        'Failed to fetch alert data'
      );
      return err(dataResult.error);
    }

    if (dataResult.value === null) {
      log.debug({ notificationId: notification.id }, 'Alert conditions not triggered, skipping');
      return ok(null);
    }

    const data = dataResult.value;

    const props: AlertSeriesProps = {
      templateType: 'alert_series',
      lang: 'ro',
      unsubscribeUrl,
      preferencesUrl: buildNotificationSettingsUrl(platformBaseUrl),
      platformBaseUrl,
      copyrightYear: getPeriodYear(periodKey),
      title: data.title,
      triggeredConditions: mapTriggeredConditionsToTemplateFields(data.triggeredConditions),
      ...(data.description !== undefined ? { description: data.description } : {}),
    };

    return ok(props);
  }

  log.warn({ notificationId: notification.id, notificationType }, 'Unknown notification type');
  return ok(null);
};

export const composeSubscription = async (
  deps: ComposeSubscriptionDeps,
  payload: ComposeSubscriptionJobPayload
) => {
  const {
    deliveryRepo,
    notificationsRepo,
    tokenSigner,
    dataFetcher,
    emailRenderer,
    platformBaseUrl,
    apiBaseUrl,
    sendQueue,
    log,
  } = deps;
  const { runId, notificationId, periodKey } = payload;

  const notificationResult = await notificationsRepo.findById(notificationId);

  if (notificationResult.isErr()) {
    log.error({ error: notificationResult.error }, 'Failed to fetch notification');
    throw new Error(getErrorMessage(notificationResult.error));
  }

  const notification = notificationResult.value;

  if (notification === null) {
    log.warn({ notificationId }, 'Notification not found, skipping');
    return { runId, notificationId, status: 'skipped_not_found' };
  }

  if (!notification.isActive) {
    log.debug({ notificationId }, 'Notification inactive, skipping');
    return { runId, notificationId, status: 'skipped_inactive' };
  }

  const deliveryKey = generateDeliveryKey(notification.userId, notificationId, periodKey);
  const existsResult = await deliveryRepo.existsByDeliveryKey(deliveryKey);

  if (existsResult.isErr()) {
    log.error({ error: existsResult.error }, 'Failed to check outbox existence');
    throw new Error(getErrorMessage(existsResult.error));
  }

  if (existsResult.value) {
    const requeued = await maybeRequeueExistingDelivery(
      { deliveryRepo, sendQueue, log },
      { deliveryKey, runId, notificationId }
    );
    if (requeued !== null) {
      return requeued;
    }

    log.debug({ deliveryKey }, 'Outbox row already exists, skipping');
    return { runId, notificationId, status: 'skipped_duplicate' };
  }

  const unsubscribeToken = tokenSigner.sign(notification.userId);
  const unsubscribeUrl = `${apiBaseUrl}/api/v1/notifications/unsubscribe/${unsubscribeToken}`;

  const templateProps = await buildSubscriptionTemplateProps(
    notification,
    periodKey,
    unsubscribeUrl,
    platformBaseUrl,
    dataFetcher,
    log
  );

  if (templateProps.isErr()) {
    log.warn(
      { notificationId, error: templateProps.error },
      'Failed to build subscription template props'
    );
    throw new Error(getErrorMessage(templateProps.error));
  }

  if (templateProps.value === null) {
    log.debug({ notificationId }, 'Template props could not be built, skipping');
    return { runId, notificationId, status: 'skipped_no_data' };
  }

  const renderResult = await emailRenderer.render(templateProps.value);

  if (renderResult.isErr()) {
    log.error({ error: renderResult.error }, 'Failed to render email template');
    throw new Error(`${renderResult.error.type}: ${renderResult.error.message}`);
  }

  const rendered = renderResult.value;
  const contentHash = hashContent(rendered.html, rendered.text);

  const createResult = await deliveryRepo.create({
    userId: notification.userId,
    notificationType: notification.notificationType,
    referenceId: notificationId,
    scopeKey: periodKey,
    deliveryKey,
    renderedSubject: rendered.subject,
    renderedHtml: rendered.html,
    renderedText: rendered.text,
    contentHash,
    templateName: rendered.templateName,
    templateVersion: rendered.templateVersion,
    metadata: {
      runId,
      notificationType: notification.notificationType,
      entityCui: notification.entityCui,
    },
  });

  if (createResult.isErr()) {
    if (createResult.error.type === 'DuplicateDelivery') {
      const requeued = await maybeRequeueExistingDelivery(
        { deliveryRepo, sendQueue, log },
        { deliveryKey, runId, notificationId }
      );
      if (requeued !== null) {
        return requeued;
      }

      log.debug({ deliveryKey }, 'Outbox row created by another worker, skipping');
      return { runId, notificationId, status: 'skipped_duplicate' };
    }

    log.error({ error: createResult.error }, 'Failed to create outbox row');
    throw new Error(getErrorMessage(createResult.error));
  }

  const outbox = createResult.value;
  await enqueueSendJob(sendQueue, outbox.id);

  log.info(
    { runId, notificationId, outboxId: outbox.id },
    'Subscription notification composed and send job enqueued'
  );

  return {
    runId,
    notificationId,
    outboxId: outbox.id,
    status: 'composed',
  };
};
