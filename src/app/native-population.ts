/** Snapshot-bound annual population cells shared by financial serving adapters. */
import { err, ok, type Result } from 'neverthrow';

import {
  readAdmittedSectorPopulation,
  type SectorPopulationAdmission,
} from './native-sector-population.js';
import {
  readAnnualPopulation,
  resolveInsTerritories,
  type AnnualPopulationAdmission,
  type InsRepo,
} from '../modules/ins-native/index.js';
import {
  readPublicTerritoriesByIds,
  type ApiError,
  type ProdDatabase,
} from '../modules/shared/index.js';

import type { Kysely } from 'kysely';

export interface NativePopulationCell {
  readonly territoryId: number;
  readonly year: number;
  readonly population: string | null;
}

/** Canonical identities and both source admissions are read in the caller's snapshot. */
export async function readNativePopulation(
  { trx, repo }: { trx: Kysely<ProdDatabase>; repo: InsRepo },
  admission: AnnualPopulationAdmission,
  territoryIds: readonly number[],
  years: readonly number[],
  sectorAdmission?: SectorPopulationAdmission
): Promise<Result<readonly NativePopulationCell[], ApiError>> {
  const ids = [...new Set(territoryIds)];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1))
    return err({ type: 'ServiceUnavailable', message: 'Population anchors are invalid' });
  const territories = await readPublicTerritoriesByIds(trx, ids);
  if (territories.isErr()) return err(territories.error);
  const resolved = await resolveInsTerritories(repo, territories.value);
  if (resolved.isErr()) return err(resolved.error);
  const population = await readAnnualPopulation(repo, admission, {
    years,
    territories: [...resolved.value.entries()].flatMap(([id, node]) =>
      node === null ? [] : [{ key: String(id), territoryId: node.territoryId }]
    ),
  });
  if (population.isErr()) return err(population.error);
  const cells = new Map(
    population.value.cells.map((cell) => [
      JSON.stringify([Number(cell.key), cell.year]),
      cell.population,
    ])
  );
  if (sectorAdmission !== undefined) {
    const sectors = await readAdmittedSectorPopulation(trx, repo, admission, sectorAdmission);
    if (sectors.isErr()) return err(sectors.error);
    for (const sector of sectors.value) {
      cells.set(JSON.stringify([sector.territoryId, sector.year]), String(sector.population));
    }
  }
  return ok(
    ids.flatMap((territoryId) =>
      [...new Set(years)].map((year) => ({
        territoryId,
        year,
        population: cells.get(JSON.stringify([territoryId, year])) ?? null,
      }))
    )
  );
}
