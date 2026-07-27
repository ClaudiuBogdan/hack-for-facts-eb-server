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
 * Coerce a scalar to its canonical form by FIELD TYPE so the three surfaces
 * agree: REST `"2024"` and GraphQL `2024` both fold to the number `2024`;
 * strings lowercase. This is what makes the fhash identical cross-surface.
 */
const canonScalar = (type: FilterFieldSpec['type'], x: unknown): unknown => {
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
  if (typeof x === 'string') return x.toLowerCase();
  return x;
};

const toSortKey = (x: unknown): string =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : '';

const canonValue = (type: FilterFieldSpec['type'], v: FilterValue): unknown => {
  if (Array.isArray(v)) {
    const items: unknown[] = (v as readonly (string | number)[]).map((x) => canonScalar(type, x));
    return items.sort((a, b) => toSortKey(a).localeCompare(toSortKey(b)));
  }
  if (typeof v === 'object') {
    const o = v as { from?: unknown; to?: unknown };
    return {
      from: o.from === undefined ? null : canonScalar(type, o.from),
      to: o.to === undefined ? null : canonScalar(type, o.to),
    };
  }
  return canonScalar(type, v);
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
      const member = members.get(op);
      if (member !== undefined) out[op] = canonValue(member.type, value);
      continue;
    }
    out[op] = canonValue(field.type, value);
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
