/**
 * Kernel port for exact-year annual population (review X/F6).
 *
 * The budget module needs population cells for per-capita money and for
 * nominal-page metadata; the INS module owns the admitted publication and how
 * a kernel territory maps onto an INS node. Neither may import the other, so
 * the contract lives here: a snapshot-bound reader of `(territoryId, year)`
 * cells. `null` population = not admitted / not published for that cell,
 * never zero. The snapshot exposes its transaction so the consumer's own SQL
 * (identity, facts) and the population read see one consistent state.
 *
 * Lives in the kernel shell, not core: the snapshot carries a Kysely handle.
 */
import type { ApiError } from '../../core/errors.js';
import type { ProdDatabase } from '../db/types.js';
import type { Kysely } from 'kysely';
import type { Result } from 'neverthrow';

export interface AnnualPopulationCell {
  readonly territoryId: number;
  readonly year: number;
  /** Persons as a decimal string, or null when the cell is not served. */
  readonly population: string | null;
}

export interface AnnualPopulationSnapshot {
  /** The read-only snapshot transaction the consumer runs its own reads on. */
  readonly trx: Kysely<ProdDatabase>;
  /** One cell per requested (territoryId, year) pair, in request order. */
  cells(
    territoryIds: readonly number[],
    years: readonly number[]
  ): Promise<Result<readonly AnnualPopulationCell[], ApiError>>;
}

export interface AnnualPopulationPort {
  /** Opens one repeatable-read snapshot shared by identity, facts and population. */
  withSnapshot<T>(
    fn: (snapshot: AnnualPopulationSnapshot) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>>;
}
