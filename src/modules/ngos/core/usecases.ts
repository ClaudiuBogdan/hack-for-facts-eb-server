import { err } from 'neverthrow';

import { invalidInput } from '@/modules/shared/index.js';

import { normalizeNgoFilters } from './filters.js';

import type { NgoRegistryRepository } from './ports.js';
import type { NgoRegistryRequest } from './types.js';

export const listNgoRegistry = (repo: NgoRegistryRepository, request: NgoRegistryRequest) => {
  if (!Number.isInteger(request.first) || request.first < 1 || request.first > 100)
    return Promise.resolve(err(invalidInput('first must be an integer from 1 to 100', 'first')));
  return repo.list({ ...request, filter: normalizeNgoFilters(request.filter) });
};
export const getNgoRegistryRecord = (repo: NgoRegistryRepository, id: string) => {
  if (id.length === 0 || id.length > 200)
    return Promise.resolve(err(invalidInput('invalid registry observation id', 'id')));
  return repo.detail(id);
};
export const getNgoRegistryCoverage = (repo: NgoRegistryRepository) => repo.coverage();
