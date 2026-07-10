import { err, ok, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { toRecordView } from '../planners/shared.js';
import { type RecordTarget, type RecordView } from '../types.js';
import { requireKnownCategory, type RegisteredReadDeps } from './read-shared.js';

export interface FindRecordsByTargetInput {
  ownerId: string;
  category: string;
  target: RecordTarget;
}

export const findRecordsByTarget = async (
  deps: RegisteredReadDeps,
  input: FindRecordsByTargetInput
): Promise<Result<RecordView[], UserDataError>> => {
  const known = requireKnownCategory(deps.registry, input.category);
  if (known.isErr()) return err(known.error);
  const found = await deps.readPort.findByTarget(input.ownerId, input.category, input.target);
  return found.isErr() ? err(found.error) : ok(found.value.map(toRecordView));
};
