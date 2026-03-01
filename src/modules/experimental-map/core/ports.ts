/**
 * Experimental Map Module - Core Ports
 */

import type { ExperimentalMapError } from './errors.js';
import type { GroupedSeriesDataRequest, MapSeriesProviderOutput } from './types.js';
import type { Result } from 'neverthrow';

export interface MapSeriesProvider {
  fetchGroupedSeriesVectors(
    request: GroupedSeriesDataRequest
  ): Promise<Result<MapSeriesProviderOutput, ExperimentalMapError>>;
}
