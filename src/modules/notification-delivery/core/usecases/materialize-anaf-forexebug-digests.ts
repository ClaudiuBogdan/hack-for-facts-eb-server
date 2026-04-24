import { err, ok, type Result } from 'neverthrow';

import { formatPeriodLabel } from '@/common/utils/format-period-label.js';
import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';

import { createValidationError, type DeliveryError } from '../errors.js';
import {
  buildAnafForexebugDigestScopeKey,
  type AnafForexebugDigestMetadata,
  type DeliveryRecord,
} from '../types.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../ports.js';
import type { Notification } from '@/modules/notifications/core/types.js';

const BUNDLE_DESIGN_DOC = 'docs/specs/specs-202603301900-bundle-delivery-with-queue-and-outbox.md';

const MONTHLY_SOURCE_TYPES = [
  'newsletter_entity_monthly',
  'alert_series_analytics',
  'alert_series_static',
] as const;

export interface MaterializeAnafForexebugDigestsDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface MaterializeAnafForexebugDigestsInput {
  runId: string;
  periodKey: string;
  userIds?: string[];
  dryRun?: boolean;
  limit?: number;
}

export interface MaterializeAnafForexebugDigestsResult {
  runId: string;
  digestType: 'anaf_forexebug_digest';
  periodKey: string;
  dryRun: boolean;
  eligibleNotificationCount: number;
  digestCount: number;
  composeJobsEnqueued: number;
  outboxIds: string[];
}

interface MaterializedDigestGroup {
  userId: string;
  metadata: AnafForexebugDigestMetadata;
}

const snapshotNotificationVersion = (notification: Notification) => ({
  notificationType: notification.notificationType,
  hash: notification.hash,
});

const shouldRequeueBundleCompose = (outbox: DeliveryRecord): boolean => {
  return (
    outbox.notificationType === 'anaf_forexebug_digest' &&
    outbox.status === 'pending' &&
    (outbox.renderedSubject === null ||
      outbox.renderedHtml === null ||
      outbox.renderedText === null)
  );
};

const maybeRequeueExistingBundleCompose = async (
  deps: Pick<MaterializeAnafForexebugDigestsDeps, 'composeJobScheduler'>,
  input: {
    runId: string;
    outbox: DeliveryRecord;
  }
): Promise<Result<boolean, DeliveryError>> => {
  if (!shouldRequeueBundleCompose(input.outbox)) {
    return ok(false);
  }

  const enqueueResult = await deps.composeJobScheduler.enqueue({
    runId: input.runId,
    kind: 'outbox',
    outboxId: input.outbox.id,
  });
  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok(true);
};

const collectEligibleNotifications = async (
  notificationsRepo: ExtendedNotificationsRepository,
  periodKey: string,
  limit: number | undefined,
  userIds?: string[]
): Promise<Result<Notification[], DeliveryError>> => {
  const buckets: Notification[][] = [];
  const userIdSet =
    userIds !== undefined ? new Set(userIds.map((userId) => userId.trim()).filter(Boolean)) : null;
  const repoLimit = userIdSet === null ? limit : undefined;

  for (const notificationType of MONTHLY_SOURCE_TYPES) {
    const result = await notificationsRepo.findEligibleForDelivery(
      notificationType,
      periodKey,
      repoLimit,
      false,
      'direct'
    );
    if (result.isErr()) {
      return err(result.error);
    }

    const filteredNotifications =
      userIdSet === null
        ? result.value
        : result.value.filter((notification) => userIdSet.has(notification.userId));

    buckets.push([...filteredNotifications]);
  }

  if (limit === undefined) {
    return ok(buckets.flat());
  }

  const selected: Notification[] = [];
  let addedInRound = true;

  while (selected.length < limit && addedInRound) {
    addedInRound = false;

    for (const bucket of buckets) {
      if (selected.length >= limit) {
        break;
      }

      const notification = bucket.shift();
      if (notification === undefined) {
        continue;
      }

      selected.push(notification);
      addedInRound = true;
    }
  }

  return ok(selected);
};

const groupNotificationsByUser = (notifications: Notification[]): MaterializedDigestGroup[] => {
  const groups = new Map<string, MaterializedDigestGroup>();

  for (const notification of notifications) {
    const existing = groups.get(notification.userId);
    if (existing === undefined) {
      groups.set(notification.userId, {
        userId: notification.userId,
        metadata: {
          digestType: 'anaf_forexebug_digest',
          sourceNotificationIds: [notification.id],
          itemCount: 1,
          sourceNotificationVersions: {
            [notification.id]: snapshotNotificationVersion(notification),
          },
        },
      });
      continue;
    }

    existing.metadata.sourceNotificationIds.push(notification.id);
    existing.metadata.itemCount = existing.metadata.sourceNotificationIds.length;
    existing.metadata.sourceNotificationVersions = {
      ...(existing.metadata.sourceNotificationVersions ?? {}),
      [notification.id]: snapshotNotificationVersion(notification),
    };
  }

  return [...groups.values()];
};

/**
 * Bundle design note: this use case persists bundle membership directly in the
 * outbox metadata instead of introducing a second durable staging table.
 * See: docs/specs/specs-202603301900-bundle-delivery-with-queue-and-outbox.md
 */
export const materializeAnafForexebugDigests = async (
  deps: MaterializeAnafForexebugDigestsDeps,
  input: MaterializeAnafForexebugDigestsInput
): Promise<Result<MaterializeAnafForexebugDigestsResult, DeliveryError>> => {
  if (!isNonEmptyString(input.runId)) {
    return err(createValidationError('runId is required'));
  }

  if (!isNonEmptyString(input.periodKey)) {
    return err(createValidationError('periodKey is required'));
  }

  if (input.userIds?.some((userId) => !isNonEmptyString(userId)) === true) {
    return err(createValidationError('userIds must contain only non-empty values'));
  }

  const eligibleResult = await collectEligibleNotifications(
    deps.notificationsRepo,
    input.periodKey,
    input.limit,
    input.userIds
  );

  if (eligibleResult.isErr()) {
    return err(eligibleResult.error);
  }

  const groups = groupNotificationsByUser(eligibleResult.value);

  if (input.dryRun === true) {
    return ok({
      runId: input.runId,
      digestType: 'anaf_forexebug_digest',
      periodKey: input.periodKey,
      dryRun: true,
      eligibleNotificationCount: eligibleResult.value.length,
      digestCount: groups.length,
      composeJobsEnqueued: 0,
      outboxIds: [],
    });
  }

  const outboxIds: string[] = [];
  let composeJobsEnqueued = 0;

  for (const group of groups) {
    const digestScopeKey = buildAnafForexebugDigestScopeKey(input.periodKey);
    const deliveryKey = `digest:anaf_forexebug:${group.userId}:${input.periodKey}`;
    const existingResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
    if (existingResult.isErr()) {
      return err(existingResult.error);
    }

    if (existingResult.value !== null) {
      const requeueResult = await maybeRequeueExistingBundleCompose(deps, {
        runId: input.runId,
        outbox: existingResult.value,
      });
      if (requeueResult.isErr()) {
        return err(requeueResult.error);
      }
      if (requeueResult.value) {
        composeJobsEnqueued++;
      }

      outboxIds.push(existingResult.value.id);
      continue;
    }

    const createResult = await deps.deliveryRepo.create({
      userId: group.userId,
      notificationType: 'anaf_forexebug_digest',
      referenceId: null,
      scopeKey: digestScopeKey,
      deliveryKey,
      metadata: {
        runId: input.runId,
        digestType: group.metadata.digestType,
        periodLabel: formatPeriodLabel(input.periodKey, 'monthly'),
        sourceNotificationIds: group.metadata.sourceNotificationIds,
        itemCount: group.metadata.itemCount,
        sourceNotificationVersions: group.metadata.sourceNotificationVersions,
        designDoc: BUNDLE_DESIGN_DOC,
      },
    });

    if (createResult.isErr()) {
      if (createResult.error.type === 'DuplicateDelivery') {
        const duplicateResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
        if (duplicateResult.isErr()) {
          return err(duplicateResult.error);
        }

        if (duplicateResult.value !== null) {
          const requeueResult = await maybeRequeueExistingBundleCompose(deps, {
            runId: input.runId,
            outbox: duplicateResult.value,
          });
          if (requeueResult.isErr()) {
            return err(requeueResult.error);
          }
          if (requeueResult.value) {
            composeJobsEnqueued++;
          }

          outboxIds.push(duplicateResult.value.id);
          continue;
        }
      }

      return err(createResult.error);
    }

    const enqueueResult = await deps.composeJobScheduler.enqueue({
      runId: input.runId,
      kind: 'outbox',
      outboxId: createResult.value.id,
    });

    if (enqueueResult.isErr()) {
      return err(enqueueResult.error);
    }

    composeJobsEnqueued++;
    outboxIds.push(createResult.value.id);
  }

  return ok({
    runId: input.runId,
    digestType: 'anaf_forexebug_digest',
    periodKey: input.periodKey,
    dryRun: false,
    eligibleNotificationCount: eligibleResult.value.length,
    digestCount: groups.length,
    composeJobsEnqueued,
    outboxIds,
  });
};
