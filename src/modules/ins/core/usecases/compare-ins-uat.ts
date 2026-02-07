/**
 * Compare a dataset across multiple UATs.
 */

import { err, ok, type Result } from 'neverthrow';

import { createInvalidFilterError, type InsError } from '../errors.js';
import { parsePeriodDateToInput } from '../period.js';
import {
  MAX_COMPARE_LIMIT,
  type InsCompareInput,
  type InsObservation,
  type InsObservationFilter,
} from '../types.js';

import type { InsRepository } from '../ports.js';

export interface CompareInsUatDeps {
  insRepo: InsRepository;
}

export const compareInsUats = async (
  deps: CompareInsUatDeps,
  input: InsCompareInput
): Promise<Result<InsObservation[], InsError>> => {
  if (input.siruta_codes.length === 0) {
    return err(createInvalidFilterError('sirutaCodes', 'At least one siruta code is required'));
  }

  if (input.dataset_code.trim() === '') {
    return err(createInvalidFilterError('datasetCode', 'Dataset code is required'));
  }

  const observationFilter: InsObservationFilter = {
    siruta_codes: input.siruta_codes,
  };
  if (input.period !== undefined) {
    const parsedPeriod = parsePeriodDateToInput(input.period);
    if (parsedPeriod === null) {
      return err(createInvalidFilterError('period', 'Invalid period format'));
    }
    observationFilter.period = parsedPeriod;
  }

  const result = await deps.insRepo.listObservations({
    dataset_codes: [input.dataset_code],
    filter: observationFilter,
    limit: MAX_COMPARE_LIMIT,
    offset: 0,
  });

  if (result.isErr()) {
    return err(result.error);
  }

  return ok(result.value.nodes);
};
