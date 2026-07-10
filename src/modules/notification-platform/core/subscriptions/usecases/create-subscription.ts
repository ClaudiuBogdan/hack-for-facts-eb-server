import { Value } from '@sinclair/typebox/value';
import { err, type Result } from 'neverthrow';

import { buildNormalizedSubscriptionKey } from '../normalized-key.js';

import type { AuditLedgerPort } from '../../audit/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { SubscriptionError } from '../errors.js';
import type { SubjectAuthorizationPort, SubscriptionRepo } from '../ports.js';
import type { Subscription } from '../types.js';

export interface CreateSubscriptionDeps {
  subscriptions: SubscriptionRepo;
  registry: KindRegistry;
  subjectAuthorizers: ReadonlyMap<string, SubjectAuthorizationPort>;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface CreateSubscriptionInput {
  userId: string;
  kindId: string;
  subjectType: string;
  subjectId: string;
  config: Record<string, unknown>;
}

export type CreateSubscriptionResult = Subscription;
export type CreateSubscriptionError = SubscriptionError;

export const createSubscription = async (
  deps: CreateSubscriptionDeps,
  input: CreateSubscriptionInput
): Promise<Result<CreateSubscriptionResult, CreateSubscriptionError>> => {
  const kind = deps.registry.getByKindId(input.kindId);
  if (kind === undefined) {
    return err({ type: 'NotFound', entity: 'notification kind', id: input.kindId });
  }
  if (kind.recipientResolution.strategy !== 'subscription') {
    return err({
      type: 'ValidationError',
      message: `Notification kind ${input.kindId} does not support subscriptions`,
      field: 'kindId',
    });
  }
  if (!kind.recipientResolution.subscription.allowedSubjectTypes.includes(input.subjectType)) {
    return err({
      type: 'ValidationError',
      message: `Unsupported subject type for ${input.kindId}`,
      field: 'subjectType',
    });
  }
  if (!Value.Check(kind.recipientResolution.subscription.configSchema, input.config)) {
    return err({
      type: 'ValidationError',
      message: `Invalid subscription config for ${input.kindId}`,
      field: 'config',
    });
  }

  const authorizer = deps.subjectAuthorizers.get(input.kindId);
  if (authorizer === undefined) {
    return err({ type: 'Forbidden', reason: 'No subject authorizer is registered for this kind' });
  }
  const authorization = await authorizer.authorizeSubject({
    userId: input.userId,
    kindId: input.kindId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });
  if (authorization.isErr()) {
    return err(authorization.error);
  }
  if (!authorization.value.allowed) {
    return err({
      type: 'Forbidden',
      reason: authorization.value.denyReason ?? 'Subject subscription is not allowed',
    });
  }

  const normalizedKey = buildNormalizedSubscriptionKey(
    input.kindId,
    input.subjectType,
    input.subjectId,
    input.config
  );
  if (normalizedKey.isErr()) {
    return err(normalizedKey.error);
  }

  // DESIGN NOTE: the committed AuditAction union has no subscription-created action,
  // so this usecase cannot append a truthful ledger entry without changing the contract.
  return deps.subscriptions.createOrReactivate({
    id: deps.ids.newId(),
    userId: input.userId,
    kindId: input.kindId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    config: input.config,
    normalizedKey: normalizedKey.value,
    now: deps.clock.now(),
  });
};
