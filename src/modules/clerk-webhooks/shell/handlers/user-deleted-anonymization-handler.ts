import {
  makeUserDataAnonymizer,
  type UserDataAnonymizer,
} from '../anonymization/user-data-anonymizer.js';
import { makeClerkWebhookRoutes } from '../rest/routes.js';
import { makeClerkWebhookVerifier } from '../svix/verifier.js';

import type { ClerkWebhookEventVerifiedHandler } from '../../core/ports.js';
import type { ClerkWebhookEvent } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';

const USER_DELETED_EVENT_TYPE = 'user.deleted';

export interface ClerkUserDeletedAnonymizationHandlerDeps {
  userDataAnonymizer: UserDataAnonymizer;
  logger: Logger;
}

const getDeletedUserId = (event: ClerkWebhookEvent): string | undefined => {
  const value = event.data['id'];
  if (typeof value !== 'string') {
    return undefined;
  }

  const userId = value.trim();
  return userId.length > 0 ? userId : undefined;
};

export const makeClerkUserDeletedAnonymizationHandler = (
  deps: ClerkUserDeletedAnonymizationHandlerDeps
): ClerkWebhookEventVerifiedHandler => {
  const log = deps.logger.child({ handler: 'clerk-user-deleted-anonymization' });

  return async ({ event, svixId }) => {
    if (event.type !== USER_DELETED_EVENT_TYPE) {
      return;
    }

    const userId = getDeletedUserId(event);
    if (userId === undefined) {
      throw new Error('Clerk user.deleted webhook is missing a usable data.id');
    }

    const anonymizeResult = await deps.userDataAnonymizer.anonymizeDeletedUser({
      userId,
      svixId,
      eventType: event.type,
      eventTimestamp: event.timestamp,
    });

    if (anonymizeResult.isErr()) {
      throw new Error(anonymizeResult.error.message);
    }

    log.info(
      {
        svixId,
        anonymizedUserId: anonymizeResult.value.anonymizedUserId,
        summary: anonymizeResult.value,
      },
      'Anonymized data for deleted Clerk user'
    );
  };
};

/** Native product scope: only maps/datasets write this isolated user database. */
export const makeClerkUserDeletionRoutes = (deps: {
  readonly db: UserDbClient;
  readonly signingSecret: string;
  readonly logger: Logger;
}): FastifyPluginAsync =>
  makeClerkWebhookRoutes({
    webhookVerifier: makeClerkWebhookVerifier({
      signingSecret: deps.signingSecret,
      logger: deps.logger,
    }),
    logger: deps.logger,
    onEventVerified: makeClerkUserDeletedAnonymizationHandler({
      userDataAnonymizer: makeUserDataAnonymizer({ db: deps.db, logger: deps.logger }),
      logger: deps.logger,
    }),
  });
