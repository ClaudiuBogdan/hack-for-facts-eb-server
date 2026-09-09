/**
 * Compatibility wrapper (review X/F6, commit 2 of 4): the adapter now lives in
 * the budget module and reads population through the kernel port. The old
 * positional signature is kept for the e2e cases until they move (commit 3).
 */
import {
  makeNativeGroupedClassifications as makeAdapter,
  type FactorSource,
  type GroupedAnalyticsDeps,
} from '../modules/budget/index.js';
import {
  makeInsAnnualPopulationPort,
  type AnnualPopulationAdmission,
  type SectorPopulationAdmission,
} from '../modules/ins-native/index.js';

import type { ProdDatabase } from '../modules/shared/index.js';
import type { Kysely } from 'kysely';

export function makeNativeGroupedClassifications(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission: SectorPopulationAdmission | undefined,
  factors: FactorSource,
  onClamped?: GroupedAnalyticsDeps['onClamped']
) {
  return makeAdapter({
    db,
    population: makeInsAnnualPopulationPort({
      db,
      admission,
      ...(sectorAdmission === undefined ? {} : { sectorAdmission }),
    }),
    factors,
    ...(onClamped === undefined ? {} : { onClamped }),
  });
}
