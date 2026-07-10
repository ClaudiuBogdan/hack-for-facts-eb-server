/**
 * Procurement module — repo filter helpers (plan §7). Compiles the
 * REPO-INTERCEPTED filter fields the kernel composer does NOT handle:
 *   - `cpvDivision[]` → an INDEX-SAFE range over `cpv_code` (NOT `substring()`,
 *     which would skip the *_cpv_code_idx; §7.1 I7).
 *   - `year` (eq/in/between) → a `date >= … AND date < …` range on the indexed
 *     date column (publication/contract/finalization).
 *   - `includeDuplicates` → forces `is_canonical = true` unless explicitly true.
 *   - the DA `requiresSelective` runtime check (§3a(1)/§7.3 I5).
 *
 * Every emitted predicate is parameterized via Kysely `sql```. Identifier refs use
 * `sql.ref` on trusted internal alias/column literals.
 */

import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type FieldFilter,
  type FilterInput,
} from '@/modules/shared/index.js';

import { DA_SELECTIVE_FIELDS } from '../../core/filters.js';

/** Read a field's op-bag from a FilterInput (the `{ eq, in, between, … }` object). */
export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const f = input[name];
  return f !== undefined && typeof f === 'object' && !Array.isArray(f) ? f : undefined;
};

/** A boolean `eq` value (true/'true'). */
export const boolEq = (input: FilterInput, name: string): boolean | undefined => {
  const v = fieldOf(input, name)?.['eq'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

// ── CPV division → index-safe range ────────────────────────────────────────────

/** Coerce a CPV division token to its canonical 2-digit form, or null if invalid. */
const normalizeDivision = (raw: unknown): string | null => {
  const s = String(raw).trim();
  return /^\d{2}$/u.test(s) ? s : null;
};

/**
 * Build an index-safe OR of `cpv_code >= 'dd000000' AND cpv_code < successor`
 * ranges for the requested divisions. Uses the *_cpv_code_idx btree (left-anchored
 * range), never `substring(cpv_code,1,2)` (no functional index exists for that).
 * Returns undefined when no valid division is supplied.
 */
export const cpvDivisionRange = (
  input: FilterInput,
  alias: string,
  column = 'cpv_code'
): Result<RawBuilder<unknown> | undefined, ApiError> => {
  const ff = fieldOf(input, 'cpvDivision');
  if (ff === undefined) return ok(undefined);
  // An EXPLICIT empty `in: []` means "match nothing" → FALSE, NOT a dropped predicate
  // (a no-op would silently match ALL rows; mirrors the kernel composer, Codex #4).
  if (Array.isArray(ff['in']) && ff['in'].length === 0 && ff['eq'] === undefined) {
    return ok(sql`false`);
  }
  const raw = ff['in'] ?? ff['eq'];
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  if (list.length === 0) return ok(undefined);
  const divisions: string[] = [];
  for (const d of list) {
    const norm = normalizeDivision(d);
    if (norm === null)
      return err(
        invalidInput(`cpvDivision must be a 2-digit code, got '${String(d)}'`, 'cpvDivision')
      );
    divisions.push(norm);
  }
  const col = sql.ref(`${alias}.${column}`);
  const ranges = [...new Set(divisions)].map((d) => {
    const lo = `${d}000000`;
    // successor of the 2-digit prefix: '99' → use code < '99'||CHR boundary. The
    // cpv space is 8-digit numeric strings; the upper bound is the next division's
    // floor ('dd'+1 padded), or an all-9s ceiling for division 99.
    const next = String(Number(d) + 1).padStart(2, '0');
    const hi = d === '99' ? '99999999' : `${next}000000`;
    return d === '99'
      ? sql`(${col} >= ${lo} and ${col} <= ${hi})`
      : sql`(${col} >= ${lo} and ${col} < ${hi})`;
  });
  return ok(ranges.length === 1 ? ranges[0] : sql`(${sql.join(ranges, sql` or `)})`);
};

// ── year → date range on an indexed date column ────────────────────────────────

/**
 * Expand a `year` filter (eq / in / between) into a half-open date range on the
 * indexed date column. `in`/`between` produce a single `[minYearStart, maxYearEnd)`
 * span (a coarse but index-friendly bound; exact year membership for sparse `in`
 * lists is left to the small result set). Returns undefined when no year filter.
 */
export const yearDateRange = (
  input: FilterInput,
  alias: string,
  dateColumn: string
): Result<RawBuilder<unknown> | undefined, ApiError> => {
  const ff = fieldOf(input, 'year');
  if (ff === undefined) return ok(undefined);
  const col = sql.ref(`${alias}.${dateColumn}`);

  const yearStart = (y: number): string => `${String(y)}-01-01`;
  const yearAfter = (y: number): string => `${String(y + 1)}-01-01`;

  const toInt = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : null;
  };

  if (ff['eq'] !== undefined) {
    const y = toInt(ff['eq']);
    if (y === null) return err(invalidInput('year must be an integer', 'year'));
    return ok(sql`(${col} >= ${yearStart(y)}::date and ${col} < ${yearAfter(y)}::date)`);
  }
  if (Array.isArray(ff['in'])) {
    const years = ff['in'].map(toInt);
    if (years.some((y) => y === null) || years.length === 0) {
      return err(invalidInput('year in[] must be a non-empty list of integers', 'year'));
    }
    // EXACT per-year membership: an OR of half-open ranges, so `in:[2022,2024]` does
    // NOT silently include 2023 (Codex #3). Each range is index-friendly.
    const ranges = [...new Set(years as number[])].map(
      (y) => sql`(${col} >= ${yearStart(y)}::date and ${col} < ${yearAfter(y)}::date)`
    );
    if (ranges.length === 1) return ok(ranges[0] ?? sql`false`);
    return ok(sql`(${sql.join(ranges, sql` or `)})`);
  }
  const between = ff['between'];
  if (between !== undefined && typeof between === 'object' && !Array.isArray(between)) {
    const b = between as { from?: unknown; to?: unknown };
    const conds: RawBuilder<unknown>[] = [];
    if (b.from !== undefined) {
      const y = toInt(b.from);
      if (y === null) return err(invalidInput('year.from must be an integer', 'year'));
      conds.push(sql`${col} >= ${yearStart(y)}::date`);
    }
    if (b.to !== undefined) {
      const y = toInt(b.to);
      if (y === null) return err(invalidInput('year.to must be an integer', 'year'));
      conds.push(sql`${col} < ${yearAfter(y)}::date`);
    }
    if (conds.length === 0) return ok(undefined);
    return ok(sql`(${sql.join(conds, sql` and `)})`);
  }
  return ok(undefined);
};

// ── canonical / duplicates predicate ───────────────────────────────────────────

/** Force `is_canonical = true` unless `includeDuplicates: { eq: true }` is set. */
export const canonicalPredicate = (
  input: FilterInput,
  alias: string
): RawBuilder<unknown> | undefined => {
  if (boolEq(input, 'includeDuplicates') === true) return undefined;
  return sql`${sql.ref(`${alias}.is_canonical`)} = true`;
};

// ── DA selective-filter runtime check (§3a(1)) ─────────────────────────────────

/**
 * Reject an empty / non-selective DA filter on ALL surfaces. A selective filter =
 * at least one entity/cpv/uniqueCode dimension OR a date window whose SPAN is
 * bounded (≤ maxWindowDays). The GraphQL non-null `filter` arg only guarantees the
 * wrapper exists — `{}` (or only includeDuplicates) still trips this (§7.3 I5).
 * Note (review): a date window present but TOO WIDE is rejected, not accepted — a
 * 10-year `year between` or `finalizationDate between` still seq-scans 20M rows.
 */
export const assertDaSelective = (
  input: FilterInput,
  maxWindowDays: number
): Result<void, ApiError> => {
  // Any entity/cpv/uniqueCode dimension with a real value is selective.
  for (const name of DA_SELECTIVE_FIELDS) {
    if (name === 'year' || name === 'finalizationDate') continue;
    const ff = fieldOf(input, name);
    if (ff === undefined) continue;
    // An explicit empty in:[] is NOT selective (§7.3; the empty-array footgun).
    const inVal = ff['in'];
    if (
      Array.isArray(inVal) &&
      inVal.length === 0 &&
      ff['eq'] === undefined &&
      ff['prefix'] === undefined
    )
      continue;
    return ok(undefined);
  }

  const yearDays = Math.ceil(maxWindowDays / 365); // window cap expressed in whole years

  // year: eq = 1 year (always within cap); in[] / between bounded by span ≤ cap.
  const yearFF = fieldOf(input, 'year');
  if (yearFF !== undefined) {
    const span = yearSpan(yearFF);
    if (span === null) {
      return err(
        invalidInput(
          'direct-acquisitions year filter must be a bounded eq / in[] / between',
          'year'
        )
      );
    }
    if (span <= yearDays) return ok(undefined);
    return err(
      invalidInput(
        `direct-acquisitions year window must span ≤ ${String(yearDays)} year(s)`,
        'year'
      )
    );
  }

  // finalizationDate.between: span ≤ maxWindowDays.
  const between = fieldOf(input, 'finalizationDate')?.['between'];
  if (between !== undefined && typeof between === 'object' && !Array.isArray(between)) {
    const b = between as { from?: unknown; to?: unknown };
    if (typeof b.from === 'string' && typeof b.to === 'string') {
      const from = Date.parse(b.from);
      const to = Date.parse(b.to);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        const days = (to - from) / 86_400_000;
        if (days >= 0 && days <= maxWindowDays) return ok(undefined);
        return err(
          invalidInput(
            `direct-acquisitions date window must be ≤ ${String(maxWindowDays)} days (got ${String(Math.round(days))})`,
            'finalizationDate'
          )
        );
      }
    }
  }
  return err(
    invalidInput(
      'direct-acquisitions list requires a selective filter: authorityCui, supplierCui, cpvCode, cpvDivision, uniqueCode, a single year, or a bounded finalizationDate window',
      'filter'
    )
  );
};

/** Whole-year span of a `year` op-bag (eq=1, in=max-min+1, between=to-from+1), or null if unbounded. */
const yearSpan = (ff: FieldFilter): number | null => {
  const toInt = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) ? n : null;
  };
  if (ff['eq'] !== undefined) return toInt(ff['eq']) === null ? null : 1;
  if (Array.isArray(ff['in'])) {
    const ys = ff['in'].map(toInt).filter((y): y is number => y !== null);
    return ys.length > 0 ? Math.max(...ys) - Math.min(...ys) + 1 : null;
  }
  const b = ff['between'];
  if (b !== undefined && typeof b === 'object' && !Array.isArray(b)) {
    const from = toInt((b as { from?: unknown }).from);
    const to = toInt((b as { to?: unknown }).to);
    if (from !== null && to !== null) return Math.abs(to - from) + 1;
  }
  return null;
};
