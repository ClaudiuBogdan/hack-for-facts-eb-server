/** Exact-year INS population of the canonical union selected by each map cell. */
import { err, ok } from 'neverthrow';

import {
  readMapPopulationAnchorSets,
  type BudgetMapPopulationSource,
  type BudgetMapYear,
} from '../modules/budget/index.js';
import {
  readAnnualPopulation,
  resolveInsTerritories,
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
  type InsRepo,
} from '../modules/ins-native/index.js';
import { readPublicTerritoriesByIds, type ProdDatabase } from '../modules/shared/index.js';

import type { Kysely } from 'kysely';

/** Admission is explicit: constructing this adapter never certifies a publication. */
export function makeNativeMapPopulation(
  db: Kysely<ProdDatabase>,
  admission: AnnualPopulationAdmission
): BudgetMapPopulationSource {
  return {
    annualUnions: (rows) =>
      withInsReadSnapshot(db, ({ trx, repo }) =>
        readNativeMapPopulation({ trx, repo }, admission, rows)
      ),
  };
}

/** Composition seam; callers must supply one snapshot-bound identity and INS context. */
export async function readNativeMapPopulation(
  { trx, repo }: { trx: Kysely<ProdDatabase>; repo: InsRepo },
  admission: AnnualPopulationAdmission,
  rows: readonly BudgetMapYear[]
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
  const territories = await readPublicTerritoriesByIds(trx, ids);
  if (territories.isErr()) return err(territories.error);
  const resolved = await resolveInsTerritories(repo, territories.value);
  if (resolved.isErr()) return err(resolved.error);
  const years = [...new Set(mapped.map((row) => row.year))];
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
