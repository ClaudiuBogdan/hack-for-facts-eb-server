import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import { err, ok, type Result } from 'neverthrow';
import pg from 'pg';
import createPinoLogger, { type Logger } from 'pino';

import { makeEmailClient } from '../src/infra/email/client.js';
import { makeQueueClient, QUEUE_NAMES } from '../src/infra/queue/client.js';
import { makeUnsubscribeTokenSigner } from '../src/infra/unsubscribe/token.js';
import {
  makeAggregatedLineItemsRepo,
  makePopulationRepo,
} from '../src/modules/aggregated-line-items/index.js';
import { createDatasetRepo } from '../src/modules/datasets/index.js';
import { makeEmailRenderer } from '../src/modules/email-templates/index.js';
import {
  makeEntityAnalyticsSummaryRepo,
  makeEntityProfileRepo,
  makeEntityRepo,
} from '../src/modules/entity/index.js';
import { NormalizationService } from '../src/modules/normalization/index.js';
import {
  createComposeWorker,
  createSendWorker,
  createWorkerManager,
  createEmailSendError,
  getDefaultMockNotificationDir,
  getErrorMessage,
  MAX_RETRY_ATTEMPTS,
  makeBudgetDataFetcher,
  makeClerkUserEmailFetcher,
  makeComposeJobScheduler,
  makeDeliveryRepo,
  makeMockEmailSender,
  makeExtendedNotificationsRepo,
  materializeAnafForexebugDigests,
  type ComposeJobPayload,
  type DeliveryRecord,
  type EmailSenderPort,
  type ExtendedNotificationsRepository,
  type SendJobPayload,
} from '../src/modules/notification-delivery/index.js';
import { generatePeriodKey, type NotificationType } from '../src/modules/notifications/index.js';

import type { BudgetDatabase } from '../src/infra/database/budget/types.js';
import type { UserDatabase } from '../src/infra/database/user/types.js';
import type { Queue } from 'bullmq';

const { Pool } = pg;

const DEFAULT_USER_ID = 'user_33khfjyOugrQuZitvM1GLTWfeeg';
const DEFAULT_PLATFORM_BASE_URL = 'http://localhost:3000';
const DEFAULT_BULLMQ_PREFIX = 'transparenta:jobs';
const DEFAULT_EMAIL_FROM_ADDRESS = 'contact@transparenta.eu';
const DEFAULT_POLL_ATTEMPTS = 120;
const DEFAULT_POLL_INTERVAL_MS = 500;
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT_ENV_FILE = path.join(PROJECT_ROOT, '.env');
const MONTHLY_SOURCE_TYPES: readonly NotificationType[] = [
  'newsletter_entity_monthly',
  'alert_series_analytics',
  'alert_series_static',
] as const;
const SUCCESS_STATUSES = new Set(['sent', 'delivered']);
const ACTIVE_STATUSES = new Set(['pending', 'sending', 'failed_transient']);

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const sleep = async (delayMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
};

const createDbClient = <T>(connectionString: string, ssl: boolean): Kysely<T> => {
  return new Kysely<T>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 5,
        connectionTimeoutMillis: 30_000,
        idleTimeoutMillis: 60_000,
        ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      }),
    }),
  });
};

const makeResendEmailSenderPort = (config: {
  apiKey: string;
  fromAddress: string;
  logger: Logger;
}): EmailSenderPort => {
  const client = makeEmailClient(config);

  return {
    async send(params) {
      const result = await client.send({
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        idempotencyKey: params.idempotencyKey,
        unsubscribeUrl: params.unsubscribeUrl,
        tags: params.tags,
      });

      if (result.isErr()) {
        return err(createEmailSendError(result.error.message, result.error.retryable));
      }

      return ok({ emailId: result.value.emailId });
    },
  };
};

const makeScopedNotificationsRepo = (
  repo: ExtendedNotificationsRepository,
  userId: string
): ExtendedNotificationsRepository => ({
  async findById(notificationId) {
    return repo.findById(notificationId);
  },
  async findEligibleForDelivery(notificationType, periodKey, limit) {
    const result = await repo.findEligibleForDelivery(notificationType, periodKey);
    if (result.isErr()) {
      return result;
    }

    const scoped = result.value.filter((notification) => notification.userId === userId);
    return ok(limit === undefined ? scoped : scoped.slice(0, limit));
  },
  async deactivate(notificationId) {
    return repo.deactivate(notificationId);
  },
  async findActiveByTypeAndEntity(notificationType, entityCui) {
    const result = await repo.findActiveByTypeAndEntity(notificationType, entityCui);
    if (result.isErr()) {
      return result;
    }

    return ok(result.value.filter((notification) => notification.userId === userId));
  },
  async isUserGloballyUnsubscribed(candidateUserId) {
    return repo.isUserGloballyUnsubscribed(candidateUserId);
  },
});

const listEligibleByType = async (
  repo: ExtendedNotificationsRepository,
  periodKey: string
): Promise<
  Result<
    {
      notificationType: NotificationType;
      count: number;
      notificationIds: string[];
    }[],
    Error
  >
> => {
  const summaries: {
    notificationType: NotificationType;
    count: number;
    notificationIds: string[];
  }[] = [];

  for (const notificationType of MONTHLY_SOURCE_TYPES) {
    const result = await repo.findEligibleForDelivery(notificationType, periodKey);
    if (result.isErr()) {
      return err(new Error(getErrorMessage(result.error)));
    }

    summaries.push({
      notificationType,
      count: result.value.length,
      notificationIds: result.value.map((notification) => notification.id),
    });
  }

  return ok(summaries);
};

const waitForOutboxStatus = async (
  deliveryRepo: ReturnType<typeof makeDeliveryRepo>,
  outboxId: string
): Promise<DeliveryRecord> => {
  let lastRecord: DeliveryRecord | null = null;

  for (let attempt = 0; attempt < DEFAULT_POLL_ATTEMPTS; attempt += 1) {
    const outboxResult = await deliveryRepo.findById(outboxId);
    if (outboxResult.isErr()) {
      throw new Error(getErrorMessage(outboxResult.error));
    }

    if (outboxResult.value === null) {
      throw new Error(`Outbox row ${outboxId} disappeared`);
    }

    lastRecord = outboxResult.value;
    if (!ACTIVE_STATUSES.has(lastRecord.status)) {
      return lastRecord;
    }

    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }

  if (lastRecord === null) {
    throw new Error(`Failed to read outbox row ${outboxId}`);
  }

  return lastRecord;
};

const enqueueSendJob = async (
  sendQueue: Queue<SendJobPayload>,
  outboxId: string
): Promise<void> => {
  await sendQueue.add(
    'send',
    { outboxId },
    {
      jobId: `send-${outboxId}`,
      attempts: MAX_RETRY_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
};

const requeueExistingRenderedOutbox = async (
  deliveryRepo: ReturnType<typeof makeDeliveryRepo>,
  sendQueue: Queue<SendJobPayload>,
  outboxId: string
): Promise<boolean> => {
  const outboxResult = await deliveryRepo.findById(outboxId);
  if (outboxResult.isErr()) {
    throw new Error(getErrorMessage(outboxResult.error));
  }

  const outbox = outboxResult.value;
  if (outbox === null) {
    throw new Error(`Outbox row ${outboxId} disappeared before requeue`);
  }

  if (SUCCESS_STATUSES.has(outbox.status) || ACTIVE_STATUSES.has(outbox.status)) {
    return false;
  }

  if (
    outbox.renderedSubject === null ||
    outbox.renderedHtml === null ||
    outbox.renderedText === null
  ) {
    return false;
  }

  const updateResult = await deliveryRepo.updateStatus(outboxId, {
    status: 'failed_transient',
    lastError:
      outbox.lastError ?? 'Retrying existing rendered outbox from monthly notification PoC',
  });
  if (updateResult.isErr()) {
    throw new Error(getErrorMessage(updateResult.error));
  }

  await enqueueSendJob(sendQueue, outboxId);
  return true;
};

const main = async (): Promise<void> => {
  if (existsSync(ROOT_ENV_FILE)) {
    process.loadEnvFile(ROOT_ENV_FILE);
  }

  const logger: Logger = createPinoLogger({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const budgetDbUrl = process.env['BUDGET_DATABASE_URL'];
  const userDbUrl = process.env['USER_DATABASE_URL'];
  const redisUrl = process.env['BULLMQ_REDIS_URL'];
  const clerkSecretKey = process.env['CLERK_SECRET_KEY'];
  const unsubscribeHmacSecret = process.env['UNSUBSCRIBE_HMAC_SECRET'];

  if (budgetDbUrl === undefined || budgetDbUrl.length === 0) {
    throw new Error('BUDGET_DATABASE_URL is required');
  }

  if (userDbUrl === undefined || userDbUrl.length === 0) {
    throw new Error('USER_DATABASE_URL is required');
  }

  if (redisUrl === undefined || redisUrl.length === 0) {
    throw new Error('BULLMQ_REDIS_URL is required');
  }

  if (clerkSecretKey === undefined || clerkSecretKey.length === 0) {
    throw new Error('CLERK_SECRET_KEY is required');
  }

  if (unsubscribeHmacSecret === undefined || unsubscribeHmacSecret.length < 32) {
    throw new Error('UNSUBSCRIBE_HMAC_SECRET is required and must be at least 32 characters');
  }

  const ssl = process.env['DATABASE_SSL'] === 'true';
  const userId = getArgValue('--user-id') ?? DEFAULT_USER_ID;
  const periodKey =
    getArgValue('--period-key') ?? generatePeriodKey('newsletter_entity_monthly', new Date());
  const bullmqPrefix =
    getArgValue('--queue-prefix') ??
    `${process.env['BULLMQ_PREFIX'] ?? DEFAULT_BULLMQ_PREFIX}:monthly-poc:${String(Date.now())}`;
  const platformBaseUrl = process.env['PLATFORM_BASE_URL'] ?? DEFAULT_PLATFORM_BASE_URL;
  const resendApiKey = process.env['RESEND_API_KEY'];
  const fromAddress = process.env['EMAIL_FROM_ADDRESS'] ?? DEFAULT_EMAIL_FROM_ADDRESS;
  const useRealSender = resendApiKey !== undefined && resendApiKey.length > 0;
  const mockArtifactsDir = process.env['NOTIFICATION_MOCK_DIR'] ?? getDefaultMockNotificationDir();
  const redisPassword = process.env['BULLMQ_REDIS_PASSWORD'];
  const datasetsRoot = path.join(PROJECT_ROOT, 'datasets', 'yaml');

  const budgetDb = createDbClient<BudgetDatabase>(budgetDbUrl, ssl);
  const userDb = createDbClient<UserDatabase>(userDbUrl, ssl);

  const baseNotificationsRepo = makeExtendedNotificationsRepo({
    db: userDb,
    logger,
  });
  const scopedNotificationsRepo = makeScopedNotificationsRepo(baseNotificationsRepo, userId);
  const deliveryRepo = makeDeliveryRepo({
    db: userDb,
    logger,
  });

  const eligibleSummaryResult = await listEligibleByType(scopedNotificationsRepo, periodKey);
  if (eligibleSummaryResult.isErr()) {
    throw eligibleSummaryResult.error;
  }

  const eligibleSummary = eligibleSummaryResult.value;
  const totalEligible = eligibleSummary.reduce((sum, entry) => sum + entry.count, 0);

  if (totalEligible === 0) {
    console.log(
      JSON.stringify(
        {
          userId,
          periodKey,
          queuePrefix: bullmqPrefix,
          eligibleSummary,
          success: false,
          reason: 'No eligible monthly notifications found for the requested user.',
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    await budgetDb.destroy();
    await userDb.destroy();
    return;
  }

  const normalization = await NormalizationService.create(
    createDatasetRepo({
      rootDir: datasetsRoot,
      logger,
    })
  );
  const dataFetcher = makeBudgetDataFetcher({
    entityRepo: makeEntityRepo(budgetDb),
    entityProfileRepo: makeEntityProfileRepo(budgetDb),
    entityAnalyticsSummaryRepo: makeEntityAnalyticsSummaryRepo(budgetDb),
    aggregatedLineItemsRepo: makeAggregatedLineItemsRepo(budgetDb),
    normalization,
    populationRepo: makePopulationRepo(budgetDb),
    datasetRepo: createDatasetRepo({
      rootDir: datasetsRoot,
      logger,
    }),
    logger,
  });
  const tokenSigner = makeUnsubscribeTokenSigner(unsubscribeHmacSecret);
  const userEmailFetcher = makeClerkUserEmailFetcher({
    secretKey: clerkSecretKey,
    logger,
  });
  const emailSender: EmailSenderPort = useRealSender
    ? makeResendEmailSenderPort({
        apiKey: resendApiKey,
        fromAddress,
        logger,
      })
    : makeMockEmailSender({ baseDir: mockArtifactsDir });
  const emailRenderer = makeEmailRenderer({ logger });

  const redis = new Redis(redisUrl, {
    ...(redisPassword !== undefined && redisPassword.length > 0 ? { password: redisPassword } : {}),
    maxRetriesPerRequest: null,
  });
  const queueClient = makeQueueClient({
    redis,
    prefix: bullmqPrefix,
    logger,
  });
  const composeQueue = queueClient.getQueue<ComposeJobPayload>(QUEUE_NAMES.COMPOSE);
  const sendQueue = queueClient.getQueue<SendJobPayload>(QUEUE_NAMES.SEND);
  const workerManager = createWorkerManager({ logger });

  const composeWorker = createComposeWorker({
    redis,
    sendQueue,
    deliveryRepo,
    notificationsRepo: baseNotificationsRepo,
    tokenSigner,
    dataFetcher,
    emailRenderer,
    logger,
    platformBaseUrl,
    apiBaseUrl: platformBaseUrl,
    bullmqPrefix,
  });
  const sendWorker = createSendWorker({
    redis,
    deliveryRepo,
    notificationsRepo: baseNotificationsRepo,
    userEmailFetcher,
    emailSender,
    tokenSigner,
    logger,
    apiBaseUrl: platformBaseUrl,
    environment: useRealSender ? 'monthly-poc-real' : 'monthly-poc-mock',
    bullmqPrefix,
  });

  workerManager.register(QUEUE_NAMES.COMPOSE, composeWorker);
  workerManager.register(QUEUE_NAMES.SEND, sendWorker);

  try {
    const runId = randomUUID();
    const materializeResult = await materializeAnafForexebugDigests(
      {
        notificationsRepo: scopedNotificationsRepo,
        deliveryRepo,
        composeJobScheduler: makeComposeJobScheduler({ composeQueue }),
      },
      {
        runId,
        periodKey,
      }
    );

    if (materializeResult.isErr()) {
      throw new Error(getErrorMessage(materializeResult.error));
    }

    let reusedExistingOutboxes = 0;
    if (materializeResult.value.composeJobsEnqueued === 0) {
      const requeueResults = await Promise.all(
        materializeResult.value.outboxIds.map(async (outboxId) =>
          requeueExistingRenderedOutbox(deliveryRepo, sendQueue, outboxId)
        )
      );
      reusedExistingOutboxes = requeueResults.filter(Boolean).length;
    }

    const finalOutboxes = await Promise.all(
      materializeResult.value.outboxIds.map(async (outboxId) => {
        const record = await waitForOutboxStatus(deliveryRepo, outboxId);
        return {
          outboxId,
          status: record.status,
          lastError: record.lastError,
          renderedSubject: record.renderedSubject,
          ...(useRealSender ? {} : { artifactDir: path.join(mockArtifactsDir, outboxId) }),
        };
      })
    );

    const allSent = finalOutboxes.every((outbox) => SUCCESS_STATUSES.has(outbox.status));
    const success =
      (materializeResult.value.composeJobsEnqueued > 0 || reusedExistingOutboxes > 0) && allSent;

    console.log(
      JSON.stringify(
        {
          userId,
          periodKey,
          runId,
          mode: useRealSender ? 'resend' : 'mock',
          queuePrefix: bullmqPrefix,
          eligibleSummary,
          digestResult: materializeResult.value,
          reusedExistingOutboxes,
          finalOutboxes,
          success,
          ...(materializeResult.value.composeJobsEnqueued === 0
            ? reusedExistingOutboxes > 0
              ? {
                  note: 'No new compose jobs were enqueued; the script retried existing rendered outbox rows for this user and period.',
                }
              : {
                  note: 'No new compose jobs were enqueued. This usually means an outbox row already exists for that user and period.',
                }
            : {}),
        },
        null,
        2
      )
    );

    if (!success) {
      process.exitCode = 1;
    }
  } finally {
    await workerManager.stopAll();
    await queueClient.close();
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    await budgetDb.destroy();
    await userDb.destroy();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
