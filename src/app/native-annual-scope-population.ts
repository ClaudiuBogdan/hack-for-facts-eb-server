/** One annual source read; incomplete union years stay absent, never partial. */
import { err, ok } from 'neverthrow';

import { readNativePopulation } from './native-population.js';
import {
  legacyDecimal,
  readGroupedPopulationAnchors,
  type PopulationScope,
} from '../modules/budget/index.js';

export async function readNativeAnnualScopePopulation(
  context: Parameters<typeof readNativePopulation>[0],
  admission: Parameters<typeof readNativePopulation>[1],
  scope: PopulationScope,
  years: readonly number[],
  sectorAdmission: Parameters<typeof readNativePopulation>[4]
) {
  const ids = await readGroupedPopulationAnchors(context.trx, scope);
  if (ids === null)
    return err({
      type: 'ServiceUnavailable' as const,
      message: 'Population anchors are unavailable for the complete selected scope',
    });
  const population = await readNativePopulation(context, admission, ids, years, sectorAdmission);
  if (population.isErr()) return err(population.error);
  const totals = new Map(years.map((year) => [year, legacyDecimal(0)]));
  const missing = new Set<number>();
  for (const cell of population.value) {
    if (cell.population === null) {
      missing.add(cell.year);
      continue;
    }
    const value = legacyDecimal(cell.population);
    if (!value.isFinite() || value.lt(0))
      return err({ type: 'ServiceUnavailable' as const, message: 'Annual population is invalid' });
    totals.set(cell.year, (totals.get(cell.year) ?? legacyDecimal(0)).plus(value));
  }
  for (const [year, total] of totals) if (missing.has(year) || total.lte(0)) totals.delete(year);
  return ok(totals);
}
