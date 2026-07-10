import { err, ok, type Result } from 'neverthrow';

import {
  createAdminAccessNotConfigured,
  createForbidden,
  createInvalidPayload,
  createUnknownCategory,
  type UserDataError,
} from '../errors.js';
import { type LoggerPort } from './shared.js';
import { toRecordView } from '../planners/shared.js';
import { type UserDataAdminReadPort, type UserDataReadPort } from '../ports.js';
import { type CategoryRegistry } from '../registry/registry.js';
import { type CategoryDefinition } from '../registry/types.js';
import {
  type AdminRecordFilters,
  type CurrentRecord,
  type Page,
  type RecordView,
} from '../types.js';

export interface ReadDeps {
  readPort: UserDataReadPort;
  logger: LoggerPort;
}

export interface RegisteredReadDeps extends ReadDeps {
  registry: CategoryRegistry;
}

export interface AdminReadDeps {
  adminReadPort: UserDataAdminReadPort;
  registry: CategoryRegistry;
  logger: LoggerPort;
}

export const toRecordViewPage = (page: Page<CurrentRecord>): Page<RecordView> => ({
  items: page.items.map(toRecordView),
  nextCursor: page.nextCursor,
});

export const validateAdminAccess = (
  registry: CategoryRegistry,
  category: string,
  grantedPermission: string
): Result<CategoryDefinition, UserDataError> => {
  const definition = registry.get(category);
  if (definition === undefined) return err(createAdminAccessNotConfigured(category));
  if (definition.adminPermission === null) return err(createAdminAccessNotConfigured(category));
  if (grantedPermission !== definition.adminPermission)
    return err(createForbidden('required category permission was not granted'));
  return ok(definition);
};

export const validateAdminFilters = (
  queryFields: readonly {
    name: string;
    operators: readonly ('eq' | 'in')[];
  }[],
  filters: AdminRecordFilters
): Result<void, UserDataError> => {
  if (filters.query === undefined) return ok(undefined);
  const violations: string[] = [];
  for (const [name, rawCondition] of Object.entries(filters.query)) {
    const field = queryFields.find((candidate) => candidate.name === name);
    if (field === undefined) {
      violations.push(`/query/${name}:unknownField`);
      continue;
    }
    if (rawCondition === null || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
      violations.push(`/query/${name}:condition`);
      continue;
    }
    const condition = rawCondition as Record<string, unknown>;
    const operator = condition['operator'];
    if (
      typeof operator !== 'string' ||
      (operator !== 'eq' && operator !== 'in') ||
      !field.operators.includes(operator)
    )
      violations.push(`/query/${name}:operator`);
  }
  return violations.length === 0 ? ok(undefined) : err(createInvalidPayload(violations));
};

export const requireKnownCategory = (
  registry: CategoryRegistry,
  category: string
): Result<void, UserDataError> =>
  registry.get(category) === undefined ? err(createUnknownCategory(category)) : ok(undefined);
