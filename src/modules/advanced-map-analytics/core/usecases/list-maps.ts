import { err, type Result } from 'neverthrow';

import { createProviderError, type AdvancedMapAnalyticsError } from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type { AdvancedMapAnalyticsMap } from '../types.js';

export interface ListMapsDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface ListMapsInput {
  userId: string;
}

export async function listMaps(
  deps: ListMapsDeps,
  input: ListMapsInput
): Promise<Result<AdvancedMapAnalyticsMap[], AdvancedMapAnalyticsError>> {
  try {
    return await deps.repo.listMapsForUser(input.userId);
  } catch (error) {
    return err(createProviderError('Failed to list maps', error));
  }
}
