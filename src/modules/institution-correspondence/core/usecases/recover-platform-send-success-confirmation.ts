import { ok, err, type Result } from 'neverthrow';

import { buildReconcilePlatformSendSuccessInputFromThread } from './platform-send-success-confirmation.js';
import { reconcilePlatformSendSuccess } from './reconcile-platform-send-success.js';

import type { InstitutionCorrespondenceError } from '../errors.js';
import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success-input.js';

export interface PlatformSendSuccessEvidenceLookup {
  findLatestSuccessfulSendByThreadKey(
    threadKey: string
  ): Promise<Result<ReconcilePlatformSendSuccessInput | null, InstitutionCorrespondenceError>>;
}

export interface RecoverPlatformSendSuccessConfirmationDeps {
  repo: InstitutionCorrespondenceRepository;
  evidenceLookup: PlatformSendSuccessEvidenceLookup;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
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

  return ok({
    foundCount: pendingThreadsResult.value.length,
    reconciledCount,
    publishedCount,
    recoveredThreadKeys,
    pendingConfirmationThreadKeys,
    errors,
  });
};
