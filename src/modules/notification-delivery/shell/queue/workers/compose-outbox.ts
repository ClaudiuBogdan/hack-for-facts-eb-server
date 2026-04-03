import { err, ok, type Result } from 'neverthrow';

import { formatPeriodLabel } from '@/common/utils/format-period-label.js';
import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';

import {
  buildCampaignPreferencesUrl,
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
  PublicDebateCampaignWelcomeProps,
  PublicDebateEntitySubscriptionProps,
  PublicDebateEntityUpdateProps,
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

const buildPublicDebateCampaignWelcomeTemplateProps = (
  outbox: NotificationOutboxRecord,
  platformBaseUrl: string,
  unsubscribeUrl: string
): Result<PublicDebateCampaignWelcomeProps, string> => {
  const campaignKey =
    typeof outbox.metadata['campaignKey'] === 'string' ? outbox.metadata['campaignKey'] : null;
  const entityCui =
    typeof outbox.metadata['entityCui'] === 'string' ? outbox.metadata['entityCui'] : null;
  const entityName =
    typeof outbox.metadata['entityName'] === 'string' ? outbox.metadata['entityName'] : null;
  const acceptedTermsAt =
    typeof outbox.metadata['acceptedTermsAt'] === 'string'
      ? outbox.metadata['acceptedTermsAt']
      : null;

  if (campaignKey === null)
    return err('Invalid public debate welcome metadata: campaignKey is required');
  if (entityCui === null)
    return err('Invalid public debate welcome metadata: entityCui is required');
  if (entityName === null || entityName.trim() === '') {
    return err('Invalid public debate welcome metadata: entityName is required');
  }
  if (acceptedTermsAt === null) {
    return err('Invalid public debate welcome metadata: acceptedTermsAt is required');
  }

  const acceptedTermsAtDate = new Date(acceptedTermsAt);
  const copyrightYear = Number.isNaN(acceptedTermsAtDate.getTime())
    ? outbox.createdAt.getUTCFullYear()
    : acceptedTermsAtDate.getUTCFullYear();
  const preferencesUrl = buildCampaignPreferencesUrl(platformBaseUrl);

  return ok({
    templateType: 'public_debate_campaign_welcome',
    lang: 'ro',
    unsubscribeUrl,
    preferencesUrl,
    platformBaseUrl,
    copyrightYear,
    campaignKey,
    entityCui,
    entityName,
    acceptedTermsAt,
    ctaUrl: `${platformBaseUrl}/entities/${entityCui}`,
  });
};

const buildPublicDebateEntitySubscriptionTemplateProps = (
  outbox: NotificationOutboxRecord,
  platformBaseUrl: string,
  unsubscribeUrl: string
): Result<PublicDebateEntitySubscriptionProps, string> => {
  const campaignKey =
    typeof outbox.metadata['campaignKey'] === 'string' ? outbox.metadata['campaignKey'] : null;
  const entityCui =
    typeof outbox.metadata['entityCui'] === 'string' ? outbox.metadata['entityCui'] : null;
  const entityName =
    typeof outbox.metadata['entityName'] === 'string' ? outbox.metadata['entityName'] : null;
  const acceptedTermsAt =
    typeof outbox.metadata['acceptedTermsAt'] === 'string'
      ? outbox.metadata['acceptedTermsAt']
      : null;
  const selectedEntitiesValue = outbox.metadata['selectedEntities'];
  const selectedEntities = Array.isArray(selectedEntitiesValue)
    ? selectedEntitiesValue
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())
    : undefined;

  if (campaignKey === null) {
    return err('Invalid public debate entity subscription metadata: campaignKey is required');
  }
  if (entityCui === null) {
    return err('Invalid public debate entity subscription metadata: entityCui is required');
  }
  if (entityName === null || entityName.trim() === '') {
    return err('Invalid public debate entity subscription metadata: entityName is required');
  }
  if (acceptedTermsAt === null) {
    return err('Invalid public debate entity subscription metadata: acceptedTermsAt is required');
  }

  const acceptedTermsAtDate = new Date(acceptedTermsAt);
  const copyrightYear = Number.isNaN(acceptedTermsAtDate.getTime())
    ? outbox.createdAt.getUTCFullYear()
    : acceptedTermsAtDate.getUTCFullYear();
  const preferencesUrl = buildCampaignPreferencesUrl(platformBaseUrl);

  return ok({
    templateType: 'public_debate_entity_subscription',
    lang: 'ro',
    unsubscribeUrl,
    preferencesUrl,
    platformBaseUrl,
    copyrightYear,
    campaignKey,
    entityCui,
    entityName,
    acceptedTermsAt,
    ...(selectedEntities !== undefined && selectedEntities.length > 0 ? { selectedEntities } : {}),
    ctaUrl: `${platformBaseUrl}/entities/${entityCui}`,
  });
};

const buildPublicDebateEntityUpdateTemplateProps = (
  outbox: NotificationOutboxRecord,
  platformBaseUrl: string,
  unsubscribeUrl: string
): Result<PublicDebateEntityUpdateProps, string> => {
  const eventType =
    typeof outbox.metadata['eventType'] === 'string' ? outbox.metadata['eventType'] : null;
  const campaignKey =
    typeof outbox.metadata['campaignKey'] === 'string' ? outbox.metadata['campaignKey'] : null;
  const entityCui =
    typeof outbox.metadata['entityCui'] === 'string' ? outbox.metadata['entityCui'] : null;
  const entityName =
    typeof outbox.metadata['entityName'] === 'string' ? outbox.metadata['entityName'] : null;
  const threadId =
    typeof outbox.metadata['threadId'] === 'string' ? outbox.metadata['threadId'] : null;
  const threadKey =
    typeof outbox.metadata['threadKey'] === 'string' ? outbox.metadata['threadKey'] : null;
  const phase = typeof outbox.metadata['phase'] === 'string' ? outbox.metadata['phase'] : null;
  const institutionEmail =
    typeof outbox.metadata['institutionEmail'] === 'string'
      ? outbox.metadata['institutionEmail']
      : null;
  const subjectLine =
    typeof outbox.metadata['subject'] === 'string' ? outbox.metadata['subject'] : null;
  const occurredAt =
    typeof outbox.metadata['occurredAt'] === 'string' ? outbox.metadata['occurredAt'] : null;

  if (
    eventType !== 'thread_started' &&
    eventType !== 'thread_failed' &&
    eventType !== 'reply_received' &&
    eventType !== 'reply_reviewed'
  ) {
    return err('Invalid public debate update metadata: eventType is missing or invalid');
  }

  if (campaignKey === null)
    return err('Invalid public debate update metadata: campaignKey is required');
  if (entityCui === null)
    return err('Invalid public debate update metadata: entityCui is required');
  if (threadId === null) return err('Invalid public debate update metadata: threadId is required');
  if (threadKey === null)
    return err('Invalid public debate update metadata: threadKey is required');
  if (phase === null) return err('Invalid public debate update metadata: phase is required');
  if (institutionEmail === null) {
    return err('Invalid public debate update metadata: institutionEmail is required');
  }
  if (subjectLine === null)
    return err('Invalid public debate update metadata: subject is required');
  if (occurredAt === null)
    return err('Invalid public debate update metadata: occurredAt is required');

  const occurredAtDate = new Date(occurredAt);
  const copyrightYear = Number.isNaN(occurredAtDate.getTime())
    ? new Date().getUTCFullYear()
    : occurredAtDate.getUTCFullYear();
  const replyTextPreview = outbox.metadata['replyTextPreview'];
  const resolutionCode = outbox.metadata['resolutionCode'];
  const reviewNotes = outbox.metadata['reviewNotes'];
  const preferencesUrl = buildCampaignPreferencesUrl(platformBaseUrl);

  return ok({
    templateType: 'public_debate_entity_update',
    lang: 'ro',
    unsubscribeUrl,
    preferencesUrl,
    platformBaseUrl,
    copyrightYear,
    eventType,
    campaignKey,
    entityCui,
    ...(entityName !== null && entityName.trim() !== '' ? { entityName } : {}),
    threadId,
    threadKey,
    phase,
    institutionEmail,
    subjectLine,
    occurredAt,
    ...(typeof replyTextPreview === 'string' || replyTextPreview === null
      ? { replyTextPreview }
      : {}),
    ...(typeof resolutionCode === 'string' || resolutionCode === null ? { resolutionCode } : {}),
    ...(typeof reviewNotes === 'string' || reviewNotes === null ? { reviewNotes } : {}),
  });
};

const persistRenderedOutboxAndEnqueueSend = async (input: {
  deliveryRepo: DeliveryRepository;
  sendQueue: Queue<SendJobPayload>;
  outbox: NotificationOutboxRecord;
  runId: string;
  rendered: {
    subject: string;
    html: string;
    text: string;
    templateName: string;
    templateVersion: string;
  };
  log: Logger;
  updateFailureLogMessage: string;
  successLogMessage: string;
}): Promise<{
  runId: string;
  outboxId: string;
  status: 'composed';
}> => {
  const contentHash = hashContent(input.rendered.html, input.rendered.text);
  const updateResult = await input.deliveryRepo.updateRenderedContent(input.outbox.id, {
    renderedSubject: input.rendered.subject,
    renderedHtml: input.rendered.html,
    renderedText: input.rendered.text,
    contentHash,
    templateName: input.rendered.templateName,
    templateVersion: input.rendered.templateVersion,
  });

  if (updateResult.isErr()) {
    await releaseComposeClaim(
      input.deliveryRepo,
      input.outbox.id,
      getErrorMessage(updateResult.error),
      input.log
    );
    input.log.error(
      { error: updateResult.error, outboxId: input.outbox.id },
      input.updateFailureLogMessage
    );
    throw new Error(getErrorMessage(updateResult.error));
  }

  await releaseComposeClaim(input.deliveryRepo, input.outbox.id, undefined, input.log);
  await enqueueSendJob(input.sendQueue, input.outbox.id);

  input.log.info(
    {
      runId: input.runId,
      outboxId: input.outbox.id,
      notificationType: input.outbox.notificationType,
    },
    input.successLogMessage
  );

  return {
    runId: input.runId,
    outboxId: input.outbox.id,
    status: 'composed',
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
    outbox.notificationType !== 'funky:outbox:welcome' &&
    outbox.notificationType !== 'funky:outbox:entity_subscription' &&
    outbox.notificationType !== 'funky:outbox:entity_update' &&
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

    return persistRenderedOutboxAndEnqueueSend({
      deliveryRepo,
      sendQueue,
      outbox,
      runId,
      rendered: renderResult.value,
      log,
      updateFailureLogMessage: 'Failed to update welcome outbox row',
      successLogMessage: 'Welcome notification composed and send job enqueued',
    });
  }

  if (outbox.notificationType === 'funky:outbox:welcome') {
    const templatePropsResult = buildPublicDebateCampaignWelcomeTemplateProps(
      outbox,
      platformBaseUrl,
      unsubscribeUrl
    );

    if (templatePropsResult.isErr()) {
      return failOutboxPermanently(
        deliveryRepo,
        outbox.id,
        runId,
        templatePropsResult.error,
        log,
        'Public debate campaign welcome compose failed permanently'
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
        'Public debate campaign welcome render failed permanently'
      );
    }

    return persistRenderedOutboxAndEnqueueSend({
      deliveryRepo,
      sendQueue,
      outbox,
      runId,
      rendered: renderResult.value,
      log,
      updateFailureLogMessage: 'Failed to update public debate campaign welcome outbox row',
      successLogMessage: 'Public debate campaign welcome composed and send job enqueued',
    });
  }

  if (outbox.notificationType === 'funky:outbox:entity_subscription') {
    const templatePropsResult = buildPublicDebateEntitySubscriptionTemplateProps(
      outbox,
      platformBaseUrl,
      unsubscribeUrl
    );

    if (templatePropsResult.isErr()) {
      return failOutboxPermanently(
        deliveryRepo,
        outbox.id,
        runId,
        templatePropsResult.error,
        log,
        'Public debate entity subscription compose failed permanently'
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
        'Public debate entity subscription render failed permanently'
      );
    }

    return persistRenderedOutboxAndEnqueueSend({
      deliveryRepo,
      sendQueue,
      outbox,
      runId,
      rendered: renderResult.value,
      log,
      updateFailureLogMessage: 'Failed to update public debate entity subscription outbox row',
      successLogMessage: 'Public debate entity subscription composed and send job enqueued',
    });
  }

  if (outbox.notificationType === 'funky:outbox:entity_update') {
    const templatePropsResult = buildPublicDebateEntityUpdateTemplateProps(
      outbox,
      platformBaseUrl,
      unsubscribeUrl
    );

    if (templatePropsResult.isErr()) {
      return failOutboxPermanently(
        deliveryRepo,
        outbox.id,
        runId,
        templatePropsResult.error,
        log,
        'Public debate update compose failed permanently'
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
        'Public debate update render failed permanently'
      );
    }

    return persistRenderedOutboxAndEnqueueSend({
      deliveryRepo,
      sendQueue,
      outbox,
      runId,
      rendered: renderResult.value,
      log,
      updateFailureLogMessage: 'Failed to update public debate outbox row',
      successLogMessage: 'Public debate notification composed and send job enqueued',
    });
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

  return persistRenderedOutboxAndEnqueueSend({
    deliveryRepo,
    sendQueue,
    outbox,
    runId,
    rendered: renderResult.value,
    log,
    updateFailureLogMessage: 'Failed to update bundle outbox row',
    successLogMessage: 'Outbox notification composed and send job enqueued',
  });
};
