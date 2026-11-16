import { readFileSync } from 'node:fs';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import {
  campaignWelcomeKey,
  chronosDevCampaignMarker,
  chronosDevTestRecipient as recipient,
  loadChronosDevCampaignConfig,
  makeChronosDevCampaignWelcomeCapture,
  type ChronosDevCampaignConfig,
  type ChronosDevCampaignWelcome,
} from './chronos-dev-campaign-welcome.js';
import { FUNKY_OUTBOX_WELCOME_TYPE } from '../common/campaign-keys.js';
import { sanitizeResendTagValue } from '../common/resend-tag-encoding.js';
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
  type NotificationDeliveryRuntime,
} from '../modules/notification-delivery/index.js';
import { makeNotificationsRepo } from '../modules/notifications/index.js';
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
const testOwner = 'chronos-dev-notification-delivery-test';
const notificationType = 'transactional_welcome';
const deliveryKey = `${notificationType}:${testOwner}`;
const environment = 'chronos_dev';
const providerId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SendResponseSchema = Type.Object({ id: Type.String({ pattern: providerId.source }) });

interface DeliveryTarget {
  readonly ownerId: string;
  readonly type: typeof notificationType | typeof FUNKY_OUTBOX_WELCOME_TYPE;
  readonly key: string;
}

const transactionalTarget: DeliveryTarget = {
  ownerId: testOwner,
  type: notificationType,
  key: deliveryKey,
};
const campaignTarget = (ownerId: string): DeliveryTarget => ({
  ownerId,
  type: FUNKY_OUTBOX_WELCOME_TYPE,
  key: campaignWelcomeKey(ownerId),
});

interface SendConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly unsubscribeSecret: string;
  readonly redis: QueueRedisHealthConfig;
  readonly campaign?: ChronosDevCampaignConfig;
}

export interface ChronosDevEmailConfig {
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
  const campaign = loadChronosDevCampaignConfig(env);
  return {
    signingSecret,
    send: { apiKey, from, unsubscribeSecret, redis, ...(campaign !== undefined && { campaign }) },
  };
}

function getTag(event: ResendEmailWebhookEvent, name: string): string | undefined {
  const tags = event.data.tags;
  return Array.isArray(tags) ? tags.find((tag) => tag.name === name)?.value : tags?.[name];
}

export function makeChronosDevDeliveryReceiptHandler(db: UserDbClient, logger: Logger) {
  return async (event: ResendEmailWebhookEvent, svixId: string) => {
    const outboxId = getTag(event, 'delivery_id');
    const tag = getTag(event, 'notification_type');
    const campaign = tag === sanitizeResendTagValue(FUNKY_OUTBOX_WELCOME_TYPE);
    if (
      event.type !== 'email.delivered' ||
      getTag(event, 'env') !== environment ||
      (!campaign && tag !== notificationType) ||
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
      let target = transactionalTarget;
      if (campaign) {
        const candidate = await db
          .selectFrom('notificationsoutbox')
          .select(['user_id', 'metadata'])
          .where('id', '=', outboxId)
          .where('notification_type', '=', FUNKY_OUTBOX_WELCOME_TYPE)
          .where('to_email', '=', recipient)
          .executeTakeFirst();
        if (candidate?.metadata[chronosDevCampaignMarker] !== true) return 'ignored' as const;
        target = campaignTarget(candidate.user_id);
      }
      return await db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          await assertUserDataOwnerCanWrite(transaction, target.ownerId);
          const row = await transaction
            .selectFrom('notificationsoutbox')
            .select(['status', 'resend_email_id', 'sent_at', 'metadata'])
            .where('id', '=', outboxId)
            .where('delivery_key', '=', target.key)
            .where('user_id', '=', target.ownerId)
            .where('to_email', '=', recipient)
            .where('notification_type', '=', target.type)
            .where('attempt_count', '>', 0)
            .forUpdate()
            .executeTakeFirst();
          if (
            row === undefined ||
            (campaign && row.metadata[chronosDevCampaignMarker] !== true) ||
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
  config: Pick<SendConfig, 'apiKey' | 'from'> & { logger: Logger },
  sendRequest = fetch,
  target = transactionalTarget
): EmailSenderPort {
  return {
    async send(params) {
      if (
        params.to !== recipient ||
        params.userId !== target.ownerId ||
        params.notificationType !== target.type ||
        params.idempotencyKey !== outboxId
      )
        return err(createValidationError('Email is outside the Chronos dev delivery test'));

      try {
        return await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (transaction) => {
            await assertUserDataOwnerCanWrite(transaction, target.ownerId);
            const row = await transaction
              .selectFrom('notificationsoutbox')
              .select(['resend_email_id', 'status', 'metadata', 'reference_id'])
              .where('id', '=', outboxId)
              .where('user_id', '=', target.ownerId)
              .where('delivery_key', '=', target.key)
              .where('notification_type', '=', target.type)
              .where('to_email', '=', recipient)
              .forUpdate()
              .executeTakeFirst();
            if (
              target.type === FUNKY_OUTBOX_WELCOME_TYPE &&
              row?.metadata[chronosDevCampaignMarker] !== true
            ) {
              return err(
                createValidationError('Campaign delivery is outside the Chronos dev test')
              );
            }
            if (row?.resend_email_id != null) return ok({ emailId: row.resend_email_id });
            if (row?.status !== 'sending')
              return err(createValidationError('Test delivery is no longer sendable'));

            if (target.type === FUNKY_OUTBOX_WELCOME_TYPE) {
              const cui = row.metadata['entityCui'];
              if (typeof cui !== 'string')
                return err(createValidationError('Missing campaign welcome entity'));
              const notifications = makeNotificationsRepo({
                db: transaction,
                logger: config.logger,
              });
              const global = await notifications.findByUserTypeAndEntity(
                target.ownerId,
                'funky:notification:global',
                null
              );
              const entity = await notifications.findByUserTypeAndEntity(
                target.ownerId,
                'funky:notification:entity_updates',
                cui
              );
              const unsubscribed = await makeExtendedNotificationsRepo({
                db: transaction,
                logger: config.logger,
              }).isUserGloballyUnsubscribed(target.ownerId);
              if (global.isErr() || entity.isErr() || unsubscribed.isErr()) {
                return err(
                  createEmailSendError(
                    'Campaign notification preferences could not be verified',
                    true
                  )
                );
              }
              if (
                unsubscribed.value ||
                global.value?.isActive !== true ||
                global.value.id !== row.reference_id ||
                entity.value?.isActive !== true
              ) {
                return err(
                  createValidationError(
                    'Campaign notification preferences no longer permit delivery'
                  )
                );
              }
            }

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
  config: ChronosDevEmailConfig,
  entityRepo?: Parameters<typeof makeChronosDevCampaignWelcomeCapture>[0]['entityRepo']
): Promise<ChronosDevCampaignWelcome | undefined> {
  const logger = app.log as Logger;
  let campaign: ChronosDevCampaignWelcome | undefined;
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

    let running: { outboxId: string; runtime: Promise<NotificationDeliveryRuntime> } | undefined;
    scope.addHook('onClose', async () => {
      if (running !== undefined) await (await running.runtime).stop();
    });
    const target =
      send.campaign === undefined ? transactionalTarget : campaignTarget(send.campaign.ownerId);
    const dispatch: ChronosDevCampaignWelcome['dispatch'] = async (job) => {
      if (running !== undefined && running.outboxId !== job.outboxId) {
        throw new Error('Chronos dev mail runtime is already scoped to a different outbox');
      }
      running ??= {
        outboxId: job.outboxId,
        runtime: startScopedDelivery(db, logger, send, target, job.outboxId).catch(
          (error: unknown) => {
            running = undefined;
            throw error;
          }
        ),
      };
      const runtime = await running.runtime;
      const queued = await runtime.composeJobScheduler.enqueue(job);
      if (queued.isErr()) throw new Error('Unable to enqueue Chronos dev test delivery');
    };

    if (send.campaign !== undefined) {
      if (entityRepo === undefined)
        throw new Error('Chronos dev campaign welcome requires a native entity reader');
      const capture = makeChronosDevCampaignWelcomeCapture({
        ownerId: send.campaign.ownerId,
        entityRepo,
        logger,
      });
      campaign = { capture: (...args) => capture.capture(...args), dispatch };
      if (send.campaign.replay !== undefined) {
        const job = await capture.replay(db, send.campaign.replay);
        if (job === undefined) logger.info('Saved campaign event has no eligible pending welcome');
        else await dispatch(job);
      }
      return;
    }

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

    await dispatch({
      runId: 'chronos-dev-delivery-test',
      kind: 'outbox',
      outboxId: outbox.id,
    });
  });
  return campaign;
}

async function startScopedDelivery(
  db: UserDbClient,
  logger: Logger,
  send: SendConfig,
  target: DeliveryTarget,
  outboxId: string
) {
  return startNotificationDeliveryRuntime({
    redisUrl: send.redis.url,
    redisPassword: send.redis.password,
    redisTls: {
      ca: readFileSync(send.redis.caFile),
      rejectUnauthorized: true,
      servername: new URL(send.redis.url).hostname,
    },
    bullmqPrefix:
      target.type === FUNKY_OUTBOX_WELCOME_TYPE
        ? 'chronos-dev-campaign-welcome'
        : 'chronos-dev-delivery-test',
    onlyOutboxId: outboxId,
    logger,
    concurrency: 1,
    intervalMinutes: 5,
    thresholdMinutes: 10,
    workerDeps: {
      deliveryRepo: makeDeliveryRepo({ db, logger }),
      notificationsRepo: makeExtendedNotificationsRepo({ db, logger }),
      emailSender: makeChronosDevTestSender(db, outboxId, { ...send, logger }, fetch, target),
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
}
