/**
 * Get INS UAT dashboard - all UAT-level datasets with observations for a territory.
 */

import { err, ok, type Result } from 'neverthrow';

import { createInvalidFilterError, type InsError } from '../errors.js';

import type { InsRepository } from '../ports.js';
import type { InsUatDashboardInput, InsUatDatasetGroup } from '../types.js';

export interface GetInsUatDashboardDeps {
  insRepo: InsRepository;
}

export const getInsUatDashboard = async (
  deps: GetInsUatDashboardDeps,
  input: InsUatDashboardInput
): Promise<Result<InsUatDatasetGroup[], InsError>> => {
  const sirutaCode = input.siruta_code.trim();
  if (sirutaCode === '') {
    return err(createInvalidFilterError('sirutaCode', 'Siruta code is required'));
  }

  const result = await deps.insRepo.listUatDatasetsWithObservations(
    sirutaCode,
    input.context_code,
    input.period
  );

  if (result.isErr()) {
    return err(result.error);
  }

  const groups: InsUatDatasetGroup[] = result.value.map((item) => {
    let latestPeriod: string | null = null;
    let latestKey: number | null = null;

    for (const observation of item.observations) {
      const period = observation.time_period;
      const key = period.year * 10_000 + (period.quarter ?? 0) * 100 + (period.month ?? 0);
      if (latestKey === null || key > latestKey) {
        latestKey = key;
        latestPeriod = period.iso_period;
      }
    }

    return {
      dataset: item.dataset,
      observations: item.observations,
      latest_period: latestPeriod,
    };
  });

  return ok(groups);
};
