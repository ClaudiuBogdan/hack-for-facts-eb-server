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
import {
  FUNKY_OUTBOX_WELCOME_TYPE,
  NATIVE_CAMPAIGN_WELCOME_MARKER,
} from '../common/campaign-keys.js';
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
  isRetryableError,
  makeClerkUserEmailFetcher,
  makeDeliveryRepo,
  makeExtendedNotificationsRepo,
  startNotificationDeliveryRuntime,
  type EmailSenderPort,
  type NotificationDeliveryRuntime,
  type UserEmailFetcher,
} from '../modules/notification-delivery/index.js';
import { makeNotificationsRepo } from '../modules/notifications/index.js';
import {
  makeResendWebhookRoutes,
  type ResendEmailWebhookEvent,
} from '../modules/resend-webhooks/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { UserDatabase } from '../infra/database/user/types.js';
import type { QueueRedisHealthConfig } from '../infra/queue/redis-health.js';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';

const devClientBaseUrl = 'https://dev-chronos.transparenta.eu';
const devApiBaseUrl = 'https://dev-chronos-api.transparenta.eu';
const testOwner = 'chronos-dev-notification-delivery-test';
const notificationType = 'transactional_welcome';
const deliveryKey = `${notificationType}:${testOwner}`;
const devEnvironment = 'chronos_dev';
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
  readonly clerkSecretKey?: string;
  readonly clientBaseUrl: string;
  readonly apiBaseUrl: string;
}

export interface ChronosDevEmailConfig {
  readonly signingSecret: string;
  readonly environment?: string;
  readonly send?: SendConfig;
}

function httpsOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (value === url.origin || value === `${url.origin}/`))
      return url.origin;
  } catch {
    return undefined;
  }
  return undefined;
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
  const clientBaseUrl = httpsOrigin(configuredClientBaseUrl);
  const rawApiBaseUrl = env['API_BASE_URL'];
  const apiBaseUrl = httpsOrigin(
    rawApiBaseUrl ?? (clientBaseUrl === devClientBaseUrl ? devApiBaseUrl : undefined)
  );
  if (
    clientBaseUrl === undefined ||
    apiBaseUrl === undefined ||
    !/^whsec_[A-Za-z0-9+/=_-]+$/.test(signingSecret ?? '')
  ) {
    throw new Error(
      'Campaign welcome requires HTTPS client and API origins and a Resend signing secret'
    );
  }
  if (signingSecret === undefined) throw new Error('Missing Chronos dev Resend signing secret');
  const environment =
    apiBaseUrl === devApiBaseUrl
      ? devEnvironment
      : sanitizeResendTagValue(new URL(apiBaseUrl).hostname);
  const webhook = { signingSecret, ...(environment !== devEnvironment && { environment }) };
  if (enabled !== 'true') return webhook;
  const apiKey = env['RESEND_API_KEY'];
  const campaignFrom = env['FUNKY_EMAIL_FROM_ADDRESS']?.trim();
  const from =
    campaignFrom !== undefined && campaignFrom !== ''
      ? campaignFrom
      : env['EMAIL_FROM_ADDRESS']?.trim();
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
  if (campaign !== undefined && apiBaseUrl !== devApiBaseUrl)
    throw new Error('Campaign replay is limited to Chronos dev');
  const clerkSecretKey = env['CLERK_SECRET_KEY']?.trim();
  if (
    campaign === undefined &&
    (clerkSecretKey === undefined || !/^sk_(test|live)_[A-Za-z0-9_-]+$/.test(clerkSecretKey))
  ) {
    throw new Error('Campaign welcome requires the matching Clerk backend key');
  }
  return {
    ...webhook,
    send: {
      apiKey,
      from,
      unsubscribeSecret,
      redis,
      clientBaseUrl,
      apiBaseUrl,
      ...(campaign !== undefined && { campaign }),
      ...(clerkSecretKey !== undefined && { clerkSecretKey }),
    },
  };
}

function getTag(event: ResendEmailWebhookEvent, name: string): string | undefined {
  const tags = event.data.tags;
  return Array.isArray(tags) ? tags.find((tag) => tag.name === name)?.value : tags?.[name];
}

export function makeChronosDevDeliveryReceiptHandler(
  db: UserDbClient,
  logger: Logger,
  environment = devEnvironment
) {
  return async (event: ResendEmailWebhookEvent, svixId: string) => {
    const outboxId = getTag(event, 'delivery_id');
    const tag = getTag(event, 'notification_type');
    const campaign = tag === sanitizeResendTagValue(FUNKY_OUTBOX_WELCOME_TYPE);
    const eventRecipient = event.data.to[0];
    if (
      event.type !== 'email.delivered' ||
      getTag(event, 'env') !== environment ||
      (!campaign && tag !== notificationType) ||
      outboxId === undefined ||
      !providerId.test(outboxId) ||
      !providerId.test(event.data.email_id) ||
      event.data.to.length !== 1 ||
      eventRecipient === undefined ||
      (!campaign &&
        (environment !== devEnvironment || eventRecipient.toLowerCase() !== recipient)) ||
      (event.data.cc?.length ?? 0) !== 0 ||
      (event.data.bcc?.length ?? 0) !== 0
    )
      return 'ignored' as const;

    const sentAt = new Date(event.data.created_at);
    if (!Number.isFinite(sentAt.getTime())) throw new Error('Invalid Resend message timestamp');

    try {
      let target = transactionalTarget;
      let marker: string | undefined;
      if (campaign) {
        const candidate = await db
          .selectFrom('notificationsoutbox')
          .select(['user_id', 'metadata'])
          .where('id', '=', outboxId)
          .where('notification_type', '=', FUNKY_OUTBOX_WELCOME_TYPE)
          .executeTakeFirst();
        if (candidate === undefined) return 'ignored' as const;
        if (candidate.metadata[NATIVE_CAMPAIGN_WELCOME_MARKER] === true)
          marker = NATIVE_CAMPAIGN_WELCOME_MARKER;
        else if (
          environment === devEnvironment &&
          candidate.metadata[chronosDevCampaignMarker] === true &&
          eventRecipient.toLowerCase() === recipient
        )
          marker = chronosDevCampaignMarker;
        else return 'ignored' as const;
        target = campaignTarget(candidate.user_id);
      }
      return await db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          await assertUserDataOwnerCanWrite(transaction, target.ownerId);
          const row = await transaction
            .selectFrom('notificationsoutbox')
            .select(['status', 'resend_email_id', 'sent_at', 'metadata', 'to_email'])
            .where('id', '=', outboxId)
            .where('delivery_key', '=', target.key)
            .where('user_id', '=', target.ownerId)
            .where('notification_type', '=', target.type)
            .where('attempt_count', '>', 0)
            .forUpdate()
            .executeTakeFirst();
          if (
            row === undefined ||
            row.to_email?.toLowerCase() !== eventRecipient.toLowerCase() ||
            (marker !== undefined && row.metadata[marker] !== true) ||
            (row.resend_email_id !== null && row.resend_email_id !== event.data.email_id)
          ) {
            return 'ignored' as const;
          }
          if (row.status === 'delivered') return 'processed' as const;
          // A native retry can exhaust its budget after Resend accepted an earlier attempt.
          const failedNativeWelcome =
            marker === NATIVE_CAMPAIGN_WELCOME_MARKER && row.status === 'failed_permanent';
          if (
            !failedNativeWelcome &&
            !['sending', 'sent', 'failed_transient', 'webhook_timeout'].includes(row.status)
          ) {
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
  pinnedOutboxId: string | undefined,
  config: Pick<SendConfig, 'apiKey' | 'from'> & {
    logger: Logger;
    verifiedEmail?: Pick<UserEmailFetcher, 'getEmail'>;
  },
  sendRequest = fetch,
  pinnedTarget = transactionalTarget
): EmailSenderPort {
  const verifiedEmail = config.verifiedEmail;
  if (pinnedOutboxId === undefined && verifiedEmail === undefined) {
    throw new Error('Native campaign sender requires a verified primary email lookup');
  }
  return {
    async send(params) {
      const native = pinnedOutboxId === undefined;
      if (params.userId === undefined || (native && !/^user_[A-Za-z0-9]+$/.test(params.userId))) {
        return err(createValidationError('Missing valid notification owner'));
      }
      const target = native ? campaignTarget(params.userId) : pinnedTarget;
      const outboxId = pinnedOutboxId ?? params.idempotencyKey;
      const to = params.to;
      if (
        !providerId.test(outboxId) ||
        !/^[^\s@]+@[^\s@]+$/.test(to) ||
        (!native && to !== recipient) ||
        params.userId !== target.ownerId ||
        params.notificationType !== target.type ||
        params.idempotencyKey !== outboxId
      )
        return err(createValidationError('Email is outside the active notification scope'));

      const lockDelivery = async (transaction: Transaction<UserDatabase>) => {
        await assertUserDataOwnerCanWrite(transaction, target.ownerId);
        return transaction
          .selectFrom('notificationsoutbox')
          .select(['resend_email_id', 'status', 'metadata', 'reference_id', 'to_email'])
          .where('id', '=', outboxId)
          .where('user_id', '=', target.ownerId)
          .where('delivery_key', '=', target.key)
          .where('notification_type', '=', target.type)
          .forUpdate()
          .executeTakeFirst();
      };
      try {
        if (native) {
          const result = await db
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async (transaction) => {
              const row = await lockDelivery(transaction);
              if (row?.metadata[NATIVE_CAMPAIGN_WELCOME_MARKER] !== true) return 'rejected';
              if (row.to_email !== null) {
                if (row.to_email !== to) return 'rejected';
                if (row.resend_email_id !== null) return 'accepted';
                return row.status === 'sending' ? 'recheck' : 'rejected';
              }
              if (row.status !== 'sending' || row.resend_email_id !== null) return 'rejected';
              // Commit the address before any provider request, including across process death.
              await transaction
                .updateTable('notificationsoutbox')
                .set({ to_email: to })
                .where('id', '=', outboxId)
                .execute();
              return 'pinned';
            });
          if (result === 'rejected')
            return err(createValidationError('Email does not match the delivery recipient'));
          if (result === 'recheck' && verifiedEmail !== undefined) {
            const current = await verifiedEmail.getEmail(target.ownerId);
            if (current.isErr() && isRetryableError(current.error)) return err(current.error);
            if (current.isErr() || current.value !== to) {
              // Keep the original recipient and accept a late signed receipt for an earlier attempt.
              await db
                .transaction()
                .setIsolationLevel('read committed')
                .execute(async (transaction) => {
                  const row = await lockDelivery(transaction);
                  if (row?.status !== 'sending' || row.resend_email_id !== null) return;
                  await transaction
                    .updateTable('notificationsoutbox')
                    .set({
                      status: 'webhook_timeout',
                      last_error: 'Verified primary email could not be confirmed for retry',
                    })
                    .where('id', '=', outboxId)
                    .executeTakeFirst();
                });
              return current.isErr()
                ? err(current.error)
                : err(
                    createValidationError(
                      'Verified primary email changed; delivery held for reconciliation'
                    )
                  );
            }
          }
        }
        return await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (transaction) => {
            const row = await lockDelivery(transaction);
            if (
              target.type === FUNKY_OUTBOX_WELCOME_TYPE &&
              row?.metadata[native ? NATIVE_CAMPAIGN_WELCOME_MARKER : chronosDevCampaignMarker] !==
                true
            ) {
              return err(
                createValidationError('Campaign delivery is outside the active notification scope')
              );
            }
            if (row?.to_email !== to) {
              return err(createValidationError('Email does not match the delivery recipient'));
            }
            if (row.resend_email_id !== null) return ok({ emailId: row.resend_email_id });
            if (row.status !== 'sending')
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
                to: [to],
                subject: params.subject,
                html: params.html,
                text: params.text,
                tags: params.tags,
                headers: {
                  'List-Unsubscribe': `<${params.unsubscribeUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                },
              }),
            }).catch(() => undefined);
            if (response === undefined) {
              return err(createEmailSendError('Resend send outcome could not be confirmed', true));
            }
            if (!response.ok) {
              return err(
                createEmailSendError(
                  `Resend returned HTTP ${String(response.status)}`,
                  response.status === 429 || response.status >= 500
                )
              );
            }
            const body: unknown = await response.json().catch(() => undefined);
            if (!Value.Check(SendResponseSchema, body)) {
              return err(
                createEmailSendError('Resend response did not identify the message', true)
              );
            }
            await transaction
              .updateTable('notificationsoutbox')
              .set({
                resend_email_id: body.id,
                ...(native && { status: 'sent', sent_at: new Date() }),
              })
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
        onVerifiedEvent: makeChronosDevDeliveryReceiptHandler(db, logger, config.environment),
        logger,
      })
    );
    const send = config.send;
    if (send === undefined) return;
    if (entityRepo === undefined)
      throw new Error('Campaign welcome requires a native entity reader');
    const environment = config.environment ?? devEnvironment;
    const rehearsal = send.campaign;
    if (rehearsal === undefined) {
      const runtime = await startScopedDelivery(db, logger, send, environment);
      scope.addHook('onClose', () => runtime.stop());
      campaign = {
        capture: (transaction, userId, events) =>
          makeChronosDevCampaignWelcomeCapture({
            ownerId: userId,
            entityRepo,
            logger,
            sendToVerifiedPrimary: true,
          }).capture(transaction, userId, events),
        async dispatch(job) {
          const queued = await runtime.composeJobScheduler.enqueue(job);
          if (queued.isErr()) throw new Error('Unable to enqueue campaign welcome');
        },
      };
      return;
    }

    let running: { outboxId: string; runtime: Promise<NotificationDeliveryRuntime> } | undefined;
    scope.addHook('onClose', async () => {
      if (running !== undefined) await (await running.runtime).stop();
    });
    const target = campaignTarget(rehearsal.ownerId);
    const dispatch: ChronosDevCampaignWelcome['dispatch'] = async (job) => {
      if (running !== undefined && running.outboxId !== job.outboxId) {
        throw new Error('Chronos dev mail runtime is already scoped to a different outbox');
      }
      running ??= {
        outboxId: job.outboxId,
        runtime: startScopedDelivery(db, logger, send, environment, target, job.outboxId).catch(
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

    const capture = makeChronosDevCampaignWelcomeCapture({
      ownerId: rehearsal.ownerId,
      entityRepo,
      logger,
    });
    campaign = { capture: (...args) => capture.capture(...args), dispatch };
    if (rehearsal.replay !== undefined) {
      const job = await capture.replay(db, rehearsal.replay);
      if (job === undefined) logger.info('Saved campaign event has no eligible pending welcome');
      else await dispatch(job);
    }
  });
  return campaign;
}

async function startScopedDelivery(
  db: UserDbClient,
  logger: Logger,
  send: SendConfig,
  environment: string,
  target?: DeliveryTarget,
  outboxId?: string
) {
  const rehearsal = outboxId !== undefined;
  const deliveryRepo = makeDeliveryRepo({
    db,
    logger,
    ...(!rehearsal && { recoverNativeCampaignWelcomesOnly: true }),
  });
  const allowOutbox = async (id: string): Promise<boolean> => {
    const result = await deliveryRepo.findById(id);
    if (result.isErr()) throw new Error('Unable to check campaign delivery scope');
    const delivery = result.value;
    return (
      delivery !== null &&
      delivery.notificationType === FUNKY_OUTBOX_WELCOME_TYPE &&
      delivery.metadata[NATIVE_CAMPAIGN_WELCOME_MARKER] === true &&
      delivery.deliveryKey === campaignWelcomeKey(delivery.userId)
    );
  };
  const userEmailFetcher = rehearsal
    ? {
        getEmail: () => Promise.resolve(ok(null)),
        getEmailsByUserIds: () => Promise.resolve(ok(new Map())),
      }
    : makeClerkUserEmailFetcher({
        secretKey: send.clerkSecretKey ?? '',
        logger,
        positiveCacheTtlMs: 0,
        negativeCacheTtlMs: 0,
      });
  return startNotificationDeliveryRuntime({
    redisUrl: send.redis.url,
    redisPassword: send.redis.password,
    redisTls: {
      ca: readFileSync(send.redis.caFile),
      rejectUnauthorized: true,
      servername: new URL(send.redis.url).hostname,
    },
    bullmqPrefix: rehearsal
      ? 'chronos-dev-campaign-welcome'
      : `native-campaign-welcome:${environment}`,
    ...(outboxId === undefined ? { allowOutbox } : { onlyOutboxId: outboxId }),
    logger,
    concurrency: 1,
    intervalMinutes: 5,
    thresholdMinutes: 10,
    workerDeps: {
      deliveryRepo,
      notificationsRepo: makeExtendedNotificationsRepo({ db, logger }),
      emailSender: makeChronosDevTestSender(
        db,
        outboxId,
        { ...send, logger, ...(!rehearsal && { verifiedEmail: userEmailFetcher }) },
        fetch,
        target
      ),
      emailRenderer: makeEmailRenderer({ logger }),
      tokenSigner: makeUnsubscribeTokenSigner(send.unsubscribeSecret),
      userEmailFetcher,
      dataFetcher: {
        fetchNewsletterData: () =>
          Promise.resolve(err(createValidationError('Newsletter delivery is unavailable'))),
        fetchAlertData: () =>
          Promise.resolve(err(createValidationError('Alert delivery is unavailable'))),
      },
      apiBaseUrl: send.apiBaseUrl,
      platformBaseUrl: send.clientBaseUrl,
      environment,
      maxSendRps: 1,
    },
  });
}
