import type { Result } from 'neverthrow';

export type FactorKind =
  | 'cpi_index'
  | 'cpi_yoy_index'
  | 'inflation_rate'
  | 'ron_per_eur'
  | 'ron_per_usd'
  | 'gdp_ron'
  | 'population_ro';

export interface FactorRow {
  readonly kind: FactorKind;
  readonly frequency: 'YEAR' | 'QUARTER' | 'MONTH';
  readonly periodKey: string;
  /** Exact PostgreSQL numeric text; consumers choose their Decimal policy. */
  readonly value: string;
}

export interface FactorTable {
  readonly factorSetId: string;
  readonly manifestDigest: string;
  readonly rows: readonly FactorRow[];
}

export interface FactorReadError {
  readonly type: 'Database' | 'InvalidInput' | 'ServiceUnavailable';
  readonly message: string;
}

/** Internal reader: loading an unpromoted set does not make it publicly eligible. */
export interface FactorSetReader {
  current(): Promise<Result<string | null, FactorReadError>>;
  load(setId: string): Promise<Result<FactorTable, FactorReadError>>;
}
