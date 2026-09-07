/** The two reviewed municipal publications supplement gaps in native POP107D only. */
import { createHash } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import {
  resolveInsTerritories,
  type AnnualPopulationAdmission,
  type InsRepo,
} from '../modules/ins-native/index.js';
import {
  readTerritoryPopulationSources,
  readPublicTerritoriesByIds,
  type TerritoryPopulationRow,
  type ApiError,
  type ProdDatabase,
} from '../modules/shared/index.js';

import type { Kysely } from 'kysely';

export interface SectorPopulationAdmission {
  readonly ins: Pick<
    AnnualPopulationAdmission,
    'datasetCode' | 'revisionId' | 'custodySha256' | 'transformContractSha256'
  >;
  readonly sources: readonly string[];
  readonly rowsSha256: string;
}
const SECTORS = ['179141', '179150', '179169', '179178', '179187', '179196'] as const;
const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'Sector population admission is missing or inconsistent',
});

/** Validate all twelve rows even for a one-sector request; no partial source admission. */
export async function readAdmittedSectorPopulation(
  trx: Kysely<ProdDatabase>,
  repo: InsRepo,
  annual: AnnualPopulationAdmission,
  admission: SectorPopulationAdmission
): Promise<Result<readonly TerritoryPopulationRow[], ApiError>> {
  if (
    admission.sources.length !== 2 ||
    new Set(admission.sources).size !== 2 ||
    !/^[a-f0-9]{64}$/u.test(admission.rowsSha256) ||
    annual.datasetCode !== admission.ins.datasetCode ||
    annual.revisionId !== admission.ins.revisionId ||
    annual.custodySha256 !== admission.ins.custodySha256 ||
    annual.transformContractSha256 !== admission.ins.transformContractSha256
  )
    return err(unavailable());
  const result = await readTerritoryPopulationSources(trx, admission.sources);
  if (result.isErr()) return err(result.error);
  const rows = result.value;
  if (
    rows.length !== 12 ||
    rows.some(
      (row) =>
        !row.canonicalSector ||
        !SECTORS.some((siruta) => siruta === row.siruta) ||
        ![2024, 2025].includes(row.year) ||
        !Number.isSafeInteger(row.population) ||
        row.population < 0
    ) ||
    new Set(rows.map((row) => JSON.stringify([row.siruta, row.year]))).size !== 12
  )
    return err(unavailable());
  // Byte-compatible with the loader's stable tuple digest; source URL includes object version.
  const tuples = rows.map((row) => [
    row.siruta,
    row.year,
    row.population,
    row.source,
    row.sourceUrl,
  ]);
  tuples.sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (createHash('sha256').update(JSON.stringify(tuples)).digest('hex') !== admission.rowsSha256)
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
