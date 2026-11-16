import { createHash } from 'node:crypto';

import { err, ok } from 'neverthrow';

import {
  FUNKY_OUTBOX_WELCOME_TYPE,
  NATIVE_CAMPAIGN_WELCOME_MARKER,
} from '../common/campaign-keys.js';
import { assertUserDataOwnerCanWrite } from '../infra/database/user/owner-write-guard.js';
import {
  isInteractiveUpdatedEvent,
  makeLearningProgressRepo,
  type LearningProgressEvent,
} from '../modules/learning-progress/index.js';
import {
  createValidationError,
  makeDeliveryRepo,
  makeExtendedNotificationsRepo,
  type ComposeJobPayload,
} from '../modules/notification-delivery/index.js';
import { makeNotificationsRepo } from '../modules/notifications/index.js';
import {
  makeEntityTermsAcceptedUserEventHandler,
  type EntityTermsAcceptedUserEventHandlerDeps,
} from '../modules/user-events/index.js';

import type { UserDbClient } from '../infra/database/client.js';
import type { UserDatabase } from '../infra/database/user/types.js';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';

export const chronosDevTestRecipient = 'delivered+test1@resend.dev';
export const chronosDevCampaignMarker = 'chronosDevCampaignWelcome';
const termsPrefix = 'funky:progress:terms_accepted::entity:';
const cuiPattern = /^\d{1,20}$/;
const eventIdPattern = /^[A-Za-z0-9_-]{1,100}$/;
// Fingerprint of the approved Tester 1 account in the Clerk dev instance.
const testerOneOwnerHash = 'bde5162df331539a3c9611ff20f134b06b2ab92e0285d10c6ef30637e6f868b2';

type OutboxJob = Extract<ComposeJobPayload, { kind: 'outbox' }>;
type AppliedValue = Extract<
  LearningProgressEvent,
  { type: 'interactive.updated' }
>['payload']['record']['value'];

export interface ChronosDevCampaignConfig {
  readonly ownerId: string;
  readonly replay?: { eventId: string; entityCui: string };
}

export interface ChronosDevCampaignWelcome {
  capture(
    transaction: Transaction<UserDatabase>,
    userId: string,
    events: readonly LearningProgressEvent[]
  ): Promise<OutboxJob | undefined>;
  dispatch(job: OutboxJob): Promise<void>;
}

export function loadChronosDevCampaignConfig(
  env: NodeJS.ProcessEnv
): ChronosDevCampaignConfig | undefined {
  const ownerId = env['CHRONOS_DEV_CAMPAIGN_WELCOME_OWNER'];
  const eventId = env['CHRONOS_DEV_CAMPAIGN_REPLAY_EVENT_ID'];
  const entityCui = env['CHRONOS_DEV_CAMPAIGN_REPLAY_ENTITY_CUI'];
  if (ownerId === undefined && eventId === undefined && entityCui === undefined) return undefined;
  if (
    ownerId === undefined ||
    createHash('sha256').update(ownerId).digest('hex') !== testerOneOwnerHash
  ) {
    throw new Error('Chronos dev campaign welcome requires the approved Clerk test owner');
  }
  if (eventId === undefined && entityCui === undefined) return { ownerId };
  if (
    eventId === undefined ||
    entityCui === undefined ||
    !eventIdPattern.test(eventId) ||
    !cuiPattern.test(entityCui)
  ) {
    throw new Error('Chronos dev campaign replay requires both a saved event ID and an entity CUI');
  }
  return { ownerId, replay: { eventId, entityCui } };
}

export const campaignWelcomeKey = (userId: string) => `${FUNKY_OUTBOX_WELCOME_TYPE}:${userId}`;

export function makeChronosDevCampaignWelcomeCapture(input: {
  ownerId: string;
  sendToVerifiedPrimary?: true;
  entityRepo: EntityTermsAcceptedUserEventHandlerDeps['entityRepo'];
  logger: Logger;
}) {
  const { ownerId, entityRepo, logger } = input;
  const deliveryKey = campaignWelcomeKey(ownerId);
  const marker =
    input.sendToVerifiedPrimary === true
      ? NATIVE_CAMPAIGN_WELCOME_MARKER
      : chronosDevCampaignMarker;

  async function captureSavedTerms(
    db: Transaction<UserDatabase>,
    recordKey: string,
    eventId: string,
    appliedValue?: AppliedValue
  ): Promise<OutboxJob | undefined> {
    if (!recordKey.startsWith(termsPrefix)) return undefined;
    const entityCui = recordKey.slice(termsPrefix.length);
    if (!cuiPattern.test(entityCui)) return undefined;
    const learningProgressRepo = makeLearningProgressRepo({ db, logger });
    const fetched = await learningProgressRepo.getRecord(ownerId, recordKey);
    if (fetched.isErr()) throw new Error('Could not load saved campaign terms');
    const saved = fetched.value;
    const audit = saved?.auditEvents.find(
      (item) => item.type === 'submitted' && item.sourceClientEventId === eventId
    );
    const recordedValue = saved?.record.value;
    const eventValue =
      appliedValue === undefined
        ? audit?.type === 'submitted'
          ? audit.value
          : undefined
        : appliedValue;
    if (recordedValue?.kind !== 'json') return undefined;
    const recordedTerms = recordedValue.json.value;
    if (
      recordedTerms['entityCui'] !== entityCui ||
      typeof recordedTerms['acceptedTermsAt'] !== 'string'
    )
      return undefined;
    if (
      eventValue?.kind !== 'json' ||
      eventValue.json.value['entityCui'] !== entityCui ||
      eventValue.json.value['acceptedTermsAt'] !== recordedTerms['acceptedTermsAt']
    )
      return undefined;

    const outbox = makeDeliveryRepo({ db, logger });
    const existing = await outbox.findByDeliveryKey(deliveryKey);
    if (existing.isErr()) throw new Error('Could not load campaign welcome outbox');
    // This port sends the first welcome only, preserving the existing welcome key.
    if (
      existing.value !== null &&
      (existing.value.metadata[marker] !== true ||
        existing.value.metadata['sourceEventId'] !== eventId ||
        existing.value.status !== 'pending')
    )
      return undefined;

    let job: OutboxJob | undefined;
    await makeEntityTermsAcceptedUserEventHandler({
      learningProgressRepo,
      notificationsRepo: makeNotificationsRepo({ db, logger }),
      extendedNotificationsRepo: makeExtendedNotificationsRepo({ db, logger }),
      deliveryRepo: {
        ...outbox,
        create: (delivery) => {
          if (
            delivery.notificationType !== FUNKY_OUTBOX_WELCOME_TYPE ||
            delivery.userId !== ownerId ||
            delivery.deliveryKey !== deliveryKey
          ) {
            return Promise.resolve(
              err(createValidationError('Unexpected Chronos dev campaign delivery'))
            );
          }
          return outbox.create({
            ...delivery,
            ...(input.sendToVerifiedPrimary === true ? {} : { toEmail: chronosDevTestRecipient }),
            metadata: { ...delivery.metadata, [marker]: true },
          });
        },
      },
      composeJobScheduler: {
        enqueue: (queued) => {
          if (queued.kind !== 'outbox') {
            return Promise.resolve(err(createValidationError('Unexpected campaign compose job')));
          }
          job = queued;
          return Promise.resolve(ok(undefined));
        },
      },
      entityRepo,
      logger,
    }).handle({
      source: 'learning_progress',
      eventType: 'interactive.updated',
      recordKey,
      userId: ownerId,
      eventId,
      occurredAt: recordedTerms['acceptedTermsAt'],
    });
    return job;
  }

  return {
    async capture(
      transaction: Transaction<UserDatabase>,
      userId: string,
      events: readonly LearningProgressEvent[]
    ) {
      if (userId !== ownerId) return undefined;
      for (const event of events) {
        if (!isInteractiveUpdatedEvent(event)) continue;
        const job = await captureSavedTerms(
          transaction,
          event.payload.record.key,
          event.eventId,
          input.sendToVerifiedPrimary === true ? event.payload.record.value : undefined
        );
        if (job !== undefined) return job;
      }
      return undefined;
    },
    async replay(db: UserDbClient, replay: NonNullable<ChronosDevCampaignConfig['replay']>) {
      return db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          await assertUserDataOwnerCanWrite(transaction, ownerId);
          return captureSavedTerms(
            transaction,
            `${termsPrefix}${replay.entityCui}`,
            replay.eventId
          );
        });
    },
  };
}
