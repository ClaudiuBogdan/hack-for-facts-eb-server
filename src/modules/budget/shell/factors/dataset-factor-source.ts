/**
 * `FactorSource` over the datasets module's YAML files (the interim reference
 * data; program D2 replaces this adapter with `core.normalization_factors`
 * behind the same port). The module never imports the datasets module — it
 * takes a STRUCTURAL `DatasetReader` (satisfied by `DatasetRepo.getById`) so
 * the composition root owns the wiring.
 *
 * Dataset ids are the legacy `NORMALIZATION_DATASETS` registry
 * (`normalization/core/dataset-registry.ts:70`):
 *   cpi_index → ro.economics.cpi.yearly · ron_per_eur → ro.economics.exchange.ron_eur.yearly
 *   ron_per_usd → ro.economics.exchange.ron_usd.yearly · gdp_ron → ro.economics.gdp.yearly
 *   population_ro → ro.demographics.population.yearly
 *
 * REPRESENTATION (codex finding 4): the port's `cpi_index` is the D2 chain-linked
 * price LEVEL. The YAML `ro.economics.cpi.yearly` is a year-over-year index
 * (`units: yoy_index`), so this adapter chain-links it here, ONCE, exactly as the
 * D2 loader does (`cpi-level.ts`) — the core never sees a YoY value and never
 * chains. Every other kind is observed and passes through unchanged.
 *
 * Errors — a DOCUMENTED DELTA from legacy. Legacy `getAnalyticsSeries`
 * (`execution-analytics/core/usecases/get-analytics-series.ts:301-316`) did
 * `if (res.isOk()) ctx.datasets.x = res.value` — EVERY dataset error kind
 * (NotFound, ReadError, ParseError, SchemaValidationError, IdMismatch,
 * DuplicateId) was swallowed and the values were served unadjusted under the
 * requested label (`EUR`, `(real 2024)`, `/capita`). Here:
 *  - `NotFound` keeps the legacy policy (the `legacy` D2 policy: missing factor
 *    ⇒ unadjusted) and is LOGGED once per kind — never silent;
 *  - any other failure (a corrupt or malformed file in the image, an
 *    un-chain-linkable CPI series) is an `Upstream` error and the batch aborts.
 *    Serving nominal values under a "(real …)" label because the deployed YAML is
 *    broken is the silent disarm the module dependency forbids
 *    (`budget/index.ts` `legacyFactors`); the same choice was made for the
 *    population source.
 */

import { err, ok, type Result } from 'neverthrow';

import { upstreamError, type ApiError, type Logger } from '@/modules/shared/index.js';

import { chainLinkCpiLevels, CpiChainError, toLevelSeries } from './cpi-level.js';
import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';

import type { FactorKind, FactorSource } from '../../core/legacy-analytics/ports.js';
import type { YearlySeries } from '../../core/legacy-analytics/types.js';
import type { Decimal } from 'decimal.js';

/** The slice of `DatasetRepo` this adapter needs (structural; no module import). */
export interface DatasetReader {
  getById(
    id: string
  ): Promise<
    Result<
      { readonly points: readonly { readonly x: string; readonly y: Decimal }[] },
      { readonly type: string; readonly message: string }
    >
  >;
}

export const FACTOR_DATASET_IDS: Readonly<Record<FactorKind, string>> = {
  cpi_index: 'ro.economics.cpi.yearly',
  ron_per_eur: 'ro.economics.exchange.ron_eur.yearly',
  ron_per_usd: 'ro.economics.exchange.ron_usd.yearly',
  gdp_ron: 'ro.economics.gdp.yearly',
  population_ro: 'ro.demographics.population.yearly',
};

const YEAR_LABEL = /^\d{4}$/u;

export const makeDatasetFactorSource = (datasets: DatasetReader, logger?: Logger): FactorSource => {
  const warned = new Set<FactorKind>();

  const yearly = async (kind: FactorKind): Promise<Result<YearlySeries | null, ApiError>> => {
    const id = FACTOR_DATASET_IDS[kind];
    const res = await datasets.getById(id);
    if (res.isErr()) {
      if (res.error.type === 'NotFound') {
        if (!warned.has(kind)) {
          warned.add(kind);
          logger?.warn(
            { factorKind: kind, datasetId: id },
            'legacy normalization dataset missing — values served UNADJUSTED for this factor'
          );
        }
        return ok(null);
      }
      return err(
        upstreamError(`factor dataset '${id}' unreadable: ${res.error.message}`, 'datasets')
      );
    }
    const series = new Map<number, Decimal>();
    for (const point of res.value.points) {
      if (!YEAR_LABEL.test(point.x)) continue;
      series.set(Number.parseInt(point.x, 10), point.y);
    }
    if (kind !== 'cpi_index') return ok(series);

    // YoY index → the D2 chain-linked level (the port's representation).
    try {
      return ok(toLevelSeries(chainLinkCpiLevels(series), legacyDecimal));
    } catch (error) {
      if (error instanceof CpiChainError) {
        return err(
          upstreamError(
            `factor dataset '${id}' cannot be chain-linked: ${error.message}`,
            'datasets'
          )
        );
      }
      throw error;
    }
  };

  return { yearly };
};
