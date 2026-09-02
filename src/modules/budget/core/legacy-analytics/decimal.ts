/**
 * The slice's isolated decimal policy (codex 2026-09-02 finding 5; orchestrator
 * decision 2026-09-02: Decimal end to end, NEVER the legacy float arithmetic).
 *
 * Legacy arithmetic, for the record (`execution-analytics/core/usecases/get-analytics-series.ts`):
 *  - every point was converted to a JS double at :87 (`y: point.value.toNumber()`),
 *    and the GDP / CPI / FX / population factors likewise (`.toNumber()` at
 *    :129, :148, :168, :183); inflation, FX, %GDP, per-capita and growth were
 *    all IEEE-754 double operations (:132, :148, :168, :181);
 *  - the only decimal.js step was the CPI factor chain
 *    (`normalization/core/cpi-adjustment-factors.ts:58-70`) on the default
 *    constructor (precision 20, ROUND_HALF_UP), immediately `.toNumber()`ed.
 *
 * This clone runs the whole pipeline in decimal — precision 40, ROUND_HALF_EVEN
 * (banker's): 40 significant digits leave ≥ 20 guard digits above the 2-dp money
 * grain at any magnitude the facts reach (1e12 RON national totals, 1e15 sums),
 * and half-even rounding carries no directional bias through a chain of
 * divisions. The values are converted to a `number` ONLY at the GraphQL
 * `Float!` boundary (`shell/graphql/legacy/resolvers.ts`).
 *
 * DELTA (rounding class, docs/server-redesign/13 §7 delta 6): the legacy doubles
 * carry ~15.95 significant digits, so kernel and legacy values are equal at
 * 2 dp and differ only in trailing digits, ≤ 1e-9 relative (13 §6 acceptance:
 * "numbers equal at 2 dp"). `decimal-policy.test.ts` feeds the same inputs
 * through a float replica of the legacy chain and asserts exactly that.
 *
 * ISOLATION: the constructor's config is private to this clone — a
 * `Decimal.set(...)` elsewhere in the process cannot change it. Every value that
 * enters the slice's arithmetic from outside (the datasets module's `Decimal`s,
 * `numeric::text` strings) is re-wrapped with `legacyDecimal()` first, because
 * decimal.js takes the config from the LEFT operand's constructor.
 */

import { Decimal } from 'decimal.js';

/** Pinned policy: 40 significant digits, banker's rounding (user decision 2026-09-02). */
export const LEGACY_DECIMAL_PRECISION = 40;
export const LEGACY_DECIMAL_ROUNDING = Decimal.ROUND_HALF_EVEN;

export const LegacyDecimal = Decimal.clone({
  precision: LEGACY_DECIMAL_PRECISION,
  rounding: LEGACY_DECIMAL_ROUNDING,
});

/** Re-wrap any decimal-like value under the slice's policy (exact; no rounding). */
export const legacyDecimal = (value: Decimal.Value): Decimal => new LegacyDecimal(value);

export const ZERO: Decimal = legacyDecimal(0);
export const HUNDRED: Decimal = legacyDecimal(100);
