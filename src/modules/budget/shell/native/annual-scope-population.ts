/** One annual source read; incomplete union years stay absent, never partial (moved from `src/app`, X/F6). */
import { err, ok, type Result } from 'neverthrow';

import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';
import { readGroupedPopulationAnchors } from '../repo/grouped-population-anchors.js';

import type { PopulationScope } from '../../core/legacy-analytics/types.js';
import type { AnnualPopulationSnapshot, ApiError } from '@/modules/shared/index.js';
import type { Decimal } from 'decimal.js';

export async function readNativeAnnualScopePopulation(
  snapshot: AnnualPopulationSnapshot,
  scope: PopulationScope,
  years: readonly number[]
): Promise<Result<ReadonlyMap<number, Decimal>, ApiError>> {
  const ids = await readGroupedPopulationAnchors(snapshot.trx, scope);
  if (ids === null)
    return err({
      type: 'ServiceUnavailable' as const,
      message: 'Population anchors are unavailable for the complete selected scope',
    });
  const population = await snapshot.cells(ids, years);
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
