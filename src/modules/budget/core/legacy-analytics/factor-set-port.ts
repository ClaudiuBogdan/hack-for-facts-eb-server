/**
 * The budget module's OWN port for a promoted factor set (review B/F20). It is
 * structurally identical to `normalization`'s `FactorSetReader`, so the
 * composition root can hand that reader in, but the budget shell no longer
 * type-imports a legacy budget-viz module scheduled for deletion (doc 13 §5 step 7).
 */
import type { Result } from 'neverthrow';

export type FactorSetKind =
  | 'cpi_index'
  | 'cpi_yoy_index'
  | 'inflation_rate'
  | 'ron_per_eur'
  | 'ron_per_usd'
  | 'gdp_ron'
  | 'population_ro';

export interface FactorSetRow {
  readonly kind: FactorSetKind;
  readonly frequency: 'YEAR' | 'QUARTER' | 'MONTH';
  readonly periodKey: string;
  /** Exact PostgreSQL numeric text; consumers choose their Decimal policy. */
  readonly value: string;
}

export interface FactorSetTable {
  readonly factorSetId: string;
  readonly manifestDigest: string;
  readonly rows: readonly FactorSetRow[];
}

export interface FactorSetReadError {
  readonly type: 'Database' | 'InvalidInput' | 'ServiceUnavailable';
  readonly message: string;
}

export interface FactorSetReaderPort {
  current(): Promise<Result<string | null, FactorSetReadError>>;
  load(setId: string): Promise<Result<FactorSetTable, FactorSetReadError>>;
}
