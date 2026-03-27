import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type InstitutionCorrespondenceError } from '../errors.js';

import type { InstitutionCorrespondenceRepository } from '../ports.js';
import type { ThreadRecord } from '../types.js';

export interface GetThreadDeps {
  repo: InstitutionCorrespondenceRepository;
}

export async function getThread(
  deps: GetThreadDeps,
  threadId: string
): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>> {
  const result = await deps.repo.findThreadById(threadId);
  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError(`Thread "${threadId}" was not found.`));
  }

  return ok(result.value);
}
