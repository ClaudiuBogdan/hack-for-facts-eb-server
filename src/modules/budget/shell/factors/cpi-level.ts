/**
 * Chain-link the YAML CPI year-over-year index into the program-D2 `cpi_index`
 * price LEVEL — the representation `FactorSource.yearly('cpi_index')` promises
 * (`core/legacy-analytics/ports.ts`).
 *
 * Verbatim port of the scrapper's `src/sources/economics-factors/factors.ts`
 * `chainLinkLevels` + `decimal.ts` `toScaled` / `divideRounded` (D2, 2026-09-02):
 *
 *   level(y) = 100 × Π_{t = first..y} yoy(t) / 100
 *
 * so level(first − 1) = 100 is the (virtual) anchor — for the INSSE series that
 * is the 1970 annual average — and level(first) = yoy(first). Exact rational
 * arithmetic (BigInt numerator and denominator), rounded half-up ONCE per year
 * to `CPI_INDEX_SCALE` fraction digits (D2 stores `numeric(32,12)`). The anchor
 * is arbitrary: every consumer takes RATIOS level(base)/level(period), which
 * are anchor-invariant, so this adapter and the future `core.normalization_factors`
 * reader yield the same factors. Sample (D2 README): 2024 → 969828.98084407 at
 * 8 dp.
 *
 * Gates mirror D2 (both block the load there): a non-positive index cannot be
 * chain-linked, and a gap in the year coverage would silently anchor the tail
 * on the wrong product. Legacy skipped such points (`cpi-adjustment-factors.ts:54-55`)
 * and carried on; here they are an error the adapter surfaces (documented delta).
 */

import type { YearlySeries } from '../../core/legacy-analytics/types.js';
import type { Decimal } from 'decimal.js';

/** Fraction digits of the derived level — D2 `CPI_INDEX_SCALE` (`numeric(32,12)`). */
export const CPI_INDEX_SCALE = 12;

/** Canonical decimal text: optional sign, digits, optional fraction. */
const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export class CpiChainError extends Error {
  override readonly name = 'CpiChainError';
}

interface ScaledDecimal {
  /** value = unscaled / 10^scale */
  readonly unscaled: bigint;
  readonly scale: number;
}

const toScaled = (text: string): ScaledDecimal => {
  if (!DECIMAL_RE.test(text)) {
    throw new CpiChainError(`not canonical decimal text: ${JSON.stringify(text)}`);
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = body.split('.');
  const unscaled = BigInt(`${intPart ?? '0'}${fracPart}`);
  return { unscaled: negative ? -unscaled : unscaled, scale: fracPart.length };
};

/** Format an unscaled BigInt at `scale` as decimal text (`-` sign kept). */
const formatScaled = (unscaled: bigint, scale: number): string => {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  const body = scale === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
};

/** numerator / denominator rounded half-up to `scale` fraction digits. */
const divideRounded = (numerator: bigint, denominator: bigint, scale: number): string => {
  if (denominator <= 0n) throw new CpiChainError('denominator must be positive');
  const scaledNumerator = numerator * 10n ** BigInt(scale);
  const negative = scaledNumerator < 0n;
  const magnitude = negative ? -scaledNumerator : scaledNumerator;
  const quotient = (magnitude * 2n + denominator) / (2n * denominator);
  return formatScaled(negative ? -quotient : quotient, scale);
};

/**
 * YoY index per year (`105.59` = +5.59 % vs the previous year's annual
 * average) → the chain-linked level per year, as decimal TEXT at
 * `CPI_INDEX_SCALE` digits. Years must be contiguous and every index positive.
 */
export const chainLinkCpiLevels = (
  yoyIndex: ReadonlyMap<number, Decimal>
): ReadonlyMap<number, string> => {
  const years = [...yoyIndex.keys()].sort((a, b) => a - b);
  let numerator = 100n;
  let denominator = 1n;
  const levels = new Map<number, string>();
  let previousYear: number | undefined;
  for (const year of years) {
    if (previousYear !== undefined && year !== previousYear + 1) {
      throw new CpiChainError(
        `cpi yoy index has a gap between ${String(previousYear)} and ${String(year)}; cannot chain-link`
      );
    }
    previousYear = year;
    const value = yoyIndex.get(year);
    if (value === undefined) continue;
    const scaled = toScaled(value.toFixed());
    if (scaled.unscaled <= 0n) {
      throw new CpiChainError(
        `cpi yoy index ${String(year)} must be positive to chain-link, got ${value.toFixed()}`
      );
    }
    numerator *= scaled.unscaled;
    denominator *= 10n ** BigInt(scaled.scale) * 100n;
    levels.set(year, divideRounded(numerator, denominator, CPI_INDEX_SCALE));
  }
  return levels;
};

/** The level series in the port's shape (`Decimal` per year, exact from text). */
export const toLevelSeries = (
  levels: ReadonlyMap<number, string>,
  decimal: (text: string) => Decimal
): YearlySeries => new Map([...levels].map(([year, text]) => [year, decimal(text)]));
