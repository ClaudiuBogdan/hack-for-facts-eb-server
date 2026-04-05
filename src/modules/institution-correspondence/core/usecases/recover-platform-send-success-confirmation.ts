import { ok, err, type Result } from 'neverthrow';

import { buildReconcilePlatformSendSuccessInputFromThread } from './platform-send-success-confirmation.js';
import { reconcilePlatformSendSuccess } from './reconcile-platform-send-success.js';
import { recoverMissingPublicDebateSnapshots } from './recover-missing-public-debate-snapshots.js';

import type { InstitutionCorrespondenceError } from '../errors.js';
import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success-input.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';

export interface PlatformSendSuccessEvidenceLookup {
  findLatestSuccessfulSendByThreadKey(
    threadKey: string
  ): Promise<Result<ReconcilePlatformSendSuccessInput | null, InstitutionCorrespondenceError>>;
}

export interface RecoverPlatformSendSuccessConfirmationDeps {
  repo: InstitutionCorrespondenceRepository;
  evidenceLookup: PlatformSendSuccessEvidenceLookup;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
  notificationsRepo?: Pick<ExtendedNotificationsRepository, 'findActiveByType'>;
  deliveryRepo?: Pick<DeliveryRepository, 'findByDeliveryKey'>;
}

export interface RecoverPlatformSendSuccessConfirmationInput {
  thresholdMinutes: number;
}

export interface RecoverPlatformSendSuccessConfirmationResult {
  foundCount: number;
  reconciledCount: number;
  publishedCount: number;
  recoveredThreadKeys: string[];
  pendingConfirmationThreadKeys: string[];
  snapshotEntityCount: number;
  snapshotDerivedCount: number;
  snapshotPublishedCount: number;
  snapshotAlreadyMaterializedCount: number;
  snapshotSkippedCount: number;
  snapshotPublishedEntityCuis: string[];
  snapshotAlreadyMaterializedEntityCuis: string[];
  snapshotSkippedEntityCuis: string[];
  errors: Record<string, string>;
}
export const recoverPlatformSendSuccessConfirmation = async (
  deps: RecoverPlatformSendSuccessConfirmationDeps,
  input: RecoverPlatformSendSuccessConfirmationInput
): Promise<
  Result<RecoverPlatformSendSuccessConfirmationResult, InstitutionCorrespondenceError>
> => {
  const pendingThreadsResult = await deps.repo.listPlatformSendThreadsPendingSuccessConfirmation(
    input.thresholdMinutes
  );
  if (pendingThreadsResult.isErr()) {
    return err(pendingThreadsResult.error);
  }

  const errors: Record<string, string> = {};
  const recoveredThreadKeys: string[] = [];
  const pendingConfirmationThreadKeys: string[] = [];
  let reconciledCount = 0;
  let publishedCount = 0;

  for (const thread of pendingThreadsResult.value) {
    const evidenceResult = await deps.evidenceLookup.findLatestSuccessfulSendByThreadKey(
      thread.threadKey
    );
    if (evidenceResult.isErr()) {
      errors[thread.threadKey] = evidenceResult.error.message;
      continue;
    }

    const reconcileInput =
      evidenceResult.value ?? buildReconcilePlatformSendSuccessInputFromThread(thread);
    if (reconcileInput === null) {
      continue;
    }

    const reconcileResult = await reconcilePlatformSendSuccess(
      {
        repo: deps.repo,
        ...(deps.updatePublisher !== undefined ? { updatePublisher: deps.updatePublisher } : {}),
      },
      reconcileInput
    );
    if (reconcileResult.isErr()) {
      errors[thread.threadKey] = reconcileResult.error.message;
      continue;
    }

    if (reconcileResult.value.status === 'reconciled') {
      reconciledCount++;
      recoveredThreadKeys.push(thread.threadKey);
    }

    if (reconcileResult.value.confirmationState === 'published_and_marked') {
      publishedCount++;
    }

    if (reconcileResult.value.confirmationState === 'pending_retry') {
      pendingConfirmationThreadKeys.push(thread.threadKey);
    }
  }

  let snapshotEntityCount = 0;
  let snapshotDerivedCount = 0;
  let snapshotPublishedCount = 0;
  let snapshotAlreadyMaterializedCount = 0;
  let snapshotSkippedCount = 0;
  let snapshotPublishedEntityCuis: string[] = [];
  let snapshotAlreadyMaterializedEntityCuis: string[] = [];
  let snapshotSkippedEntityCuis: string[] = [];

  if (
    deps.updatePublisher !== undefined &&
    deps.notificationsRepo !== undefined &&
    deps.deliveryRepo !== undefined
  ) {
    const snapshotRecoveryResult = await recoverMissingPublicDebateSnapshots({
      repo: deps.repo,
      notificationsRepo: deps.notificationsRepo,
      deliveryRepo: deps.deliveryRepo,
      updatePublisher: deps.updatePublisher,
    });

    if (snapshotRecoveryResult.isErr()) {
      errors['public-debate-snapshot-recovery'] = snapshotRecoveryResult.error.message;
    } else {
      snapshotEntityCount = snapshotRecoveryResult.value.entityCount;
      snapshotDerivedCount = snapshotRecoveryResult.value.derivedCount;
      snapshotPublishedCount = snapshotRecoveryResult.value.publishedCount;
      snapshotAlreadyMaterializedCount = snapshotRecoveryResult.value.alreadyMaterializedCount;
      snapshotSkippedCount = snapshotRecoveryResult.value.skippedCount;
      snapshotPublishedEntityCuis = snapshotRecoveryResult.value.publishedEntityCuis;
      snapshotAlreadyMaterializedEntityCuis =
        snapshotRecoveryResult.value.alreadyMaterializedEntityCuis;
      snapshotSkippedEntityCuis = snapshotRecoveryResult.value.skippedEntityCuis;

      for (const [entityCui, message] of Object.entries(snapshotRecoveryResult.value.errors)) {
        errors[`snapshot:${entityCui}`] = message;
      }
    }
  }

  return ok({
    foundCount: pendingThreadsResult.value.length,
    reconciledCount,
    publishedCount,
    recoveredThreadKeys,
    pendingConfirmationThreadKeys,
    snapshotEntityCount,
    snapshotDerivedCount,
    snapshotPublishedCount,
    snapshotAlreadyMaterializedCount,
    snapshotSkippedCount,
    snapshotPublishedEntityCuis,
    snapshotAlreadyMaterializedEntityCuis,
    snapshotSkippedEntityCuis,
    errors,
  });
};
