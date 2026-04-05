import {
  type InstitutionCorrespondenceRepository,
  type InstitutionCorrespondenceError,
} from '@/modules/institution-correspondence/index.js';

import { makeAdminEventRegistry, type AdminEventRegistry } from '../core/registry.js';
import { makeInstitutionCorrespondenceReplyReviewPendingEventDefinition } from './events/institution-correspondence-reply-review-pending.js';
import { makeLearningProgressReviewPendingEventDefinition } from './events/learning-progress-review-pending.js';

import type {
  ApprovedReviewSideEffectPlan,
  LearningProgressError,
  LearningProgressRepository,
  ReviewDecision,
} from '@/modules/learning-progress/index.js';
import type { Result } from 'neverthrow';

export interface DefaultAdminEventRegistryDeps {
  learningProgressRepo: LearningProgressRepository;
  institutionCorrespondenceRepo?: InstitutionCorrespondenceRepository;
  prepareApproveLearningProgressReviews?: (input: {
    items: readonly ReviewDecision[];
  }) => Promise<
    Result<
      ApprovedReviewSideEffectPlan | null,
      LearningProgressError | InstitutionCorrespondenceError
    >
  >;
}

export const makeDefaultAdminEventRegistry = (
  deps: DefaultAdminEventRegistryDeps
): AdminEventRegistry => {
  const definitions = [
    makeLearningProgressReviewPendingEventDefinition({
      learningProgressRepo: deps.learningProgressRepo,
      ...(deps.prepareApproveLearningProgressReviews !== undefined
        ? { prepareApproveReviews: deps.prepareApproveLearningProgressReviews }
        : {}),
    }),
    ...(deps.institutionCorrespondenceRepo !== undefined
      ? [
          makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
            repo: deps.institutionCorrespondenceRepo,
          }),
        ]
      : []),
  ];

  return makeAdminEventRegistry(definitions);
};
