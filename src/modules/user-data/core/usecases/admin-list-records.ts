import { err, ok, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { toRecordView } from '../planners/shared.js';
import { type AdminRecordFilters, type Page, type RecordView } from '../types.js';
import { validateAdminAccess, validateAdminFilters, type AdminReadDeps } from './read-shared.js';

export interface AdminListRecordsInput {
  category: string;
  grantedPermission: string;
  filters: AdminRecordFilters;
  limit: number;
  cursor: string | null;
}

export const adminListRecords = async (
  deps: AdminReadDeps,
  input: AdminListRecordsInput
): Promise<Result<Page<RecordView>, UserDataError>> => {
  const access = validateAdminAccess(deps.registry, input.category, input.grantedPermission);
  if (access.isErr()) return err(access.error);
  const filters = validateAdminFilters(access.value.queryFields, input.filters);
  if (filters.isErr()) return err(filters.error);
  const page = await deps.adminReadPort.adminListByCategory(input.category, input.filters, {
    limit: input.limit,
    cursor: input.cursor,
  });
  return page.isErr()
    ? err(page.error)
    : ok({ items: page.value.items.map(toRecordView), nextCursor: page.value.nextCursor });
};
