/** Exact-year INS population of the canonical union selected by each map cell. */
import { err, ok } from 'neverthrow';

import { readNativePopulation } from './native-population.js';
import {
  readMapPopulationAnchorSets,
  type BudgetMapPopulationSource,
  type BudgetMapYear,
} from '../modules/budget/index.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
  type InsRepo,
} from '../modules/ins-native/index.js';

import type { SectorPopulationAdmission } from './native-sector-population.js';
import type { ProdDatabase } from '../modules/shared/index.js';
import type { Kysely } from 'kysely';

/** POP107D publication verified against original INS responses on 2026-09-07.
 * All 24 source samples match, including the canonical county union against
 * national totals. Exact-year coverage is checked on every read; missing
 * historical cells stay unavailable. Municipal sector coverage is separately admitted. A new publication must be re-admitted.
 * Source: https://statistici.insse.ro/tempoins/index.jsp?ind=POP107D&lang=ro&page=tempo3
 */
export const NATIVE_MAP_POPULATION_ADMISSION: AnnualPopulationAdmission = {
  datasetCode: 'POP107D',
  revisionId: '1051',
  custodySha256: '429008f7bdb642aff655a0b1c93cdf6db54f0a04433eb0a2db6fed0183555ad6',
  transformContractSha256: 'bddc45cd6e97a8f93f0c0d6f33fe82d6dad5597cb5b29336c2069147d27a4d2d',
  ageDimension: 0,
  allAgesMember: 1,
  sexDimension: 1,
  allSexesMember: 105,
  personsUnit: 9685,
};

/** Twelve definitive municipal cells independently compatible with the pinned POP107D.
 * Custody manifest SHA256 b3d2063f4b8bebe13e3638c13bfd97cc1feeccbf273be060babd9c20b0e5ea72.
 * No admission for unsupported years; no census or parent substitution.
 */
export const NATIVE_SECTOR_POPULATION_ADMISSION: SectorPopulationAdmission = {
  ins: NATIVE_MAP_POPULATION_ADMISSION,
  sources: [
    'ins-bucharest-domicile-jan1:2024:1c987ddd6c399f144aa4cbec60c1cb8c679c28a9096aca279dbc861c97438796',
    'ins-bucharest-domicile-jan1:2025:a630961aa07668b72e93bd71b4a0ea1f533c816547254aa758270534d38c5501',
  ],
  rowsSha256: '42a94762bacc7698a7909e99cc6e17f9b5a6d43b87d8ff51e8709e7224daa805',
};

/** Admission is explicit: constructing this adapter never certifies a publication. */
export function makeNativeMapPopulation(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission,
  sectorAdmission?: SectorPopulationAdmission
): BudgetMapPopulationSource {
  return {
    annualUnions: (rows) =>
      withInsReadSnapshot(db, ({ trx, repo }) =>
        readNativeMapPopulation({ trx, repo }, admission, rows, sectorAdmission)
      ),
  };
}

/** Composition seam; callers must supply one snapshot-bound identity and INS context. */
export async function readNativeMapPopulation(
  { trx, repo }: { trx: Kysely<ProdDatabase>; repo: InsRepo },
  admission: AnnualPopulationAdmission,
  rows: readonly BudgetMapYear[],
  sectorAdmission?: SectorPopulationAdmission
): ReturnType<BudgetMapPopulationSource['annualUnions']> {
  const mapped = rows.filter(
    (row): row is BudgetMapYear & { territoryCode: string } =>
      row.coverage === 'mapped' && row.territoryCode !== null
  );
  if (mapped.length === 0) return ok([]);
  const scopes = new Map<string, number>();
  const sets: number[][] = [];
  const indexes: number[] = [];
  for (const row of mapped) {
    if (row.territoryIds.some((id) => !Number.isSafeInteger(id) || id < 1))
      return err({
        type: 'ServiceUnavailable' as const,
        message: 'Map population anchors are invalid',
      });
    const ids = [...new Set(row.territoryIds)].sort((a, b) => a - b);
    const key = JSON.stringify(ids);
    let index = scopes.get(key);
    if (index === undefined) {
      index = sets.length;
      scopes.set(key, index);
      sets.push(ids);
    }
    indexes.push(index);
  }
  const retained = await readMapPopulationAnchorSets(trx, sets);
  const ids = [...new Set(retained.flatMap((scope) => scope ?? []))];
  const population = await readNativePopulation(
    { trx, repo },
    admission,
    ids,
    [...new Set(mapped.map((row) => row.year))],
    sectorAdmission
  );
  if (population.isErr()) return err(population.error);
  const cells = new Map(
    population.value.map((cell) => [JSON.stringify([cell.territoryId, cell.year]), cell.population])
  );
  return ok(
    mapped.map((row, index) => {
      const anchors = retained[indexes[index] ?? -1];
      let total: bigint | null =
        anchors === null || anchors === undefined || anchors.length === 0 ? null : 0n;
      for (const id of anchors ?? []) {
        const value = cells.get(JSON.stringify([id, row.year]));
        if (value === undefined || value === null) {
          total = null;
          break;
        }
        total = (total ?? 0n) + BigInt(value.split('.')[0] ?? '0');
      }
      return {
        territoryCode: row.territoryCode,
        year: row.year,
        population: total !== null && total > 0n ? total.toString() : null,
      };
    })
  );
}
