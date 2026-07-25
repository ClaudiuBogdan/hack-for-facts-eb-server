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

import {
  invalidInput,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  type ApiError,
} from '@/modules/shared/index.js';

import { parseAnalysisScope, type AnalysisScope } from '../../core/analysis-scope.js';
import { Q_MODES, RECORD_KINDS, VALUE_STATES } from '../../core/constants.js';
import {
  CPV_LEVELS,
  isQMode,
  parseQ,
  type CpvLevelKey,
  type ProcurementGeoScope,
  type ProcurementSearchFilter,
  type SearchGrain,
} from '../../core/search.js';

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
  /** `ProcurementQMode` enum value — arrives as a plain string. */
  qMode?: unknown;
  authorityCui?: StringEqInput;
  supplierCui?: StringEqInput;
  cpvDivision?: StringEqInput;
  cpvCode?: StringEqInput;
  cpvGroup?: StringEqInput;
  cpvClass?: StringEqInput;
  cpvCategory?: StringEqInput;
  buyerRegion?: StringEqInput;
  buyerCounty?: StringEqInput;
  buyerSiruta?: StringEqInput;
  supplierRegion?: StringEqInput;
  supplierCounty?: StringEqInput;
  supplierSiruta?: StringEqInput;
  sourceSystem?: StringInInput;
  status?: StringInInput;
  publicationDate?: RangeInput;
  contractDate?: RangeInput;
  modificationDate?: RangeInput;
  valueRon?: RangeInput;
  valueState?: StringInInput;
  recordKind?: StringInInput;
  linked?: unknown;
  minDeltaPct?: unknown;
}

/** The analysis scope input, structurally unknown until core validates it. */
export type RawAnalysisScopeInput = Readonly<Record<string, unknown>>;

// ── scalar readers ────────────────────────────────────────────────────────────

const VALUE_STATE_TOKENS: ReadonlySet<string> = new Set(VALUE_STATES);
const RECORD_KIND_TOKENS: ReadonlySet<string> = new Set(RECORD_KINDS);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/u;
const DIVISION_RE = /^\d{2}$/u;
const CPV_CODE_RE = /^\d{2,8}$/u;
/** County codes are the 1–2 letter SIRUTA/plate codes ('B', 'CJ'). */
const COUNTY_CODE_RE = /^[A-Z]{1,2}$/u;
/** SIRUTA territorial codes are numeric, ≤ 8 digits. */
const SIRUTA_RE = /^\d{1,8}$/u;
/** Region labels are the 8 development regions ('Nord-Vest'); bounded, not enumerated. */
const REGION_RE = /^[\p{L}\p{N} .'-]{1,64}$/u;

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

/**
 * A party filter, normalized — and REFUSED when it is a withheld identifier.
 *
 * Over-10-digit identifiers are CNP-shaped natural-person identifiers (kernel
 * P0 containment, 2026-07-22). Without this check the record list answered
 * `supplierCui: <CNP>` with the person's contracts, name and the CNP itself:
 * a personal identification number worked as a lookup key on a public surface.
 * The CONTRACTS stay public — they are public spending — but they are reachable
 * by title, buyer and party name, not by someone's personal number.
 */
const readCui = (
  input: StringEqInput | undefined,
  field: string
): Result<string | undefined, ApiError> => {
  const raw = readEq(input, field);
  if (raw.isErr()) return err(raw.error);
  if (raw.value === undefined) return ok(undefined);
  const norm = normalizeCui(raw.value);
  if (norm === null) return err(invalidInput(`${field} is not a valid CUI`, field));
  if (isWithheldOrganizationIdentifier(norm)) {
    return err(invalidInput(`${field} is not an organization identifier`, field));
  }
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

/**
 * One side's territory scope. Levels are validated against their code shape,
 * never against a live territory list — an unknown-but-well-formed code yields
 * an empty page, which is the honest answer, while a malformed one is a caller
 * bug and fails loudly.
 */
type GeoLevel = readonly [
  input: keyof RawSearchFilter,
  field: keyof ProcurementGeoScope,
  pattern: RegExp,
];

const GEO_LEVELS: Readonly<Record<'buyer' | 'supplier', readonly GeoLevel[]>> = {
  buyer: [
    ['buyerRegion', 'region', REGION_RE],
    ['buyerCounty', 'countyCode', COUNTY_CODE_RE],
    ['buyerSiruta', 'siruta', SIRUTA_RE],
  ],
  supplier: [
    ['supplierRegion', 'region', REGION_RE],
    ['supplierCounty', 'countyCode', COUNTY_CODE_RE],
    ['supplierSiruta', 'siruta', SIRUTA_RE],
  ],
};

const readGeoScope = (
  raw: RawSearchFilter,
  side: 'buyer' | 'supplier'
): Result<ProcurementGeoScope | undefined, ApiError> => {
  const out: { -readonly [K in keyof ProcurementGeoScope]: ProcurementGeoScope[K] } = {};
  for (const [input, field, pattern] of GEO_LEVELS[side]) {
    const value = readEq(raw[input] as StringEqInput | undefined, input);
    if (value.isErr()) return err(value.error);
    if (value.value === undefined) continue;
    if (!pattern.test(value.value)) {
      return err(invalidInput(`${input} is not a valid territory code`, input));
    }
    out[field] = value.value;
  }
  return ok(Object.keys(out).length === 0 ? undefined : out);
};

/** CPV level scopes: canonical 8-digit codes with a non-zero level digit. */
const readCpvLevels = (
  raw: RawSearchFilter
): Result<Partial<Record<CpvLevelKey, string>>, ApiError> => {
  const out: Partial<Record<CpvLevelKey, string>> = {};
  for (const key of ['cpvGroup', 'cpvClass', 'cpvCategory'] as const) {
    const value = readEq(raw[key], key);
    if (value.isErr()) return err(value.error);
    if (value.value === undefined) continue;
    if (!CPV_LEVELS[key].pattern.test(value.value)) {
      return err(
        invalidInput(
          `${key} must be a canonical 8-digit CPV code for that level (trailing zeros, non-zero level digit)`,
          key
        )
      );
    }
    out[key] = value.value;
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
  dateField: 'publicationDate' | 'contractDate' | 'modificationDate',
  /**
   * The grain this filter is for. Omitted = no grain-capability check (the
   * shape-only translation used by tests); the resolvers always pass it.
   */
  grain?: SearchGrain
): Result<ProcurementSearchFilter, ApiError> => {
  if (raw === undefined || raw === null) return ok({});
  const out: {
    -readonly [K in keyof ProcurementSearchFilter]: ProcurementSearchFilter[K];
  } = {};

  const q = readContains(raw.q);
  if (q.isErr()) return err(q.error);
  if (q.value !== undefined) out.q = q.value;

  if (raw.qMode !== undefined && raw.qMode !== null) {
    if (!isQMode(raw.qMode)) {
      return err(invalidInput(`qMode must be one of ${Q_MODES.join(', ')}`, 'qMode'));
    }
    // The SQL-only grain has one `ILIKE '%q%'`: it cannot mean "all words",
    // "any word" or "this phrase". Rejected rather than silently ignored.
    if (grain === 'modifications') {
      return err(invalidInput('qMode is not available on the modifications grain', 'qMode'));
    }
    if (q.value === undefined) {
      return err(invalidInput('qMode requires a q filter to apply to', 'qMode'));
    }
    out.qMode = raw.qMode;
  }

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

  const levels = readCpvLevels(raw);
  if (levels.isErr()) return err(levels.error);
  if (
    grain === 'modifications' &&
    (levels.value.cpvGroup !== undefined ||
      levels.value.cpvClass !== undefined ||
      levels.value.cpvCategory !== undefined)
  ) {
    // Contract modifications carry no CPV column at all, so this filter has
    // nothing to bind to. Rejected, never ignored — an ignored predicate
    // answers a WIDER question than the one asked. (On the other grains the
    // levels are a `cpv_code` range, served with or without the index.)
    return err(invalidInput('CPV levels are not available on the modifications grain', 'cpvGroup'));
  }
  if (levels.value.cpvGroup !== undefined) out.cpvGroup = levels.value.cpvGroup;
  if (levels.value.cpvClass !== undefined) out.cpvClass = levels.value.cpvClass;
  if (levels.value.cpvCategory !== undefined) out.cpvCategory = levels.value.cpvCategory;

  const buyerGeo = readGeoScope(raw, 'buyer');
  if (buyerGeo.isErr()) return err(buyerGeo.error);
  // Every grain can answer buyer territory: three read their own fact row, and
  // modifications read the parent contract's on the same key.
  if (buyerGeo.value !== undefined) out.buyerGeo = buyerGeo.value;

  const supplierGeo = readGeoScope(raw, 'supplier');
  if (supplierGeo.isErr()) return err(supplierGeo.error);
  if (supplierGeo.value !== undefined) {
    // A procedure predates its award: it has no supplier, so a supplier
    // territory scope is REJECTED here rather than quietly ignored (which
    // would answer a wider question than the one asked).
    if (grain === 'procedures' || grain === 'modifications') {
      return err(
        invalidInput(`supplier geography is not available on the ${grain} grain`, 'supplierRegion')
      );
    }
    out.supplierGeo = supplierGeo.value;
  }

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

  const recordKind = readIn(raw.recordKind, 'recordKind');
  if (recordKind.isErr()) return err(recordKind.error);
  if (recordKind.value !== undefined) {
    const bad = recordKind.value.find((v) => !RECORD_KIND_TOKENS.has(v));
    if (bad !== undefined) return err(invalidInput(`unknown recordKind '${bad}'`, 'recordKind'));
    out.recordKind = recordKind.value;
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
