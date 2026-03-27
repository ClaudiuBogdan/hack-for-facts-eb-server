import type { InstitutionCorrespondenceError } from '../errors.js';
import type { InstitutionCorrespondenceRepository } from '../ports.js';
import type { ListPendingRepliesInput, PendingReplyPage } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListPendingRepliesDeps {
  repo: InstitutionCorrespondenceRepository;
}

export async function listPendingReplies(
  deps: ListPendingRepliesDeps,
  input: ListPendingRepliesInput
): Promise<Result<PendingReplyPage, InstitutionCorrespondenceError>> {
  return deps.repo.listPendingReplies(input);
}
