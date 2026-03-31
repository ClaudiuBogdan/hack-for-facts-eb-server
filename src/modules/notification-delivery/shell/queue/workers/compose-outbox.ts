import { err, ok, type Result } from 'neverthrow';

import { formatPeriodLabel } from '@/common/utils/format-period-label.js';
import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';

import {
  buildNotificationSettingsUrl,
  type BundleComposeError,
  formatTemplateError,
  getPeriodYear,
  hashContent,
  mapNewsletterDataToTemplateFields,
  mapTriggeredConditionsToTemplateFields,
  toDecimalString,
} from './compose-helpers.js';
import { getErrorMessage, isRetryableError, type DeliveryError } from '../../../core/errors.js';
import {
  parseAnafForexebugDigestScopeKey,
  isBundleOutboxType,
  isReadyToSendDelivery,
  TERMINAL_STATUSES,
  type ComposeOutboxJobPayload,
  type NotificationOutboxRecord,
  type SendJobPayload,
} from '../../../core/types.js';
import { enqueueSendJob } from '../send-job-options.js';

import type { EmailRenderer } from '../../../../email-templates/core/ports.js';
import type {
  AnafForexebugDigestProps,
  AnafForexebugDigestSection,
  EmailTemplateProps,
  WelcomeEmailProps,
} from '../../../../email-templates/core/types.js';
import type { Notification } from '../../../../notifications/core/types.js';
import type {
  DataFetcher,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../../../core/ports.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

export interface ComposeExistingOutboxDeps {
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

const failOutboxPermanently = async (
  deliveryRepo: DeliveryRepository,
  outboxId: string,
  runId: string,
  errorMessage: string,
  log: Logger,
  logMessage: string
): Promise<{
  runId: string;
  outboxId: string;
  status: 'failed_permanent';
  error: string;
}> => {
  const updateResult = await deliveryRepo.updateStatusIfCurrentIn(
    outboxId,
    ['composing', 'pending'],
    'failed_permanent',
    { lastError: errorMessage }
  );

  if (updateResult.isErr()) {
    log.error(
      { error: updateResult.error, outboxId },
      'Failed to persist permanent compose failure'
    );
    throw new Error(getErrorMessage(updateResult.error));
  }

  log.warn({ outboxId, error: errorMessage }, logMessage);

  return {
    runId,
    outboxId,
    status: 'failed_permanent',
    error: errorMessage,
  };
};

const releaseComposeClaim = async (
  deliveryRepo: DeliveryRepository,
  outboxId: string,
  lastError: string | undefined,
  log: Logger
): Promise<void> => {
  const updateResult = await deliveryRepo.updateStatusIfCurrentIn(
    outboxId,
    ['composing'],
    'pending',
    lastError !== undefined ? { lastError } : undefined
  );

  if (updateResult.isErr()) {
    log.error({ error: updateResult.error, outboxId }, 'Failed to release compose claim');
    throw new Error(getErrorMessage(updateResult.error));
  }

  if (!updateResult.value) {
    log.warn({ outboxId }, 'Outbox row changed state before compose claim release');
  }
};

const buildWelcomeTemplateProps = (
  outbox: NotificationOutboxRecord,
  platformBaseUrl: string,
  unsubscribeUrl: string
): WelcomeEmailProps | null => {
  const registeredAtValue =
    typeof outbox.metadata['registeredAt'] === 'string'
      ? outbox.metadata['registeredAt']
      : outbox.createdAt.toISOString();

  if (!isNonEmptyString(registeredAtValue)) {
    return null;
  }

  const registeredAtDate = new Date(registeredAtValue);
  const registeredAt = Number.isNaN(registeredAtDate.getTime())
    ? outbox.createdAt.toISOString()
    : registeredAtValue;
  const preferencesUrl = buildNotificationSettingsUrl(platformBaseUrl);

  return {
    templateType: 'welcome',
    lang: 'ro',
    unsubscribeUrl,
    preferencesUrl,
    platformBaseUrl,
    copyrightYear: new Date(registeredAt).getUTCFullYear(),
    registeredAt,
    ctaUrl: platformBaseUrl,
  };
};

const buildNewsletterBundleSection = async (
  notification: Notification,
  periodKey: string,
  platformBaseUrl: string,
  dataFetcher: DataFetcher
): Promise<Result<AnafForexebugDigestSection | null, DeliveryError>> => {
  if (notification.entityCui === null) {
    return ok(null);
  }

  const dataResult = await dataFetcher.fetchNewsletterData(
    notification.entityCui,
    periodKey,
    'monthly'
  );

  if (dataResult.isErr()) {
    return err(dataResult.error);
  }

  const data = dataResult.value;

  return ok({
    kind: 'newsletter_entity',
    notificationId: notification.id,
    notificationType: notification.notificationType,
    periodLabel: data.periodLabel,
    detailsUrl: `${platformBaseUrl}/entities/${notification.entityCui}`,
    ...mapNewsletterDataToTemplateFields(data),
  });
};

const buildAlertBundleSection = async (
  notification: Notification,
  periodKey: string,
  dataFetcher: DataFetcher
): Promise<Result<AnafForexebugDigestSection | null, DeliveryError>> => {
  const config = notification.config ?? {};
  const dataResult = await dataFetcher.fetchAlertData(config, periodKey);

  if (dataResult.isErr()) {
    return err(dataResult.error);
  }

  if (dataResult.value === null) {
    return ok(null);
  }

  return ok({
    kind: 'alert_series',
    notificationId: notification.id,
    notificationType: notification.notificationType,
    title: dataResult.value.title,
    actualValue: toDecimalString(dataResult.value.actualValue),
    unit: dataResult.value.unit,
    triggeredConditions: mapTriggeredConditionsToTemplateFields(
      dataResult.value.triggeredConditions
    ),
    ...(dataResult.value.description !== undefined
      ? { description: dataResult.value.description }
      : {}),
  });
};

const buildAnafForexebugDigestSection = async (
  notification: Notification,
  periodKey: string,
  platformBaseUrl: string,
  dataFetcher: DataFetcher
): Promise<Result<AnafForexebugDigestSection | null, DeliveryError>> => {
  if (notification.notificationType === 'newsletter_entity_monthly') {
    return buildNewsletterBundleSection(notification, periodKey, platformBaseUrl, dataFetcher);
  }

  if (
    notification.notificationType === 'alert_series_analytics' ||
    notification.notificationType === 'alert_series_static'
  ) {
    return buildAlertBundleSection(notification, periodKey, dataFetcher);
  }

  return ok(null);
};

const buildBundleTemplateProps = async (
  outbox: NotificationOutboxRecord,
  platformBaseUrl: string,
  unsubscribeUrl: string,
  notificationsRepo: ExtendedNotificationsRepository,
  dataFetcher: DataFetcher,
  log: Logger
): Promise<Result<EmailTemplateProps, BundleComposeError>> => {
  const sourceNotificationIds = outbox.metadata['sourceNotificationIds'];
  const preferencesUrl = buildNotificationSettingsUrl(platformBaseUrl);

  if (!Array.isArray(sourceNotificationIds) || !sourceNotificationIds.every(isNonEmptyString)) {
    return err({
      message: 'Invalid bundle metadata: sourceNotificationIds must be a non-empty string array',
      retryable: false,
    });
  }

  if (outbox.notificationType !== 'anaf_forexebug_digest') {
    return err({
      message: `Unsupported bundle notification type: ${outbox.notificationType}`,
      retryable: false,
    });
  }

  const periodKey = parseAnafForexebugDigestScopeKey(outbox.scopeKey);
  if (periodKey === null) {
    return err({
      message: `Invalid ANAF / Forexebug digest scope: ${outbox.scopeKey}`,
      retryable: false,
    });
  }

  const sections: AnafForexebugDigestSection[] = [];

  for (const notificationId of sourceNotificationIds) {
    const notificationResult = await notificationsRepo.findById(notificationId);

    if (notificationResult.isErr()) {
      return err({
        message: `Failed to load source notification '${notificationId}': ${getErrorMessage(notificationResult.error)}`,
        retryable: isRetryableError(notificationResult.error),
      });
    }

    const notification = notificationResult.value;

    if (notification === null) {
      log.warn(
        { outboxId: outbox.id, notificationId },
        'Bundle source notification not found, skipping'
      );
      continue;
    }

    if (!notification.isActive) {
      log.debug(
        { outboxId: outbox.id, notificationId },
        'Bundle source notification inactive, skipping'
      );
      continue;
    }

    const sectionResult = await buildAnafForexebugDigestSection(
      notification,
      periodKey,
      platformBaseUrl,
      dataFetcher
    );

    if (sectionResult.isErr()) {
      return err({
        message: `Failed to build bundle section for '${notificationId}': ${getErrorMessage(sectionResult.error)}`,
        retryable: isRetryableError(sectionResult.error),
      });
    }

    if (sectionResult.value === null) {
      log.debug(
        { outboxId: outbox.id, notificationId },
        'Bundle source notification not renderable, skipping'
      );
      continue;
    }

    sections.push(sectionResult.value);
  }

  if (sections.length === 0) {
    return err({
      message: 'No renderable bundle items',
      retryable: false,
    });
  }

  const periodLabel =
    typeof outbox.metadata['periodLabel'] === 'string'
      ? outbox.metadata['periodLabel']
      : formatPeriodLabel(periodKey, 'monthly');

  const props: AnafForexebugDigestProps = {
    templateType: 'anaf_forexebug_digest',
    lang: 'ro',
    unsubscribeUrl,
    preferencesUrl,
    platformBaseUrl,
    copyrightYear: getPeriodYear(periodKey),
    periodKey,
    periodLabel,
    sections,
  };

  return ok(props);
};

export const composeExistingOutbox = async (
  deps: ComposeExistingOutboxDeps,
  payload: ComposeOutboxJobPayload
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
  const { runId, outboxId } = payload;

  const claimResult = await deliveryRepo.claimForCompose(outboxId);
  if (claimResult.isErr()) {
    log.error({ error: claimResult.error, outboxId }, 'Failed to claim outbox row for compose');
    throw new Error(getErrorMessage(claimResult.error));
  }

  if (claimResult.value === null) {
    const outboxResult = await deliveryRepo.findById(outboxId);
    if (outboxResult.isErr()) {
      log.error({ error: outboxResult.error, outboxId }, 'Failed to fetch outbox row');
      throw new Error(getErrorMessage(outboxResult.error));
    }

    const outbox = outboxResult.value;
    if (outbox === null) {
      log.warn({ outboxId }, 'Outbox row not found, skipping');
      return { runId, outboxId, status: 'skipped_not_found' };
    }

    if (TERMINAL_STATUSES.includes(outbox.status)) {
      log.info(
        { outboxId, status: outbox.status },
        'Outbox row already in terminal state, skipping'
      );
      return { runId, outboxId, status: 'skipped_terminal_state' };
    }

    if (isReadyToSendDelivery(outbox)) {
      await enqueueSendJob(sendQueue, outbox.id);
      log.info(
        { outboxId, status: outbox.status },
        'Re-enqueued send job for ready-to-send outbox row'
      );
      return { runId, outboxId, status: 'requeued_send', resendQueued: true };
    }

    log.info({ outboxId, status: outbox.status }, 'Outbox row is not claimable for compose');
    return { runId, outboxId, status: 'skipped_status' };
  }

  const outbox = claimResult.value;

  if (
    outbox.notificationType !== 'transactional_welcome' &&
    !isBundleOutboxType(outbox.notificationType)
  ) {
    return failOutboxPermanently(
      deliveryRepo,
      outbox.id,
      runId,
      `Unsupported outbox notification type: ${outbox.notificationType}`,
      log,
      'Outbox compose path received an unsupported notification type'
    );
  }

  const unsubscribeToken = tokenSigner.sign(outbox.userId);
  const unsubscribeUrl = `${apiBaseUrl}/api/v1/notifications/unsubscribe/${unsubscribeToken}`;

  if (outbox.notificationType === 'transactional_welcome') {
    const templateProps = buildWelcomeTemplateProps(outbox, platformBaseUrl, unsubscribeUrl);

    if (templateProps === null) {
      return failOutboxPermanently(
        deliveryRepo,
        outbox.id,
        runId,
        'Invalid welcome outbox metadata: registeredAt is required',
        log,
        'Welcome outbox compose failed permanently'
      );
    }

    const renderResult = await emailRenderer.render(templateProps);
    if (renderResult.isErr()) {
      return failOutboxPermanently(
        deliveryRepo,
        outbox.id,
        runId,
        formatTemplateError(renderResult.error),
        log,
        'Welcome outbox compose failed permanently'
      );
    }

    const rendered = renderResult.value;
    const contentHash = hashContent(rendered.html, rendered.text);
    const updateResult = await deliveryRepo.updateRenderedContent(outbox.id, {
      renderedSubject: rendered.subject,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
      contentHash,
      templateName: rendered.templateName,
      templateVersion: rendered.templateVersion,
    });

    if (updateResult.isErr()) {
      await releaseComposeClaim(deliveryRepo, outbox.id, getErrorMessage(updateResult.error), log);
      log.error({ error: updateResult.error, outboxId }, 'Failed to update welcome outbox row');
      throw new Error(getErrorMessage(updateResult.error));
    }

    await releaseComposeClaim(deliveryRepo, outbox.id, undefined, log);
    await enqueueSendJob(sendQueue, outbox.id);

    log.info({ runId, outboxId }, 'Welcome notification composed and send job enqueued');

    return {
      runId,
      outboxId,
      status: 'composed',
    };
  }

  const templatePropsResult = await buildBundleTemplateProps(
    outbox,
    platformBaseUrl,
    unsubscribeUrl,
    notificationsRepo,
    dataFetcher,
    log
  );

  if (templatePropsResult.isErr()) {
    if (templatePropsResult.error.retryable) {
      await releaseComposeClaim(deliveryRepo, outbox.id, templatePropsResult.error.message, log);
      log.warn(
        { outboxId, error: templatePropsResult.error.message },
        'Retryable bundle notification compose failure'
      );
      throw new Error(templatePropsResult.error.message);
    }

    return failOutboxPermanently(
      deliveryRepo,
      outbox.id,
      runId,
      templatePropsResult.error.message,
      log,
      'Bundle notification compose failed permanently'
    );
  }

  const renderResult = await emailRenderer.render(templatePropsResult.value);
  if (renderResult.isErr()) {
    return failOutboxPermanently(
      deliveryRepo,
      outbox.id,
      runId,
      formatTemplateError(renderResult.error),
      log,
      'Bundle notification render failed permanently'
    );
  }

  const rendered = renderResult.value;
  const contentHash = hashContent(rendered.html, rendered.text);
  const updateResult = await deliveryRepo.updateRenderedContent(outbox.id, {
    renderedSubject: rendered.subject,
    renderedHtml: rendered.html,
    renderedText: rendered.text,
    contentHash,
    templateName: rendered.templateName,
    templateVersion: rendered.templateVersion,
  });

  if (updateResult.isErr()) {
    await releaseComposeClaim(deliveryRepo, outbox.id, getErrorMessage(updateResult.error), log);
    log.error({ error: updateResult.error, outboxId }, 'Failed to update bundle outbox row');
    throw new Error(getErrorMessage(updateResult.error));
  }

  await releaseComposeClaim(deliveryRepo, outbox.id, undefined, log);
  await enqueueSendJob(sendQueue, outbox.id);

  log.info(
    { runId, outboxId, notificationType: outbox.notificationType },
    'Outbox notification composed and send job enqueued'
  );

  return {
    runId,
    outboxId,
    status: 'composed',
  };
};
