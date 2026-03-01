/**
 * Advanced Map Analytics Module - Core Ports
 */

import type { GroupedSeriesError } from './errors.js';
import type { GroupedSeriesDataRequest, GroupedSeriesProviderOutput } from './types.js';
import type { Result } from 'neverthrow';

export interface GroupedSeriesProvider {
  fetchGroupedSeriesVectors(
    request: GroupedSeriesDataRequest
  ): Promise<Result<GroupedSeriesProviderOutput, GroupedSeriesError>>;
}
