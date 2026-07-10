import { err, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type Page, type UserDataEvent } from '../types.js';
import { validateAdminAccess, type AdminReadDeps } from './read-shared.js';

export interface AdminGetRecordHistoryInput {
  category: string;
  grantedPermission: string;
  recordId: string;
  limit: number;
  beforeRevision: number | null;
}

export const adminGetRecordHistory = async (
  deps: AdminReadDeps,
  input: AdminGetRecordHistoryInput
): Promise<Result<Page<UserDataEvent>, UserDataError>> => {
  const access = validateAdminAccess(deps.registry, input.category, input.grantedPermission);
  if (access.isErr()) return err(access.error);
  return deps.adminReadPort.adminHistoryByCategory(input.category, input.recordId, {
    limit: input.limit,
    beforeRevision: input.beforeRevision,
  });
};
