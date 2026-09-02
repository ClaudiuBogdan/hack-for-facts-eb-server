/**
 * Data-parity allowlist for the cutover run (`parity-allowlist.json`).
 *
 * A `data-parity` difference fails a case unless an entry accepts it.
 * `contract-break` differences (missing key, type change, null-loss,
 * `__typename`, `pageInfo`, array ORDER, errors, status) can never be
 * allowlisted; `rounding` differences never fail. Three entry kinds, all
 * narrow, all STALE (and failing the run under strict mode) when they match
 * no difference in a run:
 *
 * (a) `pinned` — one difference, one case: case `key` + exact `path` +
 *     difference `kind` + the before/after values (or their fingerprints).
 *     For one-offs. Cannot outlive the difference it was written for.
 * ```json
 * { "type": "pinned", "key": "<sha256(document)>:<sha256(canonical variables)>",
 *   "path": "$.data.entities.nodes[0].name", "kind": "value-change",
 *   "before": "MUNICIPIUL CLUJ-NAPOCA", "after": "Municipiul Cluj-Napoca",
 *   "reason": "entities re-backed by Meilisearch; display casing only" }
 * ```
 * (b) `systematic` — a DOCUMENTED systematic delta: `deltaId` + `root` (the
 *     `data` root field) + `pathPattern` (relative to the root; `[*]` = any
 *     index, `*` = any one key) + `kind: "value-change"` + a bounded numeric
 *     `predicate` — `ratio` (actual/expected within `[min, max]`),
 *     `relativeTolerance` (|a−e| / max(|e|,|a|) ≤ t) or `absoluteTolerance`
 *     (|a−e| ≤ t). Values are not pinned, so the entry survives the next
 *     data load; a difference outside the bound is NOT covered.
 * ```json
 * { "type": "systematic", "deltaId": "per-capita-denominator-2026-09",
 *   "root": "entityAnalytics", "pathPattern": "nodes[*].per_capita_amount",
 *   "kind": "value-change", "predicate": { "ratio": { "min": 1.85, "max": 1.95 } },
 *   "reason": "kernel divides by the resident population, legacy by the domicile population" }
 * ```
 * (c) `drift` — an F0 data-drift EXPLANATION (legacy `/graphql` reads Phoenix,
 *     the kernel reads Chronos; value drift between the two databases is
 *     expected and explained PER ROOT): `deltaId` + `root` + `pathPattern` +
 *     `kind` ∈ `value-drift` (covers `value-change` and `null-change` on
 *     scalars) | `array-cardinality` (covers `array-length`) + `explanation`.
 *     No value predicate. Never covers key-set, type, order, `pageInfo` or
 *     `__typename` differences — those are contract-breaks.
 * ```json
 * { "type": "drift", "deltaId": "f0-aggregated-line-items",
 *   "root": "aggregatedLineItems", "pathPattern": "nodes[*].amount",
 *   "kind": "value-drift", "explanation": "Chronos carries the 2025-Q4 re-statements Phoenix lacks (design 13 §5 step 2)" }
 * ```
 * `caseKeys` (optional on (b)/(c)) narrows an entry to specific cases.
 * Every case report records, per entry, the match count and the largest
 * relative difference so a reviewer sees the magnitude.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  isNumeric,
  relativeDifference,
  toDecimal,
  type Difference,
  type DifferenceKind,
} from './compare.js';
import { isLosslessNumber, parseLosslessJson, toPlain } from './envelope.js';
import { canonicalJsonStringify } from '../../src/common/canonical-json/index.js';

// =============================================================================
// Schema
// =============================================================================

/**
 * `total-count-change` joined the pinnable kinds on 2026-09-02 (legacy dimension
 * roots on the kernel): a `pageInfo.totalCount` that moves for a DOCUMENTED reason
 * (a catalog with a different row count, a fixed legacy count bug) can only be
 * admitted per case with the exact before/after numbers — never as a pattern.
 * `page-info-change` (hasNextPage / cursors) stays unpinnable: pageInfo must
 * otherwise match exactly (design 13 §6).
 */
const PINNABLE_KINDS: readonly DifferenceKind[] = [
  'null-change',
  'array-length',
  'value-change',
  'total-count-change',
];

const CASE_KEY_PATTERN = '^[0-9a-f]{64}:[0-9a-f]{64}$';
const DELTA_ID_PATTERN = '^[a-z0-9][a-z0-9-]*$';
const ROOT_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
/** Relative to the root: key segments, `[n]`/`[*]` indexes, `*` = any one key. */
const PATH_PATTERN_PATTERN =
  '^(\\*|[A-Za-z_][A-Za-z0-9_]*)?(\\[(\\d+|\\*)\\]|\\.(\\*|[A-Za-z_][A-Za-z0-9_]*))*$';

const PinnedEntrySchema = Type.Object(
  {
    type: Type.Literal('pinned'),
    key: Type.String({ pattern: CASE_KEY_PATTERN }),
    path: Type.String({ pattern: '^\\$' }),
    kind: Type.Union(PINNABLE_KINDS.map((kind) => Type.Literal(kind))),
    reason: Type.String({ minLength: 1 }),
    before: Type.Optional(Type.Unknown()),
    after: Type.Optional(Type.Unknown()),
    beforeSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
    afterSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  },
  { additionalProperties: false }
);

const PredicateSchema = Type.Union([
  Type.Object(
    {
      ratio: Type.Object(
        { min: Type.Number(), max: Type.Number() },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object({ relativeTolerance: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ absoluteTolerance: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
]);

const SystematicEntrySchema = Type.Object(
  {
    type: Type.Literal('systematic'),
    deltaId: Type.String({ pattern: DELTA_ID_PATTERN }),
    root: Type.String({ pattern: ROOT_PATTERN }),
    pathPattern: Type.String({ pattern: PATH_PATTERN_PATTERN }),
    kind: Type.Literal('value-change'),
    predicate: PredicateSchema,
    reason: Type.String({ minLength: 1 }),
    caseKeys: Type.Optional(
      Type.Array(Type.String({ pattern: CASE_KEY_PATTERN }), { minItems: 1 })
    ),
  },
  { additionalProperties: false }
);

const DriftEntrySchema = Type.Object(
  {
    type: Type.Literal('drift'),
    deltaId: Type.String({ pattern: DELTA_ID_PATTERN }),
    root: Type.String({ pattern: ROOT_PATTERN }),
    pathPattern: Type.String({ pattern: PATH_PATTERN_PATTERN }),
    kind: Type.Union([Type.Literal('value-drift'), Type.Literal('array-cardinality')]),
    explanation: Type.String({ minLength: 1 }),
    caseKeys: Type.Optional(
      Type.Array(Type.String({ pattern: CASE_KEY_PATTERN }), { minItems: 1 })
    ),
  },
  { additionalProperties: false }
);

const AllowlistEntrySchema = Type.Union([
  PinnedEntrySchema,
  SystematicEntrySchema,
  DriftEntrySchema,
]);

const AllowlistFileSchema = Type.Object(
  {
    entries: Type.Array(AllowlistEntrySchema),
  },
  { additionalProperties: false }
);

export type PinnedEntry = Static<typeof PinnedEntrySchema>;
export type SystematicEntry = Static<typeof SystematicEntrySchema>;
export type DriftEntry = Static<typeof DriftEntrySchema>;
export type AllowlistEntry = Static<typeof AllowlistEntrySchema>;
export type AllowlistFile = Static<typeof AllowlistFileSchema>;
export type Predicate = Static<typeof PredicateSchema>;

export const DEFAULT_ALLOWLIST_PATH = path.resolve(import.meta.dirname, 'parity-allowlist.json');

/** `TEST_GM_ALLOWLIST_PATH` overrides the committed file (offline fixtures, dry runs). */
export function resolveAllowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TEST_GM_ALLOWLIST_PATH'];
  return configured !== undefined && configured.length > 0
    ? path.resolve(configured)
    : DEFAULT_ALLOWLIST_PATH;
}

/** Difference kinds each `drift` kind covers. */
export const DRIFT_KIND_COVERS: Record<DriftEntry['kind'], readonly DifferenceKind[]> = {
  'value-drift': ['value-change', 'null-change'],
  'array-cardinality': ['array-length'],
};

// =============================================================================
// Fingerprints
// =============================================================================

function renderable(value: unknown): unknown {
  if (isLosslessNumber(value)) return value.toString();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(renderable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderable(item);
    }
    return out;
  }
  return value;
}

/**
 * Canonical text of a difference side: sorted-keys JSON with every number
 * rendered as decimal text. `undefined` (absent) renders as the string
 * `"<absent>"`.
 */
export function fingerprintOf(value: unknown): string {
  if (value === undefined) return '"<absent>"';
  const result = canonicalJsonStringify(renderable(value));
  if (result.isErr()) {
    throw new Error(`value cannot be fingerprinted: ${result.error.message}`);
  }
  return result.value;
}

export function fingerprintSha256(value: unknown): string {
  return createHash('sha256').update(fingerprintOf(value), 'utf8').digest('hex');
}

// =============================================================================
// Loading
// =============================================================================

export class AllowlistValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistValidationError';
  }
}

/** Validates an already-parsed allowlist document. Pure. */
export function validateAllowlist(raw: unknown): AllowlistFile {
  if (!Value.Check(AllowlistFileSchema, raw)) {
    const problems = [...Value.Errors(AllowlistFileSchema, raw)]
      .slice(0, 5)
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    throw new AllowlistValidationError(`parity-allowlist.json is invalid: ${problems}`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries.entries()) {
    const id = entryId(entry);
    if (seen.has(id)) {
      throw new AllowlistValidationError(
        `parity-allowlist.json entry ${String(index)} duplicates an earlier entry (${id})`
      );
    }
    seen.add(id);
    if (entry.type === 'pinned') validatePinned(index, entry);
    if (entry.type === 'systematic') validatePredicate(index, entry);
  }
  return raw;
}

function validatePinned(index: number, entry: PinnedEntry): void {
  if ('before' in entry !== 'after' in entry) {
    throw new AllowlistValidationError(
      `parity-allowlist.json entry ${String(index)} (${entry.path}) has only one of "before"/"after"`
    );
  }
  if ((entry.beforeSha256 === undefined) !== (entry.afterSha256 === undefined)) {
    throw new AllowlistValidationError(
      `parity-allowlist.json entry ${String(index)} (${entry.path}) has only one of "beforeSha256"/"afterSha256"`
    );
  }
  const hasValues = 'before' in entry && 'after' in entry;
  const hasHashes = entry.beforeSha256 !== undefined && entry.afterSha256 !== undefined;
  if (!hasValues && !hasHashes) {
    throw new AllowlistValidationError(
      `parity-allowlist.json entry ${String(index)} (${entry.path}) must pin the difference with "before"+"after" or "beforeSha256"+"afterSha256"`
    );
  }
}

function validatePredicate(index: number, entry: SystematicEntry): void {
  const { predicate } = entry;
  if ('ratio' in predicate) {
    const { min, max } = predicate.ratio;
    if (!(min <= max) || !Number.isFinite(min) || !Number.isFinite(max)) {
      throw new AllowlistValidationError(
        `parity-allowlist.json entry ${String(index)} (${entry.deltaId}) has an empty or non-finite ratio range`
      );
    }
    // A range containing 1 would accept "no change", which is not a delta.
    if (min <= 1 && max >= 1) {
      throw new AllowlistValidationError(
        `parity-allowlist.json entry ${String(index)} (${entry.deltaId}) ratio range [${String(min)}, ${String(max)}] contains 1 — a systematic delta must exclude "unchanged"`
      );
    }
  }
}

/**
 * Parsed losslessly, so a pinned `before: 9007199254740993` is not mangled.
 * Predicate bounds are plain JS numbers (the schema checks them as such),
 * so only the `predicate` subtree is converted back.
 */
export function loadAllowlist(filePath: string = resolveAllowlistPath()): AllowlistFile {
  const text = readFileSync(filePath, 'utf8');
  const raw = parseLosslessJson(text);
  if (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    for (const entry of (raw as { entries: unknown[] }).entries) {
      if (entry !== null && typeof entry === 'object' && 'predicate' in entry) {
        entry.predicate = toPlain(entry.predicate);
      }
    }
  }
  return validateAllowlist(raw);
}

// =============================================================================
// Matching
// =============================================================================

/** Stable identity of an entry (stale detection, per-entry aggregates). */
export function entryId(entry: AllowlistEntry): string {
  switch (entry.type) {
    case 'pinned':
      return `pinned|${entry.key}|${entry.path}|${entry.kind}`;
    case 'systematic':
      return `systematic|${entry.deltaId}|${entry.root}|${entry.pathPattern}|${entry.kind}`;
    case 'drift':
      return `drift|${entry.deltaId}|${entry.root}|${entry.pathPattern}|${entry.kind}`;
  }
}

export function entryDeltaId(entry: AllowlistEntry): string | null {
  return entry.type === 'pinned' ? null : entry.deltaId;
}

/** Full JSONPath the entry's root + pattern denote, e.g. `$.data.entityAnalytics.nodes[*].amount`. */
export function entryFullPattern(entry: SystematicEntry | DriftEntry): string {
  const root = `$.data.${entry.root}`;
  if (entry.pathPattern === '') return root;
  return entry.pathPattern.startsWith('[')
    ? `${root}${entry.pathPattern}`
    : `${root}.${entry.pathPattern}`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Anchored regex for a full pattern: `[*]` = any index, `*` = any one key. */
export function pathPatternRegex(fullPattern: string): RegExp {
  const source = escapeRegex(fullPattern)
    .replace(/\\\[\\\*\\\]/g, '\\[\\d+\\]')
    .replace(/\\\*/g, '[A-Za-z0-9_]+');
  return new RegExp(`^${source}$`);
}

export function pathMatches(entry: SystematicEntry | DriftEntry, differencePath: string): boolean {
  return pathPatternRegex(entryFullPattern(entry)).test(differencePath);
}

export function predicateHolds(predicate: Predicate, expected: unknown, actual: unknown): boolean {
  if (!isNumeric(expected) || !isNumeric(actual)) return false;
  const e = toDecimal(expected);
  const a = toDecimal(actual);
  if ('ratio' in predicate) {
    if (e.isZero()) return false;
    const ratio = a.div(e);
    return ratio.gte(predicate.ratio.min) && ratio.lte(predicate.ratio.max);
  }
  if ('relativeTolerance' in predicate) {
    const rel = relativeDifference(expected, actual);
    return rel !== null && rel <= predicate.relativeTolerance;
  }
  return a.minus(e).abs().lte(predicate.absoluteTolerance);
}

export function entryMatchesDifference(
  entry: AllowlistEntry,
  caseKey: string,
  difference: Difference
): boolean {
  // A `total-count-change` is a contract-break that ONLY an exact pin can admit
  // (see PINNABLE_KINDS); every other contract-break is never allowlistable.
  if (difference.class === 'contract-break') {
    if (difference.kind !== 'total-count-change' || entry.type !== 'pinned') return false;
  } else if (difference.class !== 'data-parity') {
    return false;
  }

  if (entry.type === 'pinned') {
    if (entry.key !== caseKey) return false;
    if (entry.path !== difference.path) return false;
    if (entry.kind !== difference.kind) return false;
    const expectedSha = fingerprintSha256(difference.expected);
    const actualSha = fingerprintSha256(difference.actual);
    if (entry.beforeSha256 !== undefined && entry.afterSha256 !== undefined) {
      if (entry.beforeSha256 !== expectedSha || entry.afterSha256 !== actualSha) return false;
    }
    if ('before' in entry && 'after' in entry) {
      if (fingerprintSha256(entry.before) !== expectedSha) return false;
      if (fingerprintSha256(entry.after) !== actualSha) return false;
    }
    return true;
  }

  if (entry.caseKeys !== undefined && !entry.caseKeys.includes(caseKey)) return false;
  if (!pathMatches(entry, difference.path)) return false;

  if (entry.type === 'systematic') {
    if (difference.kind !== 'value-change') return false;
    return predicateHolds(entry.predicate, difference.expected, difference.actual);
  }

  return DRIFT_KIND_COVERS[entry.kind].includes(difference.kind);
}

export interface AllowedDifference {
  difference: Difference;
  entry: AllowlistEntry;
  /** `|a−e| / max(|e|,|a|)` for numeric pairs (and array lengths), else null. */
  relativeDifference: number | null;
}

export interface AppliedAllowlist {
  /** Differences the allowlist accepts (all `data-parity`). */
  allowed: AllowedDifference[];
  /** Differences that still fail the case. */
  blocking: Difference[];
  /** Differences that never fail (`rounding`). */
  informational: Difference[];
}

/**
 * Splits a case's differences into blocking / allowed / informational.
 * `contract-break` is always blocking — except a `total-count-change` that an
 * exact `pinned` entry admits; `rounding` is always informational;
 * `data-parity` is blocking unless an entry accepts it (the first matching
 * entry in file order is recorded).
 */
export function applyAllowlist(
  differences: readonly Difference[],
  allowlist: AllowlistFile,
  caseKey: string
): AppliedAllowlist {
  const result: AppliedAllowlist = { allowed: [], blocking: [], informational: [] };

  for (const difference of differences) {
    if (difference.class === 'rounding') {
      result.informational.push(difference);
      continue;
    }
    if (difference.class === 'contract-break' && difference.kind !== 'total-count-change') {
      result.blocking.push(difference);
      continue;
    }
    const entry = allowlist.entries.find((candidate) =>
      entryMatchesDifference(candidate, caseKey, difference)
    );
    if (entry === undefined) {
      result.blocking.push(difference);
    } else {
      result.allowed.push({
        difference,
        entry,
        relativeDifference: relativeDifference(difference.expected, difference.actual),
      });
    }
  }

  return result;
}

/** Per-entry aggregate for one case: the magnitude a reviewer needs. */
export interface EntryMatchSummary {
  entryId: string;
  type: AllowlistEntry['type'];
  deltaId: string | null;
  matches: number;
  maxRelativeDifference: number | null;
  maxRelativeDifferencePath: string | null;
}

export function summarizeAllowed(allowed: readonly AllowedDifference[]): EntryMatchSummary[] {
  const byEntry = new Map<string, EntryMatchSummary>();
  for (const item of allowed) {
    const id = entryId(item.entry);
    const current = byEntry.get(id) ?? {
      entryId: id,
      type: item.entry.type,
      deltaId: entryDeltaId(item.entry),
      matches: 0,
      maxRelativeDifference: null,
      maxRelativeDifferencePath: null,
    };
    current.matches += 1;
    if (
      item.relativeDifference !== null &&
      (current.maxRelativeDifference === null ||
        item.relativeDifference > current.maxRelativeDifference)
    ) {
      current.maxRelativeDifference = item.relativeDifference;
      current.maxRelativeDifferencePath = item.difference.path;
    }
    byEntry.set(id, current);
  }
  return [...byEntry.values()];
}

/**
 * Entries that matched no difference in the run — stale rows that would
 * otherwise accept a difference nobody is looking at anymore.
 */
export function findStaleEntries(
  allowlist: AllowlistFile,
  usedEntryIds: ReadonlySet<string>
): AllowlistEntry[] {
  return allowlist.entries.filter((entry) => !usedEntryIds.has(entryId(entry)));
}

export function describeEntry(entry: AllowlistEntry): string {
  switch (entry.type) {
    case 'pinned':
      return `pinned ${entry.key.slice(0, 12)}… ${entry.path} ${entry.kind}: ${entry.reason}`;
    case 'systematic':
      return `systematic ${entry.deltaId} ${entryFullPattern(entry)} ${entry.kind} ${JSON.stringify(entry.predicate)}: ${entry.reason}`;
    case 'drift':
      return `drift ${entry.deltaId} ${entryFullPattern(entry)} ${entry.kind}: ${entry.explanation}`;
  }
}

export function isStrictAllowlist(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env['TEST_GM_STRICT_ALLOWLIST'];
  if (configured === undefined) return true;
  return configured === 'true';
}
