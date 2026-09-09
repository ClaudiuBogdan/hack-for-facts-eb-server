/** Native annual population composition; the budget module never reads INS itself (moved from `src/app`, X/F6). */
import { err, type Result } from 'neverthrow';

import { populationRelation } from './population-relation.js';
import { preloadFactors } from './preloaded-factors.js';
import { budgetMoneyPlan, type BudgetMoneyOptions } from '../../core/money-options.js';
import { makeBudgetRepo } from '../repo/budget-repo.js';

import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { BudgetRepo } from '../../core/ports.js';
import type {
  AnnualPopulationPort,
  AnnualPopulationSnapshot,
  ApiError,
  ProdDatabase,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface NativeBudgetRepoDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly population: AnnualPopulationPort;
  readonly factors: FactorSource;
}

export function makeNativeBudgetRepo(deps: NativeBudgetRepoDeps): BudgetRepo {
  const base = makeBudgetRepo(deps.db, { moneyFactors: deps.factors });
  const snapshotRepo = (snapshot: AnnualPopulationSnapshot, factors: FactorSource) =>
    makeBudgetRepo(snapshot.trx, {
      moneyFactors: factors,
      populationRelation: (selection) => populationRelation(snapshot, selection),
    });
  // Cold immutable reads must finish before a request reserves a snapshot
  // connection, including when the serving pool has only one connection.
  const prepare = (
    normalization: Parameters<BudgetRepo['rankEntities']>[0]['normalization'],
    options: BudgetMoneyOptions = {}
  ): Promise<Result<FactorSource, ApiError>> =>
    preloadFactors(deps.factors, [budgetMoneyPlan(normalization, options)]);
  const perCapita = (normalization: string | undefined): boolean =>
    normalization === 'PER_CAPITA' || normalization === 'PER_CAPITA_EURO';
  return {
    ...base,
    listExecutionLineItems: async (query) => {
      const normalization = query.normalization ?? 'TOTAL';
      if (!perCapita(normalization)) return base.listExecutionLineItems(query);
      const ready = await prepare(normalization, query);
      if (ready.isErr()) return err(ready.error);
      return deps.population.withSnapshot((snapshot) =>
        snapshotRepo(snapshot, ready.value).listExecutionLineItems(query)
      );
    },
    executionTimeseries: async (query) => {
      if (!perCapita(query.normalization)) return base.executionTimeseries(query);
      const ready = await prepare(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return deps.population.withSnapshot((snapshot) =>
        snapshotRepo(snapshot, ready.value).executionTimeseries(query)
      );
    },
    // Both entrypoints need the snapshot: the base top-N method closes over its
    // own page implementation. TOTAL also returns annual population metadata.
    rankEntities: async (query) => {
      const ready = await prepare(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return deps.population.withSnapshot((snapshot) =>
        snapshotRepo(snapshot, ready.value).rankEntities(query)
      );
    },
    rankEntitiesPage: async (query) => {
      const ready = await prepare(query.normalization, query);
      if (ready.isErr()) return err(ready.error);
      return deps.population.withSnapshot((snapshot) =>
        snapshotRepo(snapshot, ready.value).rankEntitiesPage(query)
      );
    },
  };
}
