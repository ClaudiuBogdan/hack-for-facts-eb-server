import { err } from 'neverthrow';

import {
  assertUserDataOwnerCanWrite,
  UserDataOwnerDeletedError,
} from '../infra/database/user/owner-write-guard.js';
import {
  createDatabaseError,
  createForbiddenError,
  createLearningProgressAutoReviewReuseHook,
  isInteractiveUpdatedEvent,
  makeLearningProgressRepo,
  makeLearningProgressRoutes,
  syncEvents,
  type LearningProgressError,
} from '../modules/learning-progress/index.js';
import { makeNotificationsRepo, sha256Hasher } from '../modules/notifications/index.js';
import {
  makeEntityTermsAcceptedSyncHandler,
  processLearningProgressAppliedEvents,
} from '../modules/user-events/index.js';

import type { ChronosDevCampaignWelcome } from './chronos-dev-campaign-welcome.js';
import type { UserDbClient } from '../infra/database/client.js';
import type { Logger } from 'pino';

class LearningProgressSyncRollbackError extends Error {
  constructor(readonly failure: LearningProgressError) {
    super('Learning progress sync transaction rolled back');
  }
}

export function makeUserStoreLearningProgressRoutes(
  db: UserDbClient,
  logger: Logger,
  campaignWelcome?: ChronosDevCampaignWelcome
) {
  const learningProgressRepo = makeLearningProgressRepo({ db, logger });

  return makeLearningProgressRoutes({
    learningProgressRepo,
    async onSyncEventsApplied({ userId, events }) {
      for (const event of events) {
        if (!isInteractiveUpdatedEvent(event) || event.payload.record.phase !== 'pending') continue;
        try {
          await db
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async (transaction) => {
              await assertUserDataOwnerCanWrite(transaction, userId);
              await createLearningProgressAutoReviewReuseHook({
                repo: makeLearningProgressRepo({ db: transaction, logger }),
                logger,
              })({ userId, events: [event] });
            });
        } catch (error) {
          if (error instanceof UserDataOwnerDeletedError) return;
          logger.error({ err: error }, 'Failed to run learning progress auto-review');
        }
      }
    },
    async syncEventsWithSideEffects(input) {
      try {
        const { result, job } = await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (transaction) => {
            await assertUserDataOwnerCanWrite(transaction, input.userId);
            const repo = makeLearningProgressRepo({ db: transaction, logger });
            const result = await syncEvents({ repo }, input);
            if (result.isErr()) throw new LearningProgressSyncRollbackError(result.error);

            if (result.value.appliedEvents.length > 0) {
              await processLearningProgressAppliedEvents(
                {
                  handlers: [
                    makeEntityTermsAcceptedSyncHandler({
                      notificationsRepo: makeNotificationsRepo({ db: transaction, logger }),
                      hasher: sha256Hasher,
                      logger,
                    }),
                  ],
                  logger,
                },
                { userId: input.userId, events: result.value.appliedEvents }
              );
            }
            const job = await campaignWelcome?.capture(
              transaction,
              input.userId,
              result.value.appliedEvents
            );
            return { result, job };
          });
        if (job !== undefined && campaignWelcome !== undefined) {
          try {
            await campaignWelcome.dispatch(job);
          } catch {
            logger.error(
              { outboxId: job.outboxId },
              'Campaign welcome committed but queue dispatch failed'
            );
          }
        }
        return result;
      } catch (error) {
        if (error instanceof LearningProgressSyncRollbackError) return err(error.failure);
        if (error instanceof UserDataOwnerDeletedError)
          return err(createForbiddenError(error.message));
        logger.error({ err: error }, 'Failed to sync learning progress');
        return err(createDatabaseError('Failed to sync learning progress', error));
      }
    },
  });
}
