import { type InstitutionCorrespondenceRepository } from '@/modules/institution-correspondence/index.js';

import { makeAdminEventRegistry, type AdminEventRegistry } from '../core/registry.js';
import { makeInstitutionCorrespondenceReplyReviewPendingEventDefinition } from './events/institution-correspondence-reply-review-pending.js';

export interface DefaultAdminEventRegistryDeps {
  institutionCorrespondenceRepo?: InstitutionCorrespondenceRepository;
}

export const makeDefaultAdminEventRegistry = (
  deps: DefaultAdminEventRegistryDeps
): AdminEventRegistry => {
  const definitions = [
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
