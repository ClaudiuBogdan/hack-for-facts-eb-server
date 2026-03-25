import { err, type Result } from 'neverthrow';

import { validateRecordKeyPrefix } from '../namespace.js';

import type { LearningProgressError } from '../errors.js';
import type { LearningProgressRepository } from '../ports.js';
import type { ListReviewRowsInput, ListReviewRowsOutput } from '../types.js';

export interface ListInteractionReviewsDeps {
  repo: LearningProgressRepository;
}

export type ListInteractionReviewsInput = ListReviewRowsInput;
export type ListInteractionReviewsOutput = ListReviewRowsOutput;

export async function listInteractionReviews(
  deps: ListInteractionReviewsDeps,
  input: ListInteractionReviewsInput
): Promise<Result<ListInteractionReviewsOutput, LearningProgressError>> {
  if (input.recordKeyPrefix !== undefined) {
    const prefixResult = validateRecordKeyPrefix(input.recordKeyPrefix);
    if (prefixResult.isErr()) {
      return err(prefixResult.error);
    }
  }

  return deps.repo.listReviewRows(input);
}
