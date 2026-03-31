/**
 * Compose Worker
 *
 * Renders email templates and creates or updates notification outbox rows.
 */

import { Worker, type Queue } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { composeExistingOutbox } from './compose-outbox.js';
import { composeSubscription } from './compose-subscription.js';

import type { EmailRenderer } from '../../../../email-templates/core/ports.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
  DataFetcher,
} from '../../../core/ports.js';
import type { ComposeJobPayload, SendJobPayload } from '../../../core/types.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface ComposeWorkerDeps {
  redis: Redis;
  sendQueue: Queue<SendJobPayload>;
  deliveryRepo: DeliveryRepository;
  notificationsRepo: ExtendedNotificationsRepository;
  tokenSigner: UnsubscribeTokenSigner;
  dataFetcher: DataFetcher;
  emailRenderer: EmailRenderer;
  logger: Logger;
  platformBaseUrl: string;
  apiBaseUrl: string;
  bullmqPrefix: string;
  concurrency?: number;
}

/**
 * Creates the compose worker.
 */
export const createComposeWorker = (deps: ComposeWorkerDeps): Worker<ComposeJobPayload> => {
  const {
    redis,
    sendQueue,
    deliveryRepo,
    notificationsRepo,
    tokenSigner,
    dataFetcher,
    emailRenderer,
    logger,
    platformBaseUrl,
    apiBaseUrl,
    bullmqPrefix,
    concurrency = 5,
  } = deps;

  const log = logger.child({ worker: 'compose' });

  return new Worker<ComposeJobPayload>(
    QUEUE_NAMES.COMPOSE,
    async (job) => {
      log.debug({ jobId: job.id, payload: job.data }, 'Processing compose job');

      if (job.data.kind === 'subscription') {
        return composeSubscription(
          {
            sendQueue,
            deliveryRepo,
            notificationsRepo,
            tokenSigner,
            dataFetcher,
            emailRenderer,
            platformBaseUrl,
            apiBaseUrl,
            log,
          },
          job.data
        );
      }

      return composeExistingOutbox(
        {
          sendQueue,
          deliveryRepo,
          notificationsRepo,
          tokenSigner,
          dataFetcher,
          emailRenderer,
          platformBaseUrl,
          apiBaseUrl,
          log,
        },
        job.data
      );
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
    }
  );
};

export { composeSubscription } from './compose-subscription.js';
export { composeExistingOutbox } from './compose-outbox.js';
