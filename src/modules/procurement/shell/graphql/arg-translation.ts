/**
 * Procurement module — GraphQL arg translation (the client contract).
 *
 * The spec's filter inputs are operator objects (`{ eq }`, `{ in }`, `{ contains }`,
 * `{ gte, lte }`). This module validates them and lowers them onto the core
 * `ProcurementSearchFilter` / `AnalysisScope`. Unknown keys are ignored; a malformed
 * one is an `InvalidInput`, never a silently-dropped predicate.
 *
 * DA date note: the spec calls the DA date facet `publicationDate`, but
 * `direct_acquisitions.publication_date` is 100% NULL on the `elicitatie_da` half of
 * the table. The range therefore binds to the populated, indexed `finalization_date`
 * — the same column the existing cursor list has always used.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, normalizeCui, type ApiError } from '@/modules/shared/index.js';

import { parseAnalysisScope, type AnalysisScope } from '../../core/analysis-scope.js';
import { VALUE_STATES } from '../../core/constants.js';
import { parseQ, type ProcurementSearchFilter } from '../../core/search.js';

// ── raw input shapes (exactly the SDL) ────────────────────────────────────────

interface StringEqInput {
  eq?: unknown;
}
interface StringInInput {
  in?: unknown;
}
interface StringQInput {
  contains?: unknown;
}
interface RangeInput {
  gte?: unknown;
  lte?: unknown;
}

export interface RawSearchFilter {
  q?: StringQInput;
  authorityCui?: StringEqInput;
  supplierCui?: StringEqInput;
  cpvDivision?: StringEqInput;
  cpvCode?: StringEqInput;
  sourceSystem?: StringInInput;
  status?: StringInInput;
  publicationDate?: RangeInput;
  contractDate?: RangeInput;
  modificationDate?: RangeInput;
  valueRon?: RangeInput;
  valueState?: StringInInput;
  linked?: unknown;
  minDeltaPct?: unknown;
}

/** The analysis scope input, structurally unknown until core validates it. */
export type RawAnalysisScopeInput = Readonly<Record<string, unknown>>;

// ── scalar readers ────────────────────────────────────────────────────────────

const VALUE_STATE_TOKENS: ReadonlySet<string> = new Set(VALUE_STATES);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/u;
const DIVISION_RE = /^\d{2}$/u;
const CPV_CODE_RE = /^\d{2,8}$/u;

const readEq = (
  input: StringEqInput | undefined,
  field: string
): Result<string | undefined, ApiError> => {
  if (input === undefined) return ok(undefined);
  const { eq } = input;
  if (eq === undefined || eq === null) return ok(undefined);
  if (typeof eq !== 'string' || eq.trim() === '') {
    return err(invalidInput(`${field}.eq must be a non-empty string`, field));
  }
  return ok(eq.trim());
};

const readIn = (
  input: StringInInput | undefined,
  field: string
): Result<readonly string[] | undefined, ApiError> => {
  if (input === undefined) return ok(undefined);
  const list = input.in;
  if (list === undefined || list === null) return ok(undefined);
  if (!Array.isArray(list)) return err(invalidInput(`${field}.in must be a list`, field));
  // An EXPLICIT empty list means "match nothing" — it is preserved, not dropped
  // (dropping it would silently widen the query to every row).
  const values: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      return err(invalidInput(`${field}.in must contain non-empty strings`, field));
    }
    values.push(item.trim());
  }
  return ok(values);
};

const readContains = (input: StringQInput | undefined): Result<string | undefined, ApiError> => {
  if (input === undefined) return ok(undefined);
  const { contains } = input;
  if (contains === undefined || contains === null) return ok(undefined);
  if (typeof contains !== 'string') return err(invalidInput('q.contains must be a string', 'q'));
  return parseQ(contains);
};

const readDateRange = (
  input: RangeInput | undefined,
  field: string
): Result<{ gte?: string; lte?: string } | undefined, ApiError> => {
  if (input === undefined) return ok(undefined);
  const out: { gte?: string; lte?: string } = {};
  for (const bound of ['gte', 'lte'] as const) {
    const value = input[bound];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
      return err(invalidInput(`${field}.${bound} must be a YYYY-MM-DD date`, field));
    }
    out[bound] = value;
  }
  if (out.gte !== undefined && out.lte !== undefined && out.gte > out.lte) {
    return err(invalidInput(`${field}.gte must not exceed ${field}.lte`, field));
  }
  return ok(out.gte === undefined && out.lte === undefined ? undefined : out);
};

const readDecimalRange = (
  input: RangeInput | undefined,
  field: string
): Result<{ gte?: string; lte?: string } | undefined, ApiError> => {
  if (input === undefined) return ok(undefined);
  const out: { gte?: string; lte?: string } = {};
  for (const bound of ['gte', 'lte'] as const) {
    const value = input[bound];
    if (value === undefined || value === null) continue;
    // Money stays a STRING all the way to `::numeric` — never through a float.
    if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
      return err(invalidInput(`${field}.${bound} must be a RON decimal string`, field));
    }
    out[bound] = value;
  }
  return ok(out.gte === undefined && out.lte === undefined ? undefined : out);
};

const readCui = (
  input: StringEqInput | undefined,
  field: string
): Result<string | undefined, ApiError> => {
  const raw = readEq(input, field);
  if (raw.isErr()) return err(raw.error);
  if (raw.value === undefined) return ok(undefined);
  const norm = normalizeCui(raw.value);
  if (norm === null) return err(invalidInput(`${field} is not a valid CUI`, field));
  return ok(norm);
};

const readCpv = (
  division: StringEqInput | undefined,
  code: StringEqInput | undefined
): Result<{ cpvDivision?: string; cpvCode?: string }, ApiError> => {
  const divR = readEq(division, 'cpvDivision');
  if (divR.isErr()) return err(divR.error);
  const codeR = readEq(code, 'cpvCode');
  if (codeR.isErr()) return err(codeR.error);
  const out: { cpvDivision?: string; cpvCode?: string } = {};
  if (divR.value !== undefined) {
    if (!DIVISION_RE.test(divR.value)) {
      return err(invalidInput('cpvDivision must be a 2-digit division code', 'cpvDivision'));
    }
    out.cpvDivision = divR.value;
  }
  if (codeR.value !== undefined) {
    if (!CPV_CODE_RE.test(codeR.value)) {
      return err(invalidInput('cpvCode must be a 2–8 digit CPV code', 'cpvCode'));
    }
    out.cpvCode = codeR.value;
  }
  return ok(out);
};

// ── the four search filters ───────────────────────────────────────────────────

/**
 * `dateField` names the input key this grain exposes; the repo binds it to the
 * grain's indexed date column (which for DAs is `finalization_date`, not
 * `publication_date`).
 */
export const translateSearchFilter = (
  raw: RawSearchFilter | undefined | null,
  dateField: 'publicationDate' | 'contractDate' | 'modificationDate'
): Result<ProcurementSearchFilter, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  const out: {
    -readonly [K in keyof ProcurementSearchFilter]: ProcurementSearchFilter[K];
  } = {};

  const q = readContains(raw.q);
  if (q.isErr()) return err(q.error);
  if (q.value !== undefined) out.q = q.value;

  const authority = readCui(raw.authorityCui, 'authorityCui');
  if (authority.isErr()) return err(authority.error);
  if (authority.value !== undefined) out.authorityCui = authority.value;

  const supplier = readCui(raw.supplierCui, 'supplierCui');
  if (supplier.isErr()) return err(supplier.error);
  if (supplier.value !== undefined) out.supplierCui = supplier.value;

  const cpv = readCpv(raw.cpvDivision, raw.cpvCode);
  if (cpv.isErr()) return err(cpv.error);
  if (cpv.value.cpvDivision !== undefined) out.cpvDivision = cpv.value.cpvDivision;
  if (cpv.value.cpvCode !== undefined) out.cpvCode = cpv.value.cpvCode;

  const sourceSystem = readIn(raw.sourceSystem, 'sourceSystem');
  if (sourceSystem.isErr()) return err(sourceSystem.error);
  if (sourceSystem.value !== undefined) out.sourceSystem = sourceSystem.value;

  const status = readIn(raw.status, 'status');
  if (status.isErr()) return err(status.error);
  if (status.value !== undefined) out.status = status.value;

  const dates = readDateRange(raw[dateField], dateField);
  if (dates.isErr()) return err(dates.error);
  if (dates.value !== undefined) out.dateRange = dates.value;

  const value = readDecimalRange(raw.valueRon, 'valueRon');
  if (value.isErr()) return err(value.error);
  if (value.value !== undefined) out.valueRon = value.value;

  const valueState = readIn(raw.valueState, 'valueState');
  if (valueState.isErr()) return err(valueState.error);
  if (valueState.value !== undefined) {
    // Closed set — an unknown token is a caller bug, not an empty result.
    const bad = valueState.value.find((v) => !VALUE_STATE_TOKENS.has(v));
    if (bad !== undefined) return err(invalidInput(`unknown valueState '${bad}'`, 'valueState'));
    out.valueState = valueState.value;
  }

  if (raw.linked !== undefined && raw.linked !== null) {
    if (typeof raw.linked !== 'boolean')
      return err(invalidInput('linked must be a boolean', 'linked'));
    out.linked = raw.linked;
  }
  if (raw.minDeltaPct !== undefined && raw.minDeltaPct !== null) {
    if (typeof raw.minDeltaPct !== 'number' || !Number.isFinite(raw.minDeltaPct)) {
      return err(invalidInput('minDeltaPct must be a finite number', 'minDeltaPct'));
    }
    out.minDeltaPct = raw.minDeltaPct;
  }
  return ok(out);
};

// ── the analysis scope (validation lives in core — one parser for GraphQL + MCP) ─

export const translateAnalysisScope = (
  raw: RawAnalysisScopeInput | undefined | null
): Result<AnalysisScope, ApiError> => parseAnalysisScope(raw);
