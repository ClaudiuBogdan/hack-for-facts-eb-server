/**
 * Get INS indicators for a single UAT (siruta code).
 */

import { err, ok, type Result } from 'neverthrow';

import { createInvalidFilterError, type InsError } from '../errors.js';
import { parsePeriodDateToInput } from '../period.js';
import {
  MAX_UAT_INDICATORS_LIMIT,
  type InsObservationFilter,
  type InsObservation,
  type InsUatIndicatorsInput,
} from '../types.js';

import type { InsRepository } from '../ports.js';

export interface GetInsUatIndicatorsDeps {
  insRepo: InsRepository;
}

export const getInsUatIndicators = async (
  deps: GetInsUatIndicatorsDeps,
  input: InsUatIndicatorsInput
): Promise<Result<InsObservation[], InsError>> => {
  if (input.dataset_codes === undefined || input.dataset_codes.length === 0) {
    return err(createInvalidFilterError('datasetCodes', 'At least one dataset code is required'));
  }

  const observationFilter: InsObservationFilter = {
    siruta_codes: [input.siruta_code],
  };
  if (input.period !== undefined) {
    const parsedPeriod = parsePeriodDateToInput(input.period);
    if (parsedPeriod === null) {
      return err(createInvalidFilterError('period', 'Invalid period format'));
    }
    observationFilter.period = parsedPeriod;
  }

  const result = await deps.insRepo.listObservations({
    dataset_codes: input.dataset_codes,
    filter: observationFilter,
    limit: MAX_UAT_INDICATORS_LIMIT,
    offset: 0,
  });

  if (result.isErr()) {
    return err(result.error);
  }

  return ok(result.value.nodes);
};
