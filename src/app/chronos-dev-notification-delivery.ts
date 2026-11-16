import { readFileSync } from 'node:fs';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import {
  assertUserDataOwnerCanWrite,
  UserDataOwnerDeletedError,
} from '../infra/database/user/owner-write-guard.js';
import { makeWebhookVerifier } from '../infra/email/client.js';
import { makeUnsubscribeTokenSigner } from '../infra/unsubscribe/token.js';
import { makeEmailRenderer } from '../modules/email-templates/index.js';
import {
  createEmailSendError,
  createValidationError,
  makeDeliveryRepo,
  makeExtendedNotificationsRepo,
  startNotificationDeliveryRuntime,
  type EmailSenderPort,
} from '../modules/notification-delivery/index.js';
import {
  makeResendWebhookRoutes,
  type ResendEmailWebhookEvent,
} from '../modules/resend-webhooks/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { QueueRedisHealthConfig } from '../infra/queue/redis-health.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

const clientBaseUrl = 'https://dev-chronos.transparenta.eu';
const apiBaseUrl = 'https://dev-chronos-api.transparenta.eu';
const recipient = 'delivered+test1@resend.dev';
const testOwner = 'chronos-dev-notification-delivery-test';
const notificationType = 'transactional_welcome';
const deliveryKey = `${notificationType}:${testOwner}`;
const environment = 'chronos_dev';
const providerId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SendResponseSchema = Type.Object({ id: Type.String({ pattern: providerId.source }) });

interface SendConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly unsubscribeSecret: string;
  readonly redis: QueueRedisHealthConfig;
}

interface ChronosDevEmailConfig {
  readonly signingSecret: string;
  readonly send?: SendConfig;
}

export function loadChronosDevEmailConfig(
  env: NodeJS.ProcessEnv,
  configuredClientBaseUrl: string | undefined,
  redis: QueueRedisHealthConfig | undefined
): ChronosDevEmailConfig | undefined {
  const enabled = env['NOTIFICATION_DELIVERY_ENABLED'];
  if (enabled !== undefined && enabled !== 'false' && enabled !== 'true') {
    throw new Error('NOTIFICATION_DELIVERY_ENABLED must be true or false');
  }
  const signingSecret = env['RESEND_WEBHOOK_SECRET'];
  if (signingSecret === undefined && enabled !== 'true') return undefined;
  if (
    configuredClientBaseUrl !== clientBaseUrl ||
    !/^whsec_[A-Za-z0-9+/=_-]+$/.test(signingSecret ?? '')
  ) {
    throw new Error(
      'Chronos dev delivery requires its development client and Resend signing secret'
    );
  }
  if (signingSecret === undefined) throw new Error('Missing Chronos dev Resend signing secret');
  if (enabled !== 'true') return { signingSecret };
  const apiKey = env['RESEND_API_KEY'];
  const from = env['EMAIL_FROM_ADDRESS']?.trim();
  const unsubscribeSecret = env['UNSUBSCRIBE_HMAC_SECRET'];
  if (
    apiKey === undefined ||
    !/^re_[A-Za-z0-9_-]+$/.test(apiKey) ||
    from === undefined ||
    from === '' ||
    unsubscribeSecret === undefined ||
    unsubscribeSecret.length < 32 ||
    redis === undefined
  ) {
    throw new Error(
      'Chronos dev delivery requires Resend sender credentials, unsubscribe signing and Redis TLS'
    );
  }
  return { signingSecret, send: { apiKey, from, unsubscribeSecret, redis } };
}

function getTag(event: ResendEmailWebhookEvent, name: string): string | undefined {
  const tags = event.data.tags;
  return Array.isArray(tags) ? tags.find((tag) => tag.name === name)?.value : tags?.[name];
}

export function makeChronosDevDeliveryReceiptHandler(db: UserDbClient, logger: Logger) {
  return async (event: ResendEmailWebhookEvent, svixId: string) => {
    const outboxId = getTag(event, 'delivery_id');
    if (
      event.type !== 'email.delivered' ||
      getTag(event, 'env') !== environment ||
      getTag(event, 'notification_type') !== notificationType ||
      outboxId === undefined ||
      !providerId.test(outboxId) ||
      !providerId.test(event.data.email_id) ||
      event.data.to.length !== 1 ||
      event.data.to[0]?.toLowerCase() !== recipient ||
      (event.data.cc?.length ?? 0) !== 0 ||
      (event.data.bcc?.length ?? 0) !== 0
    )
      return 'ignored' as const;

    const sentAt = new Date(event.data.created_at);
    if (!Number.isFinite(sentAt.getTime())) throw new Error('Invalid Resend message timestamp');

    try {
      return await db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          await assertUserDataOwnerCanWrite(transaction, testOwner);
          const row = await transaction
            .selectFrom('notificationsoutbox')
            .select(['status', 'resend_email_id', 'sent_at'])
            .where('id', '=', outboxId)
            .where('delivery_key', '=', deliveryKey)
            .where('user_id', '=', testOwner)
            .where('to_email', '=', recipient)
            .where('notification_type', '=', notificationType)
            .where('attempt_count', '>', 0)
            .forUpdate()
            .executeTakeFirst();
          if (
            row === undefined ||
            (row.resend_email_id !== null && row.resend_email_id !== event.data.email_id)
          ) {
            return 'ignored' as const;
          }
          if (row.status === 'delivered') return 'processed' as const;
          if (!['sending', 'sent', 'failed_transient', 'webhook_timeout'].includes(row.status)) {
            return 'ignored' as const;
          }
          await transaction
            .updateTable('notificationsoutbox')
            .set({
              status: 'delivered',
              resend_email_id: event.data.email_id,
              sent_at: row.sent_at ?? sentAt,
            })
            .where('id', '=', outboxId)
            .executeTakeFirst();
          logger.info(
            { outboxId, svixId, emailId: event.data.email_id },
            'Chronos dev Resend delivery confirmed'
          );
          return 'processed' as const;
        });
    } catch (error) {
      if (error instanceof UserDataOwnerDeletedError) return 'ignored' as const;
      throw error;
    }
  };
}

export function makeChronosDevTestSender(
  db: UserDbClient,
  outboxId: string,
  config: Pick<SendConfig, 'apiKey' | 'from'>,
  sendRequest = fetch
): EmailSenderPort {
  return {
    async send(params) {
      if (
        params.to !== recipient ||
        params.userId !== testOwner ||
        params.notificationType !== notificationType ||
        params.idempotencyKey !== outboxId
      )
        return err(createValidationError('Email is outside the Chronos dev delivery test'));

      try {
        return await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (transaction) => {
            await assertUserDataOwnerCanWrite(transaction, testOwner);
            const row = await transaction
              .selectFrom('notificationsoutbox')
              .select(['resend_email_id', 'status'])
              .where('id', '=', outboxId)
              .where('user_id', '=', testOwner)
              .where('delivery_key', '=', deliveryKey)
              .where('notification_type', '=', notificationType)
              .where('to_email', '=', recipient)
              .forUpdate()
              .executeTakeFirst();
            if (row?.resend_email_id != null) return ok({ emailId: row.resend_email_id });
            if (row?.status !== 'sending')
              return err(createValidationError('Test delivery is no longer sendable'));

            const response = await sendRequest('https://api.resend.com/emails', {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(8000),
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': outboxId,
              },
              body: JSON.stringify({
                from: config.from,
                to: [recipient],
                subject: params.subject,
                html: params.html,
                text: params.text,
                tags: params.tags,
                headers: {
                  'List-Unsubscribe': `<${params.unsubscribeUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                },
              }),
            });
            if (!response.ok) {
              return err(
                createEmailSendError(
                  `Resend returned HTTP ${String(response.status)}`,
                  response.status === 429 || response.status >= 500
                )
              );
            }
            const body: unknown = await response.json();
            if (!Value.Check(SendResponseSchema, body)) {
              return err(
                createEmailSendError('Resend response did not identify the message', true)
              );
            }
            await transaction
              .updateTable('notificationsoutbox')
              .set({ resend_email_id: body.id })
              .where('id', '=', outboxId)
              .executeTakeFirst();
            return ok({ emailId: body.id });
          });
      } catch (error) {
        if (error instanceof UserDataOwnerDeletedError) {
          return err(createValidationError('The test delivery owner was deleted'));
        }
        return err(createEmailSendError('Chronos dev send outcome could not be confirmed', true));
      }
    },
  };
}

export async function registerChronosDevNotificationDelivery(
  app: FastifyInstance,
  db: UserDbClient,
  config: ChronosDevEmailConfig
): Promise<void> {
  const logger = app.log as Logger;
  await app.register(async (scope) => {
    await scope.register(
      makeResendWebhookRoutes({
        webhookVerifier: makeWebhookVerifier({ webhookSecret: config.signingSecret, logger }),
        onVerifiedEvent: makeChronosDevDeliveryReceiptHandler(db, logger),
        logger,
      })
    );
    const send = config.send;
    if (send === undefined) return;

    const outbox = await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (transaction) => {
        await assertUserDataOwnerCanWrite(transaction, testOwner);
        const repo = makeDeliveryRepo({ db: transaction, logger });
        const existing = await repo.findByDeliveryKey(deliveryKey);
        if (existing.isErr()) throw new Error('Unable to find Chronos dev test outbox');
        if (existing.value !== null) return existing.value;
        const created = await repo.create({
          userId: testOwner,
          notificationType,
          scopeKey: 'welcome',
          deliveryKey,
          referenceId: null,
          toEmail: recipient,
          metadata: { registeredAt: new Date().toISOString(), source: 'chronos_dev_delivery_test' },
        });
        if (created.isErr()) throw new Error('Unable to create Chronos dev test outbox');
        return created.value;
      });
    if (
      outbox.userId !== testOwner ||
      outbox.notificationType !== notificationType ||
      outbox.toEmail !== recipient
    ) {
      throw new Error('Chronos dev test outbox has unexpected identity');
    }
    // Resume only the existing outbox. Terminal or ambiguous sends require reconciliation.
    if (outbox.status !== 'pending') return;

    const runtime = await startNotificationDeliveryRuntime({
      redisUrl: send.redis.url,
      redisPassword: send.redis.password,
      redisTls: {
        ca: readFileSync(send.redis.caFile),
        rejectUnauthorized: true,
        servername: new URL(send.redis.url).hostname,
      },
      bullmqPrefix: 'chronos-dev-delivery-test',
      onlyOutboxId: outbox.id,
      logger,
      concurrency: 1,
      intervalMinutes: 5,
      thresholdMinutes: 10,
      workerDeps: {
        deliveryRepo: makeDeliveryRepo({ db, logger }),
        notificationsRepo: makeExtendedNotificationsRepo({ db, logger }),
        emailSender: makeChronosDevTestSender(db, outbox.id, send),
        emailRenderer: makeEmailRenderer({ logger }),
        tokenSigner: makeUnsubscribeTokenSigner(send.unsubscribeSecret),
        userEmailFetcher: {
          getEmail: () => Promise.resolve(ok(null)),
          getEmailsByUserIds: () => Promise.resolve(ok(new Map())),
        },
        dataFetcher: {
          fetchNewsletterData: () =>
            Promise.resolve(err(createValidationError('Newsletter delivery is unavailable'))),
          fetchAlertData: () =>
            Promise.resolve(err(createValidationError('Alert delivery is unavailable'))),
        },
        apiBaseUrl,
        platformBaseUrl: clientBaseUrl,
        environment,
        maxSendRps: 1,
      },
    });
    scope.addHook('onClose', () => runtime.stop());
    const job = await runtime.composeJobScheduler.enqueue({
      runId: 'chronos-dev-delivery-test',
      kind: 'outbox',
      outboxId: outbox.id,
    });
    if (job.isErr()) throw new Error('Unable to enqueue Chronos dev test delivery');
  });
}
