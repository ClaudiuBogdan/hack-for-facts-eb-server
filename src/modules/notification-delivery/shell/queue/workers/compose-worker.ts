/**
 * Compose Worker
 *
 * Renders email templates and creates delivery records.
 */

import { createHash } from 'node:crypto';

import { Worker, type Queue } from 'bullmq';

import { generateDeliveryKey, type Notification } from '../../../../notifications/core/types.js';
import { getErrorMessage } from '../../../core/errors.js';

import type { EmailRenderer } from '../../../../email-templates/core/ports.js';
import type {
  EmailTemplateProps,
  NewsletterEntityProps,
  AlertSeriesProps,
} from '../../../../email-templates/core/types.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
  ExtendedTokensRepository,
  DataFetcher,
} from '../../../core/ports.js';
import type { ComposeJobPayload, SendJobPayload } from '../../../core/types.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the compose worker.
 */
export interface ComposeWorkerDeps {
  redis: Redis;
  sendQueue: Queue<SendJobPayload>;
  deliveryRepo: DeliveryRepository;
  notificationsRepo: ExtendedNotificationsRepository;
  tokensRepo: ExtendedTokensRepository;
  dataFetcher: DataFetcher;
  emailRenderer: EmailRenderer;
  logger: Logger;
  platformBaseUrl: string;
  bullmqPrefix: string;
  concurrency?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a content hash for change detection.
 */
const hashContent = (html: string, text: string): string => {
  return createHash('sha256').update(html).update(text).digest('hex').substring(0, 16);
};

/**
 * Extracts period type from notification type.
 */
const getPeriodType = (notificationType: string): 'monthly' | 'quarterly' | 'yearly' => {
  if (notificationType.includes('monthly')) return 'monthly';
  if (notificationType.includes('quarterly')) return 'quarterly';
  if (notificationType.includes('yearly')) return 'yearly';
  return 'monthly';
};

/**
 * Formats period key to human-readable label.
 */
const formatPeriodLabel = (
  periodKey: string,
  periodType: 'monthly' | 'quarterly' | 'yearly'
): string => {
  const parts = periodKey.split('-');
  const year = parts[0] ?? periodKey;

  switch (periodType) {
    case 'monthly': {
      const months = [
        'Ianuarie',
        'Februarie',
        'Martie',
        'Aprilie',
        'Mai',
        'Iunie',
        'Iulie',
        'August',
        'Septembrie',
        'Octombrie',
        'Noiembrie',
        'Decembrie',
      ];
      const monthIndex = Number.parseInt(parts[1] ?? '1', 10) - 1;
      const monthName = months[monthIndex] ?? months[0] ?? 'Ianuarie';
      return `${monthName} ${year}`;
    }
    case 'quarterly':
      return `${parts[1] ?? 'Q1'} ${year}`;
    case 'yearly':
      return year;
    default:
      return periodKey;
  }
};

/**
 * Builds template props from notification and fetched data.
 */
const buildTemplateProps = async (
  notification: Notification,
  periodKey: string,
  unsubscribeUrl: string,
  platformBaseUrl: string,
  dataFetcher: DataFetcher,
  log: Logger
): Promise<EmailTemplateProps | null> => {
  const notificationType = notification.notificationType;

  // Handle newsletter types
  if (notificationType.startsWith('newsletter_entity')) {
    const periodType = getPeriodType(notificationType);
    const entityCui = notification.entityCui;

    if (entityCui === null) {
      log.warn({ notificationId: notification.id }, 'Newsletter notification missing entityCui');
      return null;
    }

    const dataResult = await dataFetcher.fetchNewsletterData(entityCui, periodKey, periodType);

    if (dataResult.isErr()) {
      log.warn(
        { notificationId: notification.id, error: dataResult.error },
        'Failed to fetch newsletter data'
      );
      return null;
    }

    const data = dataResult.value;

    const props: NewsletterEntityProps = {
      templateType: 'newsletter_entity',
      lang: 'ro',
      unsubscribeUrl,
      platformBaseUrl,
      entityName: data.entityName,
      entityCui: data.entityCui,
      periodType,
      periodLabel: formatPeriodLabel(periodKey, periodType),
      summary: {
        totalIncome: data.totalIncome,
        totalExpenses: data.totalExpenses,
        budgetBalance: data.budgetBalance,
        currency: data.currency,
      },
      detailsUrl: `${platformBaseUrl}/entities/${entityCui}`,
      // Extended entity info (optional)
      ...(data.entityType !== undefined ? { entityType: data.entityType } : {}),
      ...(data.countyName !== undefined ? { countyName: data.countyName } : {}),
      ...(data.population !== undefined ? { population: data.population } : {}),
      // Period comparison (optional)
      ...(data.previousPeriodComparison !== undefined
        ? { previousPeriodComparison: data.previousPeriodComparison }
        : {}),
      // Detailed breakdowns (optional)
      ...(data.topExpenseCategories !== undefined
        ? { topExpenseCategories: data.topExpenseCategories }
        : {}),
      ...(data.fundingSources !== undefined ? { fundingSources: data.fundingSources } : {}),
      ...(data.perCapita !== undefined ? { perCapita: data.perCapita } : {}),
      // Map URL (optional)
      ...(data.mapUrl !== undefined ? { mapUrl: data.mapUrl } : {}),
    };

    return props;
  }

  // Handle alert types
  if (notificationType.startsWith('alert_')) {
    const config = notification.config ?? {};
    const dataResult = await dataFetcher.fetchAlertData(config, periodKey);

    if (dataResult.isErr()) {
      log.warn(
        { notificationId: notification.id, error: dataResult.error },
        'Failed to fetch alert data'
      );
      return null;
    }

    if (dataResult.value === null) {
      log.debug({ notificationId: notification.id }, 'Alert conditions not triggered, skipping');
      return null;
    }

    const data = dataResult.value;

    const props: AlertSeriesProps = {
      templateType: 'alert_series',
      lang: 'ro',
      unsubscribeUrl,
      platformBaseUrl,
      title: data.title,
      ...(data.description !== undefined ? { description: data.description } : {}),
      triggeredConditions: data.triggeredConditions,
    };

    return props;
  }

  log.warn({ notificationId: notification.id, notificationType }, 'Unknown notification type');
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the compose worker.
 *
 * The compose worker:
 * 1. Fetches the notification
 * 2. Checks for existing delivery (dedupe)
 * 3. Gets/creates unsubscribe token
 * 4. Fetches data and renders template
 * 5. Creates delivery record in 'pending' status
 * 6. Enqueues send job
 */
export const createComposeWorker = (deps: ComposeWorkerDeps): Worker<ComposeJobPayload> => {
  const {
    redis,
    sendQueue,
    deliveryRepo,
    notificationsRepo,
    tokensRepo,
    dataFetcher,
    emailRenderer,
    logger,
    platformBaseUrl,
    bullmqPrefix,
    concurrency = 5,
  } = deps;

  const log = logger.child({ worker: 'compose' });

  return new Worker<ComposeJobPayload>(
    'notification:compose',
    async (job) => {
      const { runId, notificationId, periodKey } = job.data;

      log.debug({ runId, notificationId, periodKey }, 'Processing compose job');

      // 1. Fetch notification
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

      // 2. Generate delivery key and check for existing delivery
      const deliveryKey = generateDeliveryKey(notification.userId, notificationId, periodKey);

      const existsResult = await deliveryRepo.existsByDeliveryKey(deliveryKey);

      if (existsResult.isErr()) {
        log.error({ error: existsResult.error }, 'Failed to check delivery existence');
        throw new Error(getErrorMessage(existsResult.error));
      }

      if (existsResult.value) {
        log.debug({ deliveryKey }, 'Delivery already exists, skipping');
        return { runId, notificationId, status: 'skipped_duplicate' };
      }

      // 3. Get or create unsubscribe token
      const tokenResult = await tokensRepo.getOrCreateActive(notification.userId, notificationId);

      if (tokenResult.isErr()) {
        log.error({ error: tokenResult.error }, 'Failed to get/create unsubscribe token');
        throw new Error(getErrorMessage(tokenResult.error));
      }

      const unsubscribeToken = tokenResult.value;
      const unsubscribeUrl = `${platformBaseUrl}/api/v1/notifications/unsubscribe/${unsubscribeToken}`;

      // 4. Build template props and render
      const templateProps = await buildTemplateProps(
        notification,
        periodKey,
        unsubscribeUrl,
        platformBaseUrl,
        dataFetcher,
        log
      );

      if (templateProps === null) {
        // No data or conditions not met - create a skipped delivery record
        log.debug({ notificationId }, 'Template props could not be built, skipping');
        return { runId, notificationId, status: 'skipped_no_data' };
      }

      const renderResult = await emailRenderer.render(templateProps);

      if (renderResult.isErr()) {
        log.error({ error: renderResult.error }, 'Failed to render email template');
        throw new Error(`${renderResult.error.type}: ${renderResult.error.message}`);
      }

      const rendered = renderResult.value;
      const contentHash = hashContent(rendered.html, rendered.text);

      // 5. Create delivery record in 'pending' status
      const createResult = await deliveryRepo.create({
        userId: notification.userId,
        notificationId,
        periodKey,
        deliveryKey,
        unsubscribeToken,
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
        // Check if it's a duplicate error (race condition)
        if (createResult.error.type === 'DuplicateDelivery') {
          log.debug({ deliveryKey }, 'Delivery created by another worker, skipping');
          return { runId, notificationId, status: 'skipped_duplicate' };
        }

        log.error({ error: createResult.error }, 'Failed to create delivery record');
        throw new Error(getErrorMessage(createResult.error));
      }

      const delivery = createResult.value;

      // 6. Enqueue send job
      await sendQueue.add(
        'send',
        { deliveryId: delivery.id },
        {
          // Use delivery ID as job ID to prevent duplicate sends
          jobId: `send:${delivery.id}`,
        }
      );

      log.info(
        { runId, notificationId, deliveryId: delivery.id },
        'Delivery composed and send job enqueued'
      );

      return {
        runId,
        notificationId,
        deliveryId: delivery.id,
        status: 'composed',
      };
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
    }
  );
};
