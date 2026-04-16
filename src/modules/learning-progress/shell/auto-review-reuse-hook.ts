import { isInteractiveUpdatedEvent, type LearningProgressEvent } from '../core/types.js';
import {
  autoResolvePendingInteractionFromReviewedMatch,
  type AutoReviewReuseSkipReason,
} from '../core/usecases/auto-resolve-pending-interaction-from-reviewed-match.js';

import type { LearningProgressRepository } from '../core/ports.js';
import type { Logger } from 'pino';

export interface LearningProgressAutoReviewReuseHookDeps {
  repo: LearningProgressRepository;
  logger: Logger;
}

function incrementSkipCount(
  counts: Partial<Record<AutoReviewReuseSkipReason, number>>,
  reason: AutoReviewReuseSkipReason
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export const createLearningProgressAutoReviewReuseHook = (
  deps: LearningProgressAutoReviewReuseHookDeps
) => {
  const log = deps.logger.child({ component: 'learning-progress-auto-review-reuse-hook' });

  return async (input: {
    userId: string;
    events: readonly LearningProgressEvent[];
  }): Promise<void> => {
    const skipped: Partial<Record<AutoReviewReuseSkipReason, number>> = {};
    let attempts = 0;
    let failures = 0;
    let autoApproved = 0;

    for (const event of input.events) {
      if (!isInteractiveUpdatedEvent(event) || event.payload.record.phase !== 'pending') {
        continue;
      }

      attempts += 1;

      const result = await autoResolvePendingInteractionFromReviewedMatch(
        {
          repo: deps.repo,
          onAutoApproved(approval) {
            log.info(approval, 'Auto-resolved pending interaction from reviewed match');
          },
        },
        {
          userId: input.userId,
          recordKey: event.payload.record.key,
        }
      );

      if (result.isErr()) {
        failures += 1;
        log.error(
          {
            err: result.error,
            userId: input.userId,
            recordKey: event.payload.record.key,
            interactionId: event.payload.record.interactionId,
          },
          'Learning progress auto-review reuse failed'
        );
        continue;
      }

      if (result.value.status === 'approved') {
        autoApproved += 1;
        continue;
      }

      incrementSkipCount(skipped, result.value.reason);
    }

    log.info(
      {
        userId: input.userId,
        eventCount: input.events.length,
        attempts,
        failures,
        autoApproved,
        skipped,
      },
      'Learning progress auto-review reuse hook completed'
    );
  };
};
