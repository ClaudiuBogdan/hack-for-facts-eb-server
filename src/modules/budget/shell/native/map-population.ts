/** Exact-year INS population of the canonical union selected by each map cell (moved from `src/app`, X/F6). */
import { err, ok } from 'neverthrow';

import { readMapPopulationAnchorSets } from '../repo/map-population-anchors.js';

import type {
  BudgetMapPopulationSource,
  BudgetMapYear,
} from '../../core/legacy-analytics/map-types.js';
import type { AnnualPopulationPort, AnnualPopulationSnapshot } from '@/modules/shared/index.js';

/** Admission is the port's; constructing this adapter never certifies a publication. */
export function makeNativeMapPopulation(
  population: AnnualPopulationPort
): BudgetMapPopulationSource {
  return {
    annualUnions: (rows) =>
      population.withSnapshot((snapshot) => readNativeMapPopulation(snapshot, rows)),
  };
}

/** Composition seam; the caller supplies one snapshot-bound population context. */
export async function readNativeMapPopulation(
  snapshot: AnnualPopulationSnapshot,
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
  const retained = await readMapPopulationAnchorSets(snapshot.trx, sets);
  const ids = [...new Set(retained.flatMap((scope) => scope ?? []))];
  const population = await snapshot.cells(ids, [...new Set(mapped.map((row) => row.year))]);
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
