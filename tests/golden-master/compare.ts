/**
 * Golden Master envelope comparison (pure, no I/O).
 *
 * Compares two full GraphQL envelopes `{ status, data, errors }` — a BASELINE
 * (expected) and a TARGET (actual) — and classifies every difference:
 *
 * - `contract-break`: HTTP status change; `errors[]` presence, count, message
 *   or path change; a MISSING key; a type change (object vs array vs scalar);
 *   a value present on the baseline that is null/absent on the target
 *   (`null-loss`, any type); a `__typename` change; an array with the same
 *   elements in a different order (`array-order`); any difference under a
 *   `pageInfo` object, extra keys included (`totalCount` is named explicitly).
 * - `data-parity`: same shape, different values, null → value, array length.
 * - `rounding`: numbers that differ exactly but agree once both are rounded to
 *   `decimalPlaces` (default 2). Numbers are compared as decimals from their
 *   exact wire tokens (`LosslessNumber`), so integers beyond 2^53 stay distinct.
 *
 * EXTRA keys on the target (outside `pageInfo`) are warnings, never failures
 * (Zod on the client is non-strict; TS casts are blind).
 *
 * Every element of every array is CLASSIFIED and every difference is
 * returned — the allowlist must see all of them. Only the written REPORT is
 * bounded (report.ts caps the listed differences per array and summarises
 * the rest in an `array-diff-truncated` marker); `stats.totals` counts every
 * difference by class.
 */

import { Decimal } from 'decimal.js';

import {
  isLosslessNumber,
  LosslessNumber,
  type GraphQLEnvelope,
  type GraphQLErrorShape,
} from './envelope.js';

export type { GraphQLEnvelope, GraphQLErrorShape } from './envelope.js';

// =============================================================================
// Types
// =============================================================================

export type DifferenceClass = 'contract-break' | 'data-parity' | 'rounding';

export type DifferenceKind =
  | 'http-status'
  | 'errors-introduced'
  | 'errors-missing'
  | 'error-count'
  | 'error-message'
  | 'error-path'
  | 'missing-key'
  | 'type-change'
  | 'typename-change'
  | 'total-count-change'
  | 'page-info-change'
  | 'null-loss'
  | 'null-change'
  | 'array-length'
  | 'array-order'
  | 'value-change'
  /** Report-level marker only (report.ts); never produced by the classifier. */
  | 'array-diff-truncated';

export interface Difference {
  class: DifferenceClass;
  kind: DifferenceKind;
  /** JSONPath-like location, e.g. `$.data.entities.nodes[3].name`. */
  path: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export type WarningKind = 'extra-key' | 'extra-key-truncated' | 'baseline-empty';

export interface ComparisonWarning {
  kind: WarningKind;
  path: string;
  message: string;
}

export type ClassTotals = Record<DifferenceClass, number>;

export interface ComparisonStats {
  /** Scalar leaves that were present on both sides and compared. */
  leavesCompared: number;
  /** Every difference by class (equals `countByClass(differences)`). */
  totals: ClassTotals;
}

export interface EnvelopeComparison {
  differences: Difference[];
  warnings: ComparisonWarning[];
  stats: ComparisonStats;
}

export interface CompareOptions {
  /** Decimal places for the rounding pass. Default 2. */
  decimalPlaces?: number;
}

export const CLASS_RANK: Record<DifferenceClass, number> = {
  rounding: 0,
  'data-parity': 1,
  'contract-break': 2,
};

export function emptyTotals(): ClassTotals {
  return { 'contract-break': 0, 'data-parity': 0, rounding: 0 };
}

// =============================================================================
// Public API
// =============================================================================

export function compareEnvelopes(
  expected: GraphQLEnvelope,
  actual: GraphQLEnvelope,
  options: CompareOptions = {}
): EnvelopeComparison {
  const ctx: CompareContext = {
    decimalPlaces: options.decimalPlaces ?? 2,
    differences: [],
    warnings: [],
    totals: emptyTotals(),
    leavesCompared: 0,
  };

  if (expected.status !== actual.status) {
    record(ctx, {
      class: 'contract-break',
      kind: 'http-status',
      path: '$.status',
      expected: expected.status,
      actual: actual.status,
      message: `HTTP status ${String(expected.status)} on the baseline, ${String(actual.status)} on the target`,
    });
  }

  compareErrors(expected.errors ?? [], actual.errors ?? [], ctx);
  compareValues(expected.data, actual.data, '$.data', false, ctx);

  return {
    differences: ctx.differences,
    warnings: ctx.warnings,
    stats: { leavesCompared: ctx.leavesCompared, totals: ctx.totals },
  };
}

/** Counts per class over a list of differences. */
export function countByClass(differences: readonly Difference[]): ClassTotals {
  const counts = emptyTotals();
  for (const difference of differences) {
    counts[difference.class] += 1;
  }
  return counts;
}

export interface RootFieldShape {
  kind: 'null' | 'array' | 'connection' | 'object' | 'scalar' | 'absent';
  /** Array length, or `nodes.length` for a connection. */
  length?: number;
  /** `pageInfo.totalCount` when the field is a connection that reports it. */
  totalCount?: string;
}

/** Per-root-field shape of `data` — the evidence of HOW MUCH a pass compared. */
export function describeRootShape(data: unknown): Record<string, RootFieldShape> {
  const shape: Record<string, RootFieldShape> = {};
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return shape;
  }
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      shape[key] = { kind: 'null' };
    } else if (Array.isArray(value)) {
      shape[key] = { kind: 'array', length: value.length };
    } else if (typeof value === 'object' && !isLosslessNumber(value)) {
      const record = value as Record<string, unknown>;
      const nodes = record['nodes'];
      if (Array.isArray(nodes)) {
        const pageInfo = record['pageInfo'];
        const totalCount =
          pageInfo !== null && typeof pageInfo === 'object'
            ? (pageInfo as Record<string, unknown>)['totalCount']
            : undefined;
        shape[key] = {
          kind: 'connection',
          length: nodes.length,
          ...(totalCount !== undefined &&
            totalCount !== null && { totalCount: scalarText(totalCount) }),
        };
      } else {
        shape[key] = { kind: 'object' };
      }
    } else {
      shape[key] = { kind: 'scalar' };
    }
  }
  return shape;
}

function scalarText(value: unknown): string {
  if (isLosslessNumber(value)) return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** True when every list-bearing root field is empty (nothing to compare). */
export function isEmptyRootShape(shape: Record<string, RootFieldShape>): boolean {
  const lists = Object.values(shape).filter((s) => s.kind === 'array' || s.kind === 'connection');
  return lists.length > 0 && lists.every((s) => s.length === 0);
}

/**
 * Canonical text of a JSON value: sorted keys, numbers as decimal text
 * (`LosslessNumber` and plain numbers render alike), `undefined` members
 * dropped. Used for element identity in the array-order check.
 */
export function canonicalText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (isLosslessNumber(value)) return value.toString();
  if (typeof value === 'number') return new Decimal(value).toFixed();
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalText(item)}`);
    return `{${entries.join(',')}}`;
  }
  // bigint / symbol / function never occur in parsed JSON.
  return `<${typeof value}>`;
}

export function toDecimal(value: number | LosslessNumber): Decimal {
  return isLosslessNumber(value) ? value.decimal : new Decimal(value);
}

/**
 * `|actual − expected| / max(|expected|, |actual|)` for two numbers (0 when
 * both are 0); `null` when either side is not a number. The magnitude a
 * reviewer needs next to an allowlisted numeric delta.
 */
export function relativeDifference(expected: unknown, actual: unknown): number | null {
  if (!isNumeric(expected) || !isNumeric(actual)) return null;
  const e = toDecimal(expected);
  const a = toDecimal(actual);
  const scale = Decimal.max(e.abs(), a.abs());
  if (scale.isZero()) return 0;
  return a.minus(e).abs().div(scale).toNumber();
}

export function isNumeric(value: unknown): value is number | LosslessNumber {
  return isLosslessNumber(value) || typeof value === 'number';
}

// =============================================================================
// Internals
// =============================================================================

interface CompareContext {
  decimalPlaces: number;
  differences: Difference[];
  warnings: ComparisonWarning[];
  totals: ClassTotals;
  leavesCompared: number;
}

function record(ctx: CompareContext, difference: Difference): void {
  ctx.totals[difference.class] += 1;
  ctx.differences.push(difference);
}

function warn(ctx: CompareContext, warning: ComparisonWarning): void {
  ctx.warnings.push(warning);
}

function compareErrors(
  expected: readonly GraphQLErrorShape[],
  actual: readonly GraphQLErrorShape[],
  ctx: CompareContext
): void {
  const expectedMessages = expected.map((e) => e.message);
  const actualMessages = actual.map((e) => e.message);

  if (expected.length === 0 && actual.length > 0) {
    record(ctx, {
      class: 'contract-break',
      kind: 'errors-introduced',
      path: '$.errors',
      expected: expectedMessages,
      actual: actualMessages,
      message: `The target returned ${String(actual.length)} error(s) on a document the baseline accepts: ${actualMessages.join(' | ')}`,
    });
    return;
  }

  if (expected.length > 0 && actual.length === 0) {
    record(ctx, {
      class: 'contract-break',
      kind: 'errors-missing',
      path: '$.errors',
      expected: expectedMessages,
      actual: actualMessages,
      message: `The baseline returned ${String(expected.length)} error(s) that the target no longer returns: ${expectedMessages.join(' | ')}`,
    });
    return;
  }

  if (expected.length !== actual.length) {
    record(ctx, {
      class: 'contract-break',
      kind: 'error-count',
      path: '$.errors',
      expected: expectedMessages,
      actual: actualMessages,
      message: `${String(expected.length)} error(s) on the baseline, ${String(actual.length)} on the target`,
    });
    return;
  }

  for (const [index, expectedMessage] of expectedMessages.entries()) {
    const actualMessage = actualMessages[index];
    if (expectedMessage !== actualMessage) {
      record(ctx, {
        class: 'contract-break',
        kind: 'error-message',
        path: `$.errors[${String(index)}].message`,
        expected: expectedMessage,
        actual: actualMessage,
        message: `Error message differs at index ${String(index)}`,
      });
      continue;
    }
    // Same message at a different result path (partial-data errors): a
    // different field failed, which is a different contract.
    const expectedPath = errorPathText(expected[index]);
    const actualPath = errorPathText(actual[index]);
    if (expectedPath !== actualPath) {
      record(ctx, {
        class: 'contract-break',
        kind: 'error-path',
        path: `$.errors[${String(index)}].path`,
        expected: expected[index]?.path,
        actual: actual[index]?.path,
        message: `Error path differs at index ${String(index)} (${expectedPath} vs ${actualPath})`,
      });
    }
  }
}

/** `path` rendered as dotted text; absent path renders as `<none>`. */
function errorPathText(error: GraphQLErrorShape | undefined): string {
  if (error?.path === undefined) return '<none>';
  return error.path.map((segment) => String(segment)).join('.');
}

type ValueKind =
  'null' | 'undefined' | 'array' | 'object' | 'number' | 'string' | 'boolean' | 'other';

function kindOf(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (isLosslessNumber(value)) return 'number';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    default:
      return 'other';
  }
}

function isNullish(kind: ValueKind): boolean {
  return kind === 'null' || kind === 'undefined';
}

function compareValues(
  expected: unknown,
  actual: unknown,
  path: string,
  inPageInfo: boolean,
  ctx: CompareContext
): void {
  const expectedKind = kindOf(expected);
  const actualKind = kindOf(actual);

  if (isNullish(expectedKind) && isNullish(actualKind)) {
    return;
  }

  // Present on the baseline, null/absent on the target: data the client would
  // have rendered is gone. Always a contract-break, never allowlistable.
  if (!isNullish(expectedKind) && isNullish(actualKind)) {
    record(ctx, {
      class: 'contract-break',
      kind: path === '$.data' ? 'type-change' : 'null-loss',
      path,
      expected,
      actual,
      message: `${expectedKind} on the baseline, ${actualKind} on the target`,
    });
    return;
  }

  // Null/absent on the baseline, present on the target.
  if (isNullish(expectedKind)) {
    if (path === '$.data') {
      record(ctx, {
        class: 'contract-break',
        kind: 'type-change',
        path,
        expected,
        actual,
        message: `data is ${expectedKind} on the baseline and ${actualKind} on the target`,
      });
      return;
    }
    record(ctx, {
      class: inPageInfo ? 'contract-break' : 'data-parity',
      kind: inPageInfo ? 'page-info-change' : 'null-change',
      path,
      expected,
      actual,
      message: `${expectedKind} on the baseline, ${actualKind} on the target`,
    });
    return;
  }

  if (expectedKind !== actualKind) {
    record(ctx, {
      class: 'contract-break',
      kind: 'type-change',
      path,
      expected,
      actual,
      message: `${expectedKind} on the baseline, ${actualKind} on the target`,
    });
    return;
  }

  switch (expectedKind) {
    case 'array':
      compareArrays(expected as unknown[], actual as unknown[], path, inPageInfo, ctx);
      return;
    case 'object':
      compareObjects(
        expected as Record<string, unknown>,
        actual as Record<string, unknown>,
        path,
        inPageInfo,
        ctx
      );
      return;
    case 'number':
      ctx.leavesCompared += 1;
      compareNumbers(
        expected as number | LosslessNumber,
        actual as number | LosslessNumber,
        path,
        inPageInfo,
        ctx
      );
      return;
    default:
      ctx.leavesCompared += 1;
      if (expected !== actual) {
        record(ctx, {
          class: inPageInfo ? 'contract-break' : 'data-parity',
          kind: inPageInfo ? 'page-info-change' : 'value-change',
          path,
          expected,
          actual,
          message: 'Value differs',
        });
      }
  }
}

function compareNumbers(
  expected: number | LosslessNumber,
  actual: number | LosslessNumber,
  path: string,
  inPageInfo: boolean,
  ctx: CompareContext
): void {
  const expectedDecimal = toDecimal(expected);
  const actualDecimal = toDecimal(actual);
  if (expectedDecimal.eq(actualDecimal)) return;

  if (inPageInfo) {
    record(ctx, {
      class: 'contract-break',
      kind: path.endsWith('.totalCount') ? 'total-count-change' : 'page-info-change',
      path,
      expected,
      actual,
      message: 'pageInfo must match exactly',
    });
    return;
  }

  const places = ctx.decimalPlaces;
  const roundedExpected = expectedDecimal.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  const roundedActual = actualDecimal.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  if (roundedExpected.eq(roundedActual)) {
    record(ctx, {
      class: 'rounding',
      kind: 'value-change',
      path,
      expected,
      actual,
      message: `Differs only beyond ${String(places)} decimal places`,
    });
    return;
  }

  record(ctx, {
    class: 'data-parity',
    kind: 'value-change',
    path,
    expected,
    actual,
    message: `Differs at ${String(places)} decimal places`,
  });
}

function compareObjects(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  path: string,
  inPageInfo: boolean,
  ctx: CompareContext
): void {
  const expectedKeys = Object.keys(expected);
  const actualKeySet = new Set(Object.keys(actual));

  for (const key of expectedKeys) {
    const childPath = `${path}.${key}`;
    if (!actualKeySet.has(key)) {
      record(ctx, {
        class: 'contract-break',
        kind: 'missing-key',
        path: childPath,
        expected: expected[key],
        message: `Key "${key}" is missing on the target`,
      });
      continue;
    }

    if (key === '__typename') {
      ctx.leavesCompared += 1;
      if (expected[key] !== actual[key]) {
        record(ctx, {
          class: 'contract-break',
          kind: 'typename-change',
          path: childPath,
          expected: expected[key],
          actual: actual[key],
          message: '__typename differs',
        });
      }
      continue;
    }

    compareValues(expected[key], actual[key], childPath, inPageInfo || key === 'pageInfo', ctx);
  }

  const expectedKeySet = new Set(expectedKeys);
  for (const key of actualKeySet) {
    if (expectedKeySet.has(key)) continue;
    if (inPageInfo) {
      record(ctx, {
        class: 'contract-break',
        kind: 'page-info-change',
        path: `${path}.${key}`,
        actual: actual[key],
        message: `Key "${key}" is present on the target pageInfo but not on the baseline (pageInfo must match exactly)`,
      });
      continue;
    }
    warn(ctx, {
      kind: 'extra-key',
      path: `${path}.${key}`,
      message: `Key "${key}" is present on the target but not on the baseline`,
    });
  }
}

/**
 * Arrays are sequences. Same length + same multiset of elements + different
 * sequence is ONE `array-order` contract-break for the array (doc 13 §6:
 * identical array order), and the elements are not diffed pairwise — the
 * pairwise differences would only be the reordering restated. Anything else
 * is an `array-length` difference plus pairwise element comparison over the
 * common prefix.
 */
function compareArrays(
  expected: unknown[],
  actual: unknown[],
  path: string,
  inPageInfo: boolean,
  ctx: CompareContext
): void {
  if (expected.length !== actual.length) {
    record(ctx, {
      class: inPageInfo ? 'contract-break' : 'data-parity',
      kind: inPageInfo ? 'page-info-change' : 'array-length',
      path,
      expected: expected.length,
      actual: actual.length,
      message: `${String(expected.length)} element(s) on the baseline, ${String(actual.length)} on the target`,
    });
  } else if (expected.length > 1) {
    const expectedTexts = expected.map(canonicalText);
    const actualTexts = actual.map(canonicalText);
    const firstDifferent = expectedTexts.findIndex((text, index) => text !== actualTexts[index]);
    if (firstDifferent >= 0) {
      const sortedExpected = [...expectedTexts].sort();
      const sortedActual = [...actualTexts].sort();
      const sameElements = sortedExpected.every((text, index) => text === sortedActual[index]);
      if (sameElements) {
        record(ctx, {
          class: 'contract-break',
          kind: 'array-order',
          path,
          expected: firstDifferent,
          actual: actualTexts.indexOf(expectedTexts[firstDifferent] ?? ''),
          message: `Same ${String(expected.length)} element(s) in a different order (first moved element: baseline index ${String(firstDifferent)})`,
        });
        return;
      }
    }
  }

  const common = Math.min(expected.length, actual.length);
  for (let index = 0; index < common; index += 1) {
    compareValues(expected[index], actual[index], `${path}[${String(index)}]`, inPageInfo, ctx);
  }
}
