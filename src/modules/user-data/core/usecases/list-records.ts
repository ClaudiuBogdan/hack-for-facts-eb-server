import { err, ok, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type Page, type RecordView } from '../types.js';
import { requireKnownCategory, toRecordViewPage, type RegisteredReadDeps } from './read-shared.js';

export interface ListRecordsInput {
  ownerId: string;
  category: string;
  limit: number;
  cursor: string | null;
}

export const listRecords = async (
  deps: RegisteredReadDeps,
  input: ListRecordsInput
): Promise<Result<Page<RecordView>, UserDataError>> => {
  const known = requireKnownCategory(deps.registry, input.category);
  if (known.isErr()) return err(known.error);
  const page = await deps.readPort.listByCategory(input.ownerId, input.category, {
    limit: input.limit,
    cursor: input.cursor,
  });
  return page.isErr() ? err(page.error) : ok(toRecordViewPage(page.value));
};
