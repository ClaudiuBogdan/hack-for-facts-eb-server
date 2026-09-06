/** Native map facts retain years and administrative anchors until normalization. */
import type { LegacyAggregateQuery, LegacyAnalyticsFilter } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

export type BudgetMapGranularity = 'UAT' | 'County';
export interface BudgetMapInput {
  readonly filter: LegacyAnalyticsFilter;
  readonly granularity: BudgetMapGranularity;
}
export interface BudgetMapYear {
  /** SIRUTA for UAT/sector; county mnemonic for County. Null is never silently dropped. */
  readonly territoryCode: string | null;
  readonly year: number;
  readonly nominalAmount: string;
  readonly observationCount: string;
  /** Distinct canonical anchors, for an annual population union after selection. */
  readonly territoryIds: readonly number[];
  readonly coverage: 'mapped' | 'outside_view' | 'unresolved';
}
export interface BudgetMapRepo {
  yearlyAmounts(
    filter: LegacyAggregateQuery,
    granularity: BudgetMapGranularity
  ): Promise<Result<readonly BudgetMapYear[], ApiError>>;
}

/** One admitted population union for the exact selected anchors and year. */
export interface BudgetMapPopulation {
  readonly territoryCode: string;
  readonly year: number;
  readonly population: string | null;
}
export interface BudgetMapPopulationSource {
  /** Absence is ineligible coverage, never a request to substitute snapshot population. */
  annualUnions(
    rows: readonly BudgetMapYear[]
  ): Promise<Result<readonly BudgetMapPopulation[], ApiError>>;
}
export interface BudgetMapValue {
  readonly territoryCode: string;
  readonly value: string | null;
  readonly status: 'available' | 'unavailable' | 'outside_bounds';
  readonly missingYears: readonly number[];
}
export interface BudgetMapResult {
  readonly unit: string;
  readonly values: readonly BudgetMapValue[];
  /** Retained for coverage disclosure and correct group normalization. */
  readonly years: readonly BudgetMapYear[];
  readonly populations: readonly BudgetMapPopulation[];
}
