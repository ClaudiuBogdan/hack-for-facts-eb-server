/** Reviewed annual sector publications supplement native POP107D gaps only (moved from `src/app`, X/F6). */
import { createHash } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import {
  readTerritoryPopulationSources,
  readPublicTerritoriesByIds,
  type TerritoryPopulationRow,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { resolveInsTerritories } from '../../core/entity-territory.js';
import {
  sectorAdmissionIsWellFormed,
  sectorRowsAreAdmissible,
  sectorRowsDigestInput,
  type SectorPopulationAdmission,
} from '../../core/population-admission.js';

import type { AnnualPopulationAdmission } from '../../core/annual-population.js';
import type { InsRepo } from '../../core/ports.js';
import type { Kysely } from 'kysely';

const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'Sector population admission is missing or inconsistent',
});

/** Validate every admitted year even for one sector; never mix partial publications. */
export async function readAdmittedSectorPopulation(
  trx: Kysely<ProdDatabase>,
  repo: InsRepo,
  annual: AnnualPopulationAdmission,
  admission: SectorPopulationAdmission
): Promise<Result<readonly TerritoryPopulationRow[], ApiError>> {
  if (!sectorAdmissionIsWellFormed(annual, admission)) return err(unavailable());
  const result = await readTerritoryPopulationSources(trx, admission.sources);
  if (result.isErr()) return err(result.error);
  const rows = result.value;
  if (!sectorRowsAreAdmissible(rows, admission)) return err(unavailable());
  if (
    createHash('sha256').update(sectorRowsDigestInput(rows)).digest('hex') !== admission.rowsSha256
  )
    return err(unavailable());
  const ids = [...new Set(rows.map((row) => row.territoryId))];
  if (ids.length !== 6) return err(unavailable());
  const territories = await readPublicTerritoriesByIds(trx, ids);
  if (territories.isErr()) return err(territories.error);
  if (territories.value.length !== 6) return err(unavailable());
  const native = await resolveInsTerritories(repo, territories.value);
  if (native.isErr()) return err(native.error);
  // A future native source needs reconciliation, never silent precedence over custody.
  if ([...native.value.values()].some((node) => node !== null)) return err(unavailable());
  return ok(rows);
}
