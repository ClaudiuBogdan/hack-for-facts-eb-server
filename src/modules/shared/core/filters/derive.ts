/**
 * Shared Kernel — pure filter canonicalization (foundation §14.2, §14.3).
 *
 * `canonicalizeFilters` normalizes defaults, fields, operators, arrays, and
 * scalar values. `filterHash` and `fhashFor` derive stable cursor/cache keys.
 * SQL compilation is shell-owned so this core module remains framework-free.
 */

import type {
  CollectionFilterSpec,
  FieldFilter,
  FilterFieldSpec,
  FilterInput,
  FilterValue,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Operators whose SQL is case-INSENSITIVE, and therefore the ONLY ones whose
 * values may be case-folded into the fhash.
 *
 * `contains` and `prefix` compile to `ilike` (shell/filters/derive.ts `opSql`);
 * every other operator compiles to `=`, `in (…)` or a `<`/`>` comparison, all of
 * which Postgres evaluates case-SENSITIVELY. `contains` on an ARRAY column is the
 * exception inside the exception — it compiles to `@>`, which is exact — so the
 * fold is additionally gated on the column not being an array (see `foldsCase`).
 */
const CASE_INSENSITIVE_OPS: ReadonlySet<string> = new Set(['contains', 'prefix']);

/**
 * Does the query fold case for this field+operator? The fhash may only fold what
 * the QUERY folds: an fhash coarser than the query silently equates two filters
 * that return DIFFERENT rows, so a cursor minted under one decodes cleanly under
 * the other and then pages the wrong set (`groupVote.group:"PSD"` vs `"psd"` —
 * `vote_records.group_name` matches exactly, so the second is an empty result the
 * client cannot distinguish from the end of the list).
 *
 * The rule is derived from the kernel's own SQL compiler rather than declared
 * per field, so a spec author cannot forget it. Being stricter than the query
 * (a repo-intercepted virtual field that resolves its value case-insensitively)
 * costs only a rejected cursor — a clean INVALID_INPUT — never a wrong page.
 */
const foldsCase = (field: FilterFieldSpec, op: string): boolean =>
  CASE_INSENSITIVE_OPS.has(op) && field.column.arrayColumn !== true;

/**
 * Coerce a scalar to its canonical form by FIELD TYPE so the three surfaces
 * agree: REST `"2024"` and GraphQL `2024` both fold to the number `2024`. This is
 * what makes the fhash identical cross-surface. Strings are folded to lower case
 * ONLY when `fold` says the query itself ignores case (see `foldsCase`).
 */
const canonScalar = (type: FilterFieldSpec['type'], x: unknown, fold = false): unknown => {
  if (type === 'int' || type === 'number') {
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isFinite(n) ? n : x;
  }
  if (type === 'money') {
    // Normalize the decimal so "100", "100.00" and 100 hash identically
    // (numerically equal). Keep as a STRING (no float) to preserve precision.
    const s = typeof x === 'number' ? String(x) : typeof x === 'string' ? x.trim() : '';
    if (!/^-?\d+(\.\d+)?$/u.test(s)) return x;
    const neg = s.startsWith('-');
    const [intPart = '0', fracRaw = ''] = s.replace(/^-/u, '').split('.');
    const frac = fracRaw.replace(/0+$/u, '');
    const intNorm = intPart.replace(/^0+(?=\d)/u, '');
    const body = frac.length > 0 ? `${intNorm}.${frac}` : intNorm;
    return `${neg && body !== '0' ? '-' : ''}${body}`;
  }
  if (type === 'bool') return x === true || x === 'true';
  if (typeof x === 'string') return fold ? x.toLowerCase() : x;
  return x;
};

const toSortKey = (x: unknown): string =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : '';

const canonValue = (type: FilterFieldSpec['type'], v: FilterValue, fold = false): unknown => {
  if (Array.isArray(v)) {
    const items: unknown[] = (v as readonly (string | number)[]).map((x) =>
      canonScalar(type, x, fold)
    );
    return items.sort((a, b) => toSortKey(a).localeCompare(toSortKey(b)));
  }
  if (typeof v === 'object') {
    const o = v as { from?: unknown; to?: unknown };
    return {
      from: o.from === undefined ? null : canonScalar(type, o.from, fold),
      to: o.to === undefined ? null : canonScalar(type, o.to, fold),
    };
  }
  return canonScalar(type, v, fold);
};

const canonFieldFilter = (field: FilterFieldSpec, ff: FieldFilter): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  // A COMPOSITE field's keys are named members, not operators — canonicalize each
  // by ITS OWN type (an int member must not fold through the field's string rule),
  // and drop keys the spec does not declare so junk cannot alter the hash.
  const members =
    field.composite === undefined ? undefined : new Map(field.composite.map((m) => [m.name, m]));
  for (const op of Object.keys(ff).sort()) {
    const value = ff[op];
    if (value === undefined) continue;
    if (members !== undefined) {
      // A member's predicate is repo-owned, so the kernel cannot read a case rule
      // off an operator: never fold it. Exact is the safe direction (a stricter
      // cursor, never a cursor that survives a change of result set).
      const member = members.get(op);
      if (member !== undefined) out[op] = canonValue(member.type, value);
      continue;
    }
    out[op] = canonValue(field.type, value, foldsCase(field, op));
  }
  return out;
};

/**
 * Produce a stable canonical JSON string for an input against a spec. Defaults
 * declared on the spec are filled so that an omitted-vs-default input hashes
 * identically across the three surfaces.
 */
export const canonicalizeFilters = (spec: CollectionFilterSpec, input: FilterInput): string => {
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  const canon: { fields: Record<string, unknown>; exclude: Record<string, unknown> } = {
    fields: {},
    exclude: {},
  };

  // Fill defaults first.
  for (const f of spec.fields) {
    if (f.default !== undefined) {
      canon.fields[f.name] = { eq: canonValue(f.type, f.default as FilterValue) };
    }
  }

  for (const key of Object.keys(input)) {
    if (key === 'exclude') continue;
    const f = byName.get(key);
    if (f === undefined) continue;
    const ff = input[key];
    if (ff === undefined || typeof ff !== 'object') continue;
    const canonized = canonFieldFilter(f, ff);
    // An explicit empty `{ field: {} }` must not blow away a declared default.
    if (Object.keys(canonized).length > 0) canon.fields[key] = canonized;
  }

  const exclude = input.exclude;
  if (exclude !== undefined) {
    for (const key of Object.keys(exclude)) {
      const f = byName.get(key);
      const ff = exclude[key];
      if (f?.exclude === true && ff !== undefined) {
        canon.exclude[key] = canonFieldFilter(f, ff);
      }
    }
  }

  // Sort top-level keys for stability.
  const sortedFields = Object.fromEntries(Object.entries(canon.fields).sort());
  const sortedExclude = Object.fromEntries(Object.entries(canon.exclude).sort());
  return JSON.stringify({ c: spec.collection, fields: sortedFields, exclude: sortedExclude });
};

/**
 * A stable, non-cryptographic 64-bit FNV-1a hash of the canonical string,
 * rendered base36. 64 bits gives collision resistance commensurate with the
 * data volume so a deliberately-crafted different filter set cannot share an
 * fhash (the cursor only controls pagination, but we still reject mismatches).
 */
export const filterHash = (canonical: string): string => {
  // Two interleaved 32-bit FNV-1a lanes → an effective 64-bit digest.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x1234567;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c + i) & 0xff), 0x01000193);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

/** Convenience: canonicalize + hash in one call (the cursor `fhash`). */
export const fhashFor = (spec: CollectionFilterSpec, input: FilterInput): string =>
  filterHash(canonicalizeFilters(spec, input));
