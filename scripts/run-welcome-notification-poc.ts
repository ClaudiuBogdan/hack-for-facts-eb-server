import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Redis } from 'ioredis';
import { Kysely, PostgresDialect } from 'kysely';
import { ok, err } from 'neverthrow';
import pg from 'pg';
import createPinoLogger, { type Logger } from 'pino';

import { makeEmailClient } from '../src/infra/email/client.js';
import { makeQueueClient, QUEUE_NAMES } from '../src/infra/queue/client.js';
import { makeUnsubscribeTokenSigner } from '../src/infra/unsubscribe/token.js';
import { makeEmailRenderer } from '../src/modules/email-templates/index.js';
import {
  createComposeWorker,
  createSendWorker,
  createWorkerManager,
  enqueueTransactionalWelcomeNotification,
  getErrorMessage,
  getDefaultMockNotificationDir,
  makeComposeJobScheduler,
  makeDeliveryRepo,
  makeMockEmailSender,
  createEmailSendError,
} from '../src/modules/notification-delivery/index.js';

import type { UserDatabase } from '../src/infra/database/user/types.js';
import type { EmailSenderPort } from '../src/modules/notification-delivery/core/ports.js';
import type {
  ComposeJobPayload,
  SendJobPayload,
} from '../src/modules/notification-delivery/core/types.js';

const { Pool } = pg;

const getArgValue = (name: string): string | undefined => {
  const arg = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return arg?.slice(name.length + 1);
};

const sleep = async (delayMs: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
};

/**
 * Wraps the infra EmailSender (Resend SDK) as an EmailSenderPort
 * compatible with the notification-delivery module.
 */
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

const main = async (): Promise<void> => {
  const logger: Logger = createPinoLogger({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const userDbUrl = process.env['USER_DATABASE_URL'];
  const redisUrl = process.env['BULLMQ_REDIS_URL'];

  if (userDbUrl === undefined || userDbUrl.length === 0) {
    throw new Error('USER_DATABASE_URL is required');
  }

  if (redisUrl === undefined || redisUrl.length === 0) {
    throw new Error('BULLMQ_REDIS_URL is required');
  }

  const resendApiKey = process.env['RESEND_API_KEY'];
  const useRealSender = resendApiKey !== undefined && resendApiKey.length > 0;
  const fromAddress = process.env['EMAIL_FROM_ADDRESS'] ?? 'contact@transparenta.eu';

  const userId = getArgValue('--user-id') ?? 'welcome-poc-user';
  const email = getArgValue('--email') ?? 'delivered@resend.dev';
  const sourceEventId =
    getArgValue('--source-event-id') ?? `mock-user-created-${String(Date.now())}`;
  const platformBaseUrl = process.env['PLATFORM_BASE_URL'] ?? 'http://localhost:3000';
  const bullmqPrefix = process.env['BULLMQ_PREFIX'] ?? 'transparenta:jobs';
  const mockArtifactsDir = process.env['NOTIFICATION_MOCK_DIR'] ?? getDefaultMockNotificationDir();

  const userDb = new Kysely<UserDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: userDbUrl,
        max: 5,
      }),
    }),
  });

  const redisPassword = process.env['BULLMQ_REDIS_PASSWORD'];
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
  const deliveryRepo = makeDeliveryRepo({
    db: userDb,
    logger,
  });
  const workerManager = createWorkerManager({ logger });

  const tokenSigner = makeUnsubscribeTokenSigner('poc-test-secret-minimum-32-characters!');

  const composeWorker = createComposeWorker({
    redis,
    sendQueue,
    deliveryRepo,
    notificationsRepo: {
      findById() {
        return Promise.reject(
          new Error('notificationsRepo.findById should not be called in welcome PoC')
        );
      },
      findEligibleForDelivery() {
        return Promise.resolve(ok([]));
      },
      findActiveByType() {
        return Promise.resolve(ok([]));
      },
      findActiveByTypeAndEntity() {
        return Promise.resolve(ok([]));
      },
      deactivate() {
        return Promise.resolve(ok(undefined));
      },
      isUserGloballyUnsubscribed() {
        return Promise.resolve(ok(false));
      },
    },
    tokenSigner,
    dataFetcher: {
      fetchNewsletterData() {
        return Promise.reject(new Error('fetchNewsletterData should not be called in welcome PoC'));
      },
      fetchAlertData() {
        return Promise.reject(new Error('fetchAlertData should not be called in welcome PoC'));
      },
    },
    emailRenderer: makeEmailRenderer({ logger }),
    logger,
    platformBaseUrl,
    apiBaseUrl: platformBaseUrl,
    bullmqPrefix,
  });

  const emailSender: EmailSenderPort = useRealSender
    ? makeResendEmailSenderPort({ apiKey: resendApiKey, fromAddress, logger })
    : makeMockEmailSender({ baseDir: mockArtifactsDir });

  logger.info({ mode: useRealSender ? 'resend' : 'mock', email }, 'Email sender mode');

  const sendWorker = createSendWorker({
    redis,
    deliveryRepo,
    notificationsRepo: {
      findById() {
        return Promise.resolve(ok(null));
      },
      findEligibleForDelivery() {
        return Promise.resolve(ok([]));
      },
      findActiveByType() {
        return Promise.resolve(ok([]));
      },
      findActiveByTypeAndEntity() {
        return Promise.resolve(ok([]));
      },
      deactivate() {
        return Promise.resolve(ok(undefined));
      },
      isUserGloballyUnsubscribed() {
        return Promise.resolve(ok(false));
      },
    },
    userEmailFetcher: {
      getEmail() {
        return Promise.resolve(ok(null));
      },
      getEmailsByUserIds() {
        return Promise.resolve(ok(new Map()));
      },
    },
    emailSender,
    tokenSigner,
    logger,
    apiBaseUrl: platformBaseUrl,
    environment: 'local-poc',
    bullmqPrefix,
  });

  workerManager.register('compose', composeWorker);
  workerManager.register('send', sendWorker);

  try {
    const runId = randomUUID();
    const enqueueResult = await enqueueTransactionalWelcomeNotification(
      {
        deliveryRepo,
        composeJobScheduler: makeComposeJobScheduler({ composeQueue }),
      },
      {
        runId,
        source: 'welcome_notification_poc',
        sourceEventId,
        userId,
        email,
        registeredAt: new Date().toISOString(),
      }
    );

    if (enqueueResult.isErr()) {
      throw new Error(getErrorMessage(enqueueResult.error));
    }

    const outboxId = enqueueResult.value.outbox.id;
    let finalStatus = enqueueResult.value.outbox.status;

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const outboxResult = await deliveryRepo.findById(outboxId);
      if (outboxResult.isErr()) {
        throw new Error(getErrorMessage(outboxResult.error));
      }

      if (outboxResult.value === null) {
        throw new Error(`Outbox row ${outboxId} disappeared`);
      }

      finalStatus = outboxResult.value.status;
      if (finalStatus !== 'pending' && finalStatus !== 'sending') {
        break;
      }

      await sleep(250);
    }

    const artifactDir = useRealSender ? null : path.join(mockArtifactsDir, outboxId);
    logger.info(
      {
        outboxId,
        created: enqueueResult.value.created,
        finalStatus,
        mode: useRealSender ? 'resend' : 'mock',
        ...(artifactDir !== null ? { artifactDir } : {}),
      },
      'Welcome notification PoC completed'
    );

    console.log(
      JSON.stringify(
        {
          outboxId,
          created: enqueueResult.value.created,
          finalStatus,
          mode: useRealSender ? 'resend' : 'mock',
          ...(artifactDir !== null ? { artifactDir } : {}),
        },
        null,
        2
      )
    );
  } finally {
    await workerManager.stopAll();
    await queueClient.close();
    await redis.quit();
    await userDb.destroy();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
