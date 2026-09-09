/**
 * The INS module's implementation of the kernel `AnnualPopulationPort`
 * (review X/F6): one repeatable-read snapshot in which the consumer's own SQL
 * and the admitted population read see the same state. Admission is bound
 * here, so the budget module never sees a publication pin.
 */
import { readNativePopulation } from './cells.js';
import { withInsReadSnapshot } from '../repo/ins-repo.js';

import type { AnnualPopulationAdmission } from '../../core/annual-population.js';
import type { SectorPopulationAdmission } from '../../core/population-admission.js';
import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface InsAnnualPopulationPortDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly admission: AnnualPopulationAdmission;
  readonly sectorAdmission?: SectorPopulationAdmission;
}

/** Admission is explicit: constructing this port never certifies a publication. */
export const makeInsAnnualPopulationPort = (
  deps: InsAnnualPopulationPortDeps
): AnnualPopulationPort => ({
  withSnapshot: (fn) =>
    withInsReadSnapshot(deps.db, ({ trx, repo }) =>
      fn({
        trx,
        cells: (territoryIds, years) =>
          readNativePopulation(
            { trx, repo },
            deps.admission,
            territoryIds,
            years,
            deps.sectorAdmission
          ),
      })
    ),
});
