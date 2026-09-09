/**
 * Compatibility wrapper (review X/F6, commit 2 of 4): the adapter now lives in
 * the budget module and reads population through the kernel port. The old
 * positional signature is kept for the e2e cases until they move (commit 3).
 */
import {
  makeNativeMapPopulation as makeAdapter,
  readNativeMapPopulation as readWithSnapshot,
  type BudgetMapPopulationSource,
  type BudgetMapYear,
} from '../modules/budget/index.js';
import {
  makeInsAnnualPopulationPort,
  readNativePopulation,
  type AnnualPopulationAdmission,
  type InsRepo,
  type SectorPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { ProdDatabase } from '../modules/shared/index.js';
import type { Kysely } from 'kysely';

// The admitted publications live with the INS module (X/F6); same names re-exported.
export {
  NATIVE_MAP_POPULATION_ADMISSION,
  NATIVE_SECTOR_POPULATION_ADMISSION,
} from '../modules/ins-native/index.js';

/** Admission is explicit: constructing this adapter never certifies a publication. */
export function makeNativeMapPopulation(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission
): BudgetMapPopulationSource {
  return makeAdapter(
    makeInsAnnualPopulationPort({
      db,
      admission,
      ...(sectorAdmission === undefined ? {} : { sectorAdmission }),
    })
  );
}

/** Old composition seam: callers supplied one snapshot-bound identity and INS context. */
export function readNativeMapPopulation(
  context: { trx: Kysely<ProdDatabase>; repo: InsRepo },
  admission: AnnualPopulationAdmission,
  rows: readonly BudgetMapYear[],
  sectorAdmission?: SectorPopulationAdmission
): ReturnType<BudgetMapPopulationSource['annualUnions']> {
  return readWithSnapshot(
    {
      trx: context.trx,
      cells: (territoryIds, years) =>
        readNativePopulation(context, admission, territoryIds, years, sectorAdmission),
    },
    rows
  );
}
