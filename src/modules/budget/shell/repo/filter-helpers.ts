/**
 * Budget repo — filter-input helpers (plan §3/§7).
 *
 * The FACT specs carry VIRTUAL fields (no physical column) the repo intercepts:
 *  - `frequency` → selects the partial period-scope index + the amount column;
 *  - `months`/`quarters` → tuple predicate within the year;
 *  - `minAmount`/`maxAmount` → row-level range on the frequency amount column;
 *  - `excludeTransfers` → the baked-in transfer code set (fact path only).
 * They appear in the spec (so they surface in GraphQL/TypeBox + the fhash) but the
 * kernel composer must NOT compile them. This helper splits a FilterInput and
 * enforces the §0.3 grain gate (the pruning triple is non-removable).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FieldFilter, type FilterInput } from '@/modules/shared/index.js';

import {
  ACCOUNT_CATEGORY_LABELS,
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_REPORT_TYPE_LABELS,
  type AccountCategory,
  type BudgetFrequency,
  type CommitmentReportType,
  type ExecutionReportType,
} from '../../core/constants.js';


/** Pull a single field's op-map out of a FilterInput (typed, undefined-safe). */
export const fieldOf = (input: FilterInput, name: string): FieldFilter | undefined => {
  const v = input[name];
  if (v === undefined || typeof v !== 'object') return undefined;
  return v;
};

/** Remove the named virtual fields from a FilterInput (so the composer skips them). */
export const omitFields = (input: FilterInput, names: readonly string[]): FilterInput => {
  const drop = new Set(names);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'exclude') {
      // Also strip dropped names from the exclude sub-object.
      if (value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
        const ex: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!drop.has(k)) ex[k] = v;
        }
        if (Object.keys(ex).length > 0) out['exclude'] = ex;
      }
      continue;
    }
    if (!drop.has(key)) out[key] = value;
  }
  return out as FilterInput;
};

/** Coerce a scalar `eq` value out of a field's op-map. */
export const eqValue = (f: FieldFilter | undefined): string | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
};

/** Coerce an `in` array of strings out of a field's op-map. */
export const inValues = (f: FieldFilter | undefined): readonly string[] | undefined => {
  if (f === undefined) return undefined;
  const v = f['in'];
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
};

/** Read an int `eq` off a field op-map. */
export const intEq = (f: FieldFilter | undefined): number | undefined => {
  const v = eqValue(f);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

/** Read a bool `eq` off a field op-map. */
export const boolEq = (f: FieldFilter | undefined): boolean | undefined => {
  if (f === undefined) return undefined;
  const v = f['eq'];
  if (v === undefined) return undefined;
  return v === true || v === 'true';
};

/** Read a `between` { from, to } off a field op-map (numbers). */
export const intBetween = (f: FieldFilter | undefined): { from?: number; to?: number } | undefined => {
  if (f === undefined) return undefined;
  const v = f['between'];
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as { from?: unknown; to?: unknown };
  const out: { from?: number; to?: number } = {};
  if (r.from !== undefined) out.from = Number(r.from);
  if (r.to !== undefined) out.to = Number(r.to);
  return out;
};

/** Read an `in` array of ints off a field op-map. */
export const intIn = (f: FieldFilter | undefined): readonly number[] | undefined => {
  const vs = inValues(f);
  if (vs === undefined) return undefined;
  const out: number[] = [];
  for (const v of vs) {
    const n = Number(v);
    if (Number.isInteger(n)) out.push(n);
  }
  return out.length > 0 ? out : undefined;
};

// ── the §0.3 grain gate (the pruning triple resolution) ───────────────────────

export interface ExecutionGate {
  readonly years: { eq?: number; in?: readonly number[]; from?: number; to?: number };
  readonly reportLabel: string; // the partition literal
  readonly reportType: ExecutionReportType;
  readonly accountLabel: string; // 'vn' | 'ch'
  readonly accountCategory: AccountCategory;
  readonly frequency: BudgetFrequency;
}

/**
 * Resolve the execution fact pruning gate from a (defaults-filled) FilterInput.
 * The repo calls this AFTER `canonicalize`/defaults so reportType+accountCategory
 * are always present (the spec defaults them). reportingYear is mandatory — a
 * fact query with no year is rejected (§0.3). Returns the partition LITERALS the
 * SQL must use so the planner prunes to one leaf.
 */
export const resolveExecutionGate = (
  input: FilterInput,
  defaults: { reportType: ExecutionReportType; accountCategory: AccountCategory; frequency: BudgetFrequency }
): Result<ExecutionGate, ApiError> => {
  const yearF = fieldOf(input, 'reportingYear');
  const yEq = intEq(yearF);
  const yIn = intIn(yearF);
  const yBetween = intBetween(yearF);
  const hasYear =
    yEq !== undefined ||
    (yIn !== undefined && yIn.length > 0) ||
    (yBetween !== undefined && (yBetween.from !== undefined || yBetween.to !== undefined));
  if (!hasYear) {
    return err(
      invalidInput(
        'unbounded budget scan: supply reportingYear (single, in, or between) so the partition prunes',
        'reportingYear'
      )
    );
  }

  const rtRaw = eqValue(fieldOf(input, 'reportType')) ?? defaults.reportType;
  if (!(rtRaw in EXECUTION_REPORT_TYPE_LABELS)) {
    return err(invalidInput(`unknown reportType '${rtRaw}'`, 'reportType'));
  }
  const reportType = rtRaw as ExecutionReportType;

  const acRaw = eqValue(fieldOf(input, 'accountCategory')) ?? defaults.accountCategory;
  if (!(acRaw in ACCOUNT_CATEGORY_LABELS)) {
    return err(invalidInput(`unknown accountCategory '${acRaw}'`, 'accountCategory'));
  }
  const accountCategory = acRaw as AccountCategory;

  const freqRaw = eqValue(fieldOf(input, 'frequency')) ?? defaults.frequency;
  if (freqRaw !== 'MONTH' && freqRaw !== 'QUARTER' && freqRaw !== 'YEAR') {
    return err(invalidInput(`unknown frequency '${freqRaw}'`, 'frequency'));
  }

  return ok({
    years: {
      ...(yEq !== undefined && { eq: yEq }),
      ...(yIn !== undefined && yIn.length > 0 && { in: yIn }),
      ...(yBetween?.from !== undefined && { from: yBetween.from }),
      ...(yBetween?.to !== undefined && { to: yBetween.to }),
    },
    reportLabel: EXECUTION_REPORT_TYPE_LABELS[reportType],
    reportType,
    accountLabel: ACCOUNT_CATEGORY_LABELS[accountCategory],
    accountCategory,
    frequency: freqRaw,
  });
};

export interface CommitmentGate {
  readonly years: { eq?: number; in?: readonly number[]; from?: number; to?: number };
  readonly reportLabel: string;
  readonly reportType: CommitmentReportType;
  readonly frequency: BudgetFrequency;
}

/** Resolve the commitment fact pruning PAIR (year + report_type; NO account_category). */
export const resolveCommitmentGate = (
  input: FilterInput,
  defaults: { reportType: CommitmentReportType; frequency: BudgetFrequency }
): Result<CommitmentGate, ApiError> => {
  const yearF = fieldOf(input, 'reportingYear');
  const yEq = intEq(yearF);
  const yIn = intIn(yearF);
  const yBetween = intBetween(yearF);
  const hasYear =
    yEq !== undefined ||
    (yIn !== undefined && yIn.length > 0) ||
    (yBetween !== undefined && (yBetween.from !== undefined || yBetween.to !== undefined));
  if (!hasYear) {
    return err(invalidInput('unbounded budget scan: supply reportingYear', 'reportingYear'));
  }

  // Commitments have NO account_category — reject if one was sent (plan §0.3).
  if (fieldOf(input, 'accountCategory') !== undefined) {
    return err(
      invalidInput('commitments have no accountCategory (single grain per row)', 'accountCategory')
    );
  }

  const rtRaw = eqValue(fieldOf(input, 'reportType')) ?? defaults.reportType;
  if (!(rtRaw in COMMITMENT_REPORT_TYPE_LABELS)) {
    return err(invalidInput(`unknown reportType '${rtRaw}'`, 'reportType'));
  }
  const reportType = rtRaw as CommitmentReportType;

  const freqRaw = eqValue(fieldOf(input, 'frequency')) ?? defaults.frequency;
  if (freqRaw !== 'MONTH' && freqRaw !== 'QUARTER' && freqRaw !== 'YEAR') {
    return err(invalidInput(`unknown frequency '${freqRaw}'`, 'frequency'));
  }

  return ok({
    years: {
      ...(yEq !== undefined && { eq: yEq }),
      ...(yIn !== undefined && yIn.length > 0 && { in: yIn }),
      ...(yBetween?.from !== undefined && { from: yBetween.from }),
      ...(yBetween?.to !== undefined && { to: yBetween.to }),
    },
    reportLabel: COMMITMENT_REPORT_TYPE_LABELS[reportType],
    reportType,
    frequency: freqRaw,
  });
};
