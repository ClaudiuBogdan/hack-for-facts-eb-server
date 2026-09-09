/**
 * Test-only shim for the e2e cases (review X/F6, commit 3): the native
 * adapters live in the budget module and read population through the kernel
 * port; the cases were written against the old positional composition
 * (`db, admission, sectorAdmission, factors, hook`). The shim keeps that shape
 * on top of the module factories so the cases stay verbatim while the
 * `src/app/native-*.ts` files are gone.
 */
import {
  makeNativeBudgetFactors,
  makeNativeBudgetRepo as makeBudgetRepoAdapter,
  makeNativeExecutionSeries as makeExecutionSeriesAdapter,
  makeNativeGroupedClassifications as makeGroupedClassificationsAdapter,
  makeNativeGroupedEntities as makeGroupedEntitiesAdapter,
  makeNativeMapPopulation as makeMapPopulationAdapter,
  readNativeMapPopulation as readMapPopulationWithSnapshot,
  type BudgetMapPopulationSource,
  type BudgetMapYear,
  type BudgetRepo,
  type FactorSource,
  type GroupedAnalyticsDeps,
  type NativeExecutionSeriesDeps,
} from '@/modules/budget/index.js';
import {
  makeInsAnnualPopulationPort,
  readNativePopulation,
  type AnnualPopulationAdmission,
  type InsRepo,
  type SectorPopulationAdmission,
} from '@/modules/ins-native/index.js';
import { makeFactorSetReader } from '@/modules/normalization/index.js';

import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export type { SectorPopulationAdmission } from '@/modules/ins-native/index.js';

export const nativePopulationPort = (
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission
): AnnualPopulationPort =>
  makeInsAnnualPopulationPort({
    db,
    admission,
    ...(sectorAdmission === undefined ? {} : { sectorAdmission }),
  });

export function makeNativeBudgetRepo(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission,
  moneyFactors: FactorSource = makeNativeBudgetFactors(
    makeFactorSetReader(db, { requirePromotion: true })
  )
): BudgetRepo {
  return makeBudgetRepoAdapter({
    db,
    population: nativePopulationPort(db, admission, sectorAdmission),
    factors: moneyFactors,
  });
}

export function makeNativeExecutionSeries(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onCapped?: NativeExecutionSeriesDeps['onCapped']
) {
  return makeExecutionSeriesAdapter({
    db,
    population: nativePopulationPort(db, admission, sectorAdmission),
    factors,
    ...(onCapped === undefined ? {} : { onCapped }),
  });
}

export function makeNativeGroupedEntities(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onClamped?: GroupedAnalyticsDeps['onClamped']
) {
  return makeGroupedEntitiesAdapter({
    db,
    population: nativePopulationPort(db, admission, sectorAdmission),
    factors,
    ...(onClamped === undefined ? {} : { onClamped }),
  });
}

export function makeNativeGroupedClassifications(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onClamped?: GroupedAnalyticsDeps['onClamped']
) {
  return makeGroupedClassificationsAdapter({
    db,
    population: nativePopulationPort(db, admission, sectorAdmission),
    factors,
    ...(onClamped === undefined ? {} : { onClamped }),
  });
}

export function makeNativeMapPopulation(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission
): BudgetMapPopulationSource {
  return makeMapPopulationAdapter(nativePopulationPort(db, admission, sectorAdmission));
}

/** The old composition seam: one snapshot-bound identity and INS context. */
export function readNativeMapPopulation(
  context: { trx: Kysely<ProdDatabase>; repo: InsRepo },
  admission: AnnualPopulationAdmission,
  rows: readonly BudgetMapYear[],
  sectorAdmission?: SectorPopulationAdmission
): ReturnType<BudgetMapPopulationSource['annualUnions']> {
  return readMapPopulationWithSnapshot(
    {
      trx: context.trx,
      cells: (territoryIds, years) =>
        readNativePopulation(context, admission, territoryIds, years, sectorAdmission),
    },
    rows
  );
}
