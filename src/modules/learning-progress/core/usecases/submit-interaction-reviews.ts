import { err, ok, type Result } from 'neverthrow';

import { createInvalidEventError, type LearningProgressError } from '../errors.js';
import { updateInteractionReview } from './update-interaction-review.js';

import type { LearningProgressRepository } from '../ports.js';
import type { LearningProgressRecordRow, ReviewActorMetadata, ReviewDecision } from '../types.js';

export interface SubmitInteractionReviewsDeps {
  repo: LearningProgressRepository;
}

export interface SubmitInteractionReviewsInput {
  items: readonly ReviewDecision[];
  actor?: ReviewActorMetadata;
}

export interface SubmitInteractionReviewsOutput {
  rows: readonly LearningProgressRecordRow[];
}

function createDecisionKey(decision: ReviewDecision): string {
  return `${decision.userId}::${decision.recordKey}`;
}

export async function submitInteractionReviews(
  deps: SubmitInteractionReviewsDeps,
  input: SubmitInteractionReviewsInput
): Promise<Result<SubmitInteractionReviewsOutput, LearningProgressError>> {
  const decisionKeys = new Set<string>();

  for (const item of input.items) {
    const decisionKey = createDecisionKey(item);
    if (decisionKeys.has(decisionKey)) {
      return err(
        createInvalidEventError(
          `Duplicate review decision for user "${item.userId}" and record "${item.recordKey}".`
        )
      );
    }
    decisionKeys.add(decisionKey);
  }

  return deps.repo.withTransaction(async (transactionalRepo) => {
    const rows: LearningProgressRecordRow[] = [];

    for (const item of input.items) {
      const updateResult = await updateInteractionReview(
        { repo: transactionalRepo },
        {
          ...item,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
        }
      );
      if (updateResult.isErr()) {
        return err(updateResult.error);
      }

      rows.push(updateResult.value.row);
    }

    return ok({ rows });
  });
}
