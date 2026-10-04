/**
 * Companies analytics — scope parsing, shared by GraphQL and MCP.
 *
 * Two pure phases, both before any engine call:
 *  1. `parseScopeShape` — field shapes, closed vocabularies, caps, CUI privacy
 *     (no release needed, so a malformed request costs no I/O);
 *  2. `bindScope` — the release: fiscal year default and existence, financial
 *     range metrics offered in that year.
 *
 * OR within a field, AND across fields. Values are stable keys only; an
 * unknown key matches nothing (labels never enter a filter). The canonical
 * echo is the normalized scope in input shape, and its hash binds cursors.
 *
 * Two different ONRC questions, kept apart:
 *  - `county`, `uat`, `observedStatus` select CONSENSUS BUCKETS: a value key
 *    selects CUIs whose edition consensus is that value; a basis key
 *    `(multiple_values)`, `(partial_observations)`, `(missing)`,
 *    `(unresolved)` (or any other basis) selects CUIs without a consensus
 *    value on that basis — exactly what the breakdown bucket of that key
 *    counts. `includeUnknown` selects every basis bucket.
 *  - `onrc` selects by OBSERVATION on one public resolved identifier (status,
 *    county, broad CAEN, exact `rev<N>:<code>`); its exclusions need complete
 *    evidence (unknown is never read as absent).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  filterHash,
  invalidInput,
  isWithheldOrganizationIdentifier,
  normalizeCui,
  MAX_SERVED_CUI_DIGITS,
  type ApiError,
} from '@/modules/shared/index.js';

import { fitsColumn, formatMetricValue, parseMetricValue } from './analytics-decimal.js';
import { metricOffered, yearCapability } from './analytics-release.js';
import {
  BASIS_BY_BUCKET_KEY,
  COMPANY_ANALYSIS_CAEN_BASES,
  COMPANY_ANALYSIS_FILING,
  COMPANY_ANALYSIS_FLAG_VALUES,
  COMPANY_ANALYSIS_LIMITS,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_ONRC_BASES,
  COMPANY_ANALYSIS_SIZE_BANDS,
  basisBucketKey,
  isCompanyAnalysisMetric,
  metricUnit,
  type CompanyAnalysisCaenBasis,
  type CompanyAnalysisCaenSelector,
  type CompanyAnalysisFiling,
  type CompanyAnalysisFlagValue,
  type CompanyAnalysisKeyFilter,
  type CompanyAnalysisOnrcBasis,
  type CompanyAnalysisOnrcExclude,
  type CompanyAnalysisOnrcFilter,
  type CompanyAnalysisRange,
  type CompanyAnalysisRelease,
  type CompanyAnalysisScope,
  type CompanyAnalysisSizeBand,
} from './analytics-types.js';

/** A scope before the release fills its fiscal year. */
export type CompanyAnalysisScopeShape = Omit<CompanyAnalysisScope, 'fiscalYear'> & {
  readonly fiscalYear?: number;
};

const SCOPE_FIELDS = [
  'fiscalYear',
  'cuis',
  'county',
  'uat',
  'legalForms',
  'observedStatus',
  'vatPayer',
  'fiscallyInactive',
  'mainCaen',
  'mainCaenBasis',
  'filing',
  'financialRanges',
  'employeeSizeBands',
  'onrc',
] as const;

const ONRC_FIELDS = ['status', 'county', 'caenCode', 'onrcCaen', 'exclude'] as const;
const ONRC_EXCLUDE_FIELDS = ['status', 'caenCode', 'county', 'legalForm'] as const;

const COUNTY_RE = /^[A-Za-z0-9]{1,8}$/u;
const SIRUTA_RE = /^[0-9]{1,7}$/u;
const LEGAL_FORM_RE = /^[A-Za-z0-9/._-]{1,16}$/u;
const STATUS_CODE_RE = /^[A-Za-z0-9._-]{1,32}$/u;
const CAEN_CODE_RE = /^[A-Za-z0-9.]{1,12}$/u;
const CAEN_REVISION_RE = /^[A-Za-z0-9._-]{1,16}$/u;
/** The `onrc_identifiers` element domain (source contract §6). */
const ONRC_STATUS_RE = /^[0-9]{1,6}$/u;
const ONRC_CAEN_RE = /^[0-9]{4}$/u;
const ONRC_CAEN_KEY_RE = /^rev[0-3]:[0-9]{4}$/u;

const field = (name: string): string => `scope.${name}`;
const isAbsent = (value: unknown): boolean => value === undefined || value === null;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sortedUnique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const readList = (
  raw: unknown,
  name: string,
  max: number
): Result<readonly unknown[] | undefined, ApiError> => {
  if (isAbsent(raw)) return ok(undefined);
  if (!Array.isArray(raw)) return err(invalidInput(`${field(name)} must be a list`, field(name)));
  if (raw.length === 0)
    return err(invalidInput(`${field(name)} must not be empty (omit it instead)`, field(name)));
  if (raw.length > max)
    return err(invalidInput(`${field(name)} accepts at most ${String(max)} values`, field(name)));
  return ok(raw);
};

const matches =
  (pattern: RegExp) =>
  (value: string): boolean =>
    pattern.test(value);

const readKeys = (
  raw: unknown,
  name: string,
  max: number,
  accepts: (value: string) => boolean
): Result<readonly string[] | undefined, ApiError> => {
  const list = readList(raw, name, max);
  if (list.isErr()) return err(list.error);
  if (list.value === undefined) return ok(undefined);
  const out: string[] = [];
  for (const value of list.value) {
    if (typeof value !== 'string' || !accepts(value))
      return err(invalidInput(`${field(name)} holds an invalid key`, field(name)));
    out.push(value);
  }
  return ok(sortedUnique(out));
};

const readEnums = <T extends string>(
  raw: unknown,
  name: string,
  allowed: readonly T[]
): Result<readonly T[] | undefined, ApiError> => {
  const list = readList(raw, name, allowed.length);
  if (list.isErr()) return err(list.error);
  if (list.value === undefined) return ok(undefined);
  const out: T[] = [];
  for (const value of list.value) {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
      return err(
        invalidInput(`${field(name)} values must be one of ${allowed.join(', ')}`, field(name))
      );
    out.push(value as T);
  }
  // Canonical order is the vocabulary order.
  return ok(allowed.filter((value) => out.includes(value)));
};

const readKeyFilter = (
  raw: unknown,
  name: string,
  max: number,
  pattern: RegExp
): Result<CompanyAnalysisKeyFilter | undefined, ApiError> => {
  if (isAbsent(raw)) return ok(undefined);
  if (!isRecord(raw))
    return err(invalidInput(`${field(name)} must be { in, includeUnknown }`, field(name)));
  const extra = Object.keys(raw).filter((key) => key !== 'in' && key !== 'includeUnknown');
  if (extra.length > 0)
    return err(invalidInput(`${field(name)} has unknown keys: ${extra.join(', ')}`, field(name)));
  // A value key, or a basis bucket key such as `(multiple_values)`.
  const keys = readKeys(
    raw['in'],
    `${name}.in`,
    max,
    (value) => pattern.test(value) || BASIS_BY_BUCKET_KEY.has(value)
  );
  if (keys.isErr()) return err(keys.error);
  const unknown = raw['includeUnknown'];
  if (!isAbsent(unknown) && typeof unknown !== 'boolean')
    return err(invalidInput(`${field(name)}.includeUnknown must be a boolean`, field(name)));
  const includeUnknown = unknown === true;
  if (keys.value === undefined && !includeUnknown)
    return err(
      invalidInput(`${field(name)} needs values in "in" or includeUnknown: true`, field(name))
    );
  const selected = keys.value ?? [];
  const bases = new Set(
    selected.flatMap((key) => {
      const basis = BASIS_BY_BUCKET_KEY.get(key);
      return basis === undefined ? [] : [basis];
    })
  );
  return ok({
    values: selected.filter((key) => !BASIS_BY_BUCKET_KEY.has(key)),
    bases: COMPANY_ANALYSIS_ONRC_BASES.filter((basis: CompanyAnalysisOnrcBasis) =>
      bases.has(basis)
    ),
    includeUnknown,
  });
};

/** A list of ONRC observation keys (`onrc.*`), sorted and de-duplicated. */
const readOnrcKeys = (
  raw: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  max: number,
  pattern: RegExp
): Result<readonly string[] | undefined, ApiError> =>
  readKeys(raw[key], `${path}.${key}`, max, matches(pattern));

const ONRC_LIMITS = {
  status: [COMPANY_ANALYSIS_LIMITS.maxObservedStatuses, ONRC_STATUS_RE],
  county: [COMPANY_ANALYSIS_LIMITS.maxCounties, COUNTY_RE],
  caenCode: [COMPANY_ANALYSIS_LIMITS.maxCaenCodes, ONRC_CAEN_RE],
  onrcCaen: [COMPANY_ANALYSIS_LIMITS.maxCaenCodes, ONRC_CAEN_KEY_RE],
  legalForm: [COMPANY_ANALYSIS_LIMITS.maxLegalForms, LEGAL_FORM_RE],
} as const;

const readOnrcExclude = (
  raw: unknown
): Result<CompanyAnalysisOnrcExclude | undefined, ApiError> => {
  const path = 'onrc.exclude';
  if (isAbsent(raw)) return ok(undefined);
  if (!isRecord(raw)) return err(invalidInput(`${field(path)} must be an object`, field(path)));
  // An exact-revision exclusion cannot be decided from the release: a code of
  // an unknown revision is stored without a key, so its absence is unknown.
  if (!isAbsent(raw['onrcCaen']))
    return err(
      invalidInput(
        `${field(path)}.onrcCaen is not supported: an observation of unknown revision may carry the same code, so its absence is never known (exclude the broad caenCode instead)`,
        field(path)
      )
    );
  const extra = Object.keys(raw).filter(
    (key) => !(ONRC_EXCLUDE_FIELDS as readonly string[]).includes(key)
  );
  if (extra.length > 0)
    return err(invalidInput(`${field(path)} has unknown keys: ${extra.join(', ')}`, field(path)));
  const out: { -readonly [K in keyof CompanyAnalysisOnrcExclude]: CompanyAnalysisOnrcExclude[K] } =
    {};
  for (const key of ONRC_EXCLUDE_FIELDS) {
    const [max, pattern] = ONRC_LIMITS[key];
    const values = readOnrcKeys(raw, key, path, max, pattern);
    if (values.isErr()) return err(values.error);
    if (values.value !== undefined) out[key] = values.value;
  }
  if (Object.keys(out).length === 0)
    return err(invalidInput(`${field(path)} selects nothing (omit it instead)`, field(path)));
  return ok(out);
};

const readOnrc = (raw: unknown): Result<CompanyAnalysisOnrcFilter | undefined, ApiError> => {
  const path = 'onrc';
  if (isAbsent(raw)) return ok(undefined);
  if (!isRecord(raw)) return err(invalidInput(`${field(path)} must be an object`, field(path)));
  const extra = Object.keys(raw).filter((key) => !(ONRC_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0)
    return err(invalidInput(`${field(path)} has unknown keys: ${extra.join(', ')}`, field(path)));
  const out: { -readonly [K in keyof CompanyAnalysisOnrcFilter]: CompanyAnalysisOnrcFilter[K] } =
    {};
  for (const key of ['status', 'county', 'caenCode', 'onrcCaen'] as const) {
    const [max, pattern] = ONRC_LIMITS[key];
    const values = readOnrcKeys(raw, key, path, max, pattern);
    if (values.isErr()) return err(values.error);
    if (values.value !== undefined) out[key] = values.value;
  }
  const exclude = readOnrcExclude(raw['exclude']);
  if (exclude.isErr()) return err(exclude.error);
  if (exclude.value !== undefined) out.exclude = exclude.value;
  if (Object.keys(out).length === 0)
    return err(invalidInput(`${field(path)} selects nothing (omit it instead)`, field(path)));
  return ok(out);
};

const readCuis = (raw: unknown): Result<readonly string[] | undefined, ApiError> => {
  const list = readList(raw, 'cuis', COMPANY_ANALYSIS_LIMITS.maxSelectedCuis);
  if (list.isErr()) return err(list.error);
  if (list.value === undefined) return ok(undefined);
  const out: string[] = [];
  for (const value of list.value) {
    const cui = typeof value === 'string' ? normalizeCui(value) : null;
    if (cui === null)
      return err(invalidInput(`${field('cuis')} holds an invalid CUI`, field('cuis')));
    // Same categorical refusal as every companies surface: a CNP-shaped
    // identifier is never a key, whether or not a row exists.
    if (isWithheldOrganizationIdentifier(cui))
      return err(
        invalidInput(
          `identifiers longer than ${String(MAX_SERVED_CUI_DIGITS)} digits are not served`,
          field('cuis')
        )
      );
    out.push(cui);
  }
  return ok(sortedUnique(out));
};

const readCaen = (
  raw: unknown
): Result<readonly CompanyAnalysisCaenSelector[] | undefined, ApiError> => {
  const list = readList(raw, 'mainCaen', COMPANY_ANALYSIS_LIMITS.maxCaenCodes);
  if (list.isErr()) return err(list.error);
  if (list.value === undefined) return ok(undefined);
  const byKey = new Map<string, CompanyAnalysisCaenSelector>();
  for (const value of list.value) {
    if (!isRecord(value))
      return err(
        invalidInput(`${field('mainCaen')} items must be { code, revision }`, field('mainCaen'))
      );
    const extra = Object.keys(value).filter((key) => key !== 'code' && key !== 'revision');
    if (extra.length > 0)
      return err(
        invalidInput(
          `${field('mainCaen')} items have unknown keys: ${extra.join(', ')}`,
          field('mainCaen')
        )
      );
    const code = value['code'];
    const revision = value['revision'];
    if (typeof code !== 'string' || !CAEN_CODE_RE.test(code))
      return err(invalidInput(`${field('mainCaen')} holds an invalid code`, field('mainCaen')));
    if (!isAbsent(revision) && (typeof revision !== 'string' || !CAEN_REVISION_RE.test(revision)))
      return err(invalidInput(`${field('mainCaen')} holds an invalid revision`, field('mainCaen')));
    const selector = { code, revision: isAbsent(revision) ? null : (revision as string) };
    byKey.set(`${selector.revision ?? '?'}:${code}`, selector);
  }
  return ok([...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, s]) => s));
};

const readRanges = (
  raw: unknown
): Result<readonly CompanyAnalysisRange[] | undefined, ApiError> => {
  const name = 'financialRanges';
  const list = readList(raw, name, COMPANY_ANALYSIS_LIMITS.maxFinancialRanges);
  if (list.isErr()) return err(list.error);
  if (list.value === undefined) return ok(undefined);
  const ranges: CompanyAnalysisRange[] = [];
  for (const value of list.value) {
    if (!isRecord(value))
      return err(invalidInput(`${field(name)} items must be { metric, min, max }`, field(name)));
    const extra = Object.keys(value).filter((key) => !['metric', 'min', 'max'].includes(key));
    if (extra.length > 0)
      return err(
        invalidInput(`${field(name)} items have unknown keys: ${extra.join(', ')}`, field(name))
      );
    const metric = value['metric'];
    if (!isCompanyAnalysisMetric(metric))
      return err(
        invalidInput(
          `${field(name)} metric must be one of ${COMPANY_ANALYSIS_METRICS.join(', ')}`,
          field(name)
        )
      );
    if (ranges.some((r) => r.metric === metric))
      return err(invalidInput(`${field(name)} names ${metric} more than once`, field(name)));
    const unit = metricUnit(metric);
    const bound = (key: 'min' | 'max'): Result<bigint | null, ApiError> => {
      const rawBound = value[key];
      if (isAbsent(rawBound)) return ok(null);
      const scaled = typeof rawBound === 'string' ? parseMetricValue(rawBound, unit) : null;
      if (scaled === null || !fitsColumn(scaled, unit))
        return err(
          invalidInput(
            unit === 'RON'
              ? `${field(name)} ${metric}.${key} must be a decimal string with at most 2 decimals`
              : `${field(name)} ${metric}.${key} must be an integer string`,
            field(name)
          )
        );
      return ok(scaled);
    };
    const min = bound('min');
    if (min.isErr()) return err(min.error);
    const max = bound('max');
    if (max.isErr()) return err(max.error);
    if (min.value === null && max.value === null)
      return err(invalidInput(`${field(name)} ${metric} needs min or max`, field(name)));
    if (min.value !== null && max.value !== null && min.value > max.value)
      return err(invalidInput(`${field(name)} ${metric}.min must not exceed max`, field(name)));
    ranges.push({
      metric,
      min: min.value === null ? null : formatMetricValue(min.value, unit),
      max: max.value === null ? null : formatMetricValue(max.value, unit),
    });
  }
  return ok(
    COMPANY_ANALYSIS_METRICS.flatMap((metric) => ranges.filter((r) => r.metric === metric))
  );
};

/** Phase 1: validate the scope's shape. Absent/null → the whole population. */
export const parseScopeShape = (raw: unknown): Result<CompanyAnalysisScopeShape, ApiError> => {
  if (isAbsent(raw)) return ok({});
  if (!isRecord(raw)) return err(invalidInput('scope must be an object', 'scope'));
  const extra = Object.keys(raw).filter(
    (key) => !(SCOPE_FIELDS as readonly string[]).includes(key)
  );
  if (extra.length > 0)
    return err(invalidInput(`scope has unknown fields: ${extra.join(', ')}`, 'scope'));

  const out: { -readonly [K in keyof CompanyAnalysisScopeShape]: CompanyAnalysisScopeShape[K] } =
    {};

  const year = raw['fiscalYear'];
  if (!isAbsent(year)) {
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 1990 || year > 2100)
      return err(invalidInput('scope.fiscalYear must be an integer year', field('fiscalYear')));
    out.fiscalYear = year;
  }

  const cuis = readCuis(raw['cuis']);
  if (cuis.isErr()) return err(cuis.error);
  if (cuis.value !== undefined) out.cuis = cuis.value;

  const keyFilters = [
    ['county', COMPANY_ANALYSIS_LIMITS.maxCounties, COUNTY_RE],
    ['uat', COMPANY_ANALYSIS_LIMITS.maxUats, SIRUTA_RE],
    ['observedStatus', COMPANY_ANALYSIS_LIMITS.maxObservedStatuses, STATUS_CODE_RE],
  ] as const;
  for (const [name, max, pattern] of keyFilters) {
    const parsed = readKeyFilter(raw[name], name, max, pattern);
    if (parsed.isErr()) return err(parsed.error);
    if (parsed.value !== undefined) out[name] = parsed.value;
  }

  const legalForms = readKeys(
    raw['legalForms'],
    'legalForms',
    COMPANY_ANALYSIS_LIMITS.maxLegalForms,
    matches(LEGAL_FORM_RE)
  );
  if (legalForms.isErr()) return err(legalForms.error);
  if (legalForms.value !== undefined) out.legalForms = legalForms.value;

  for (const name of ['vatPayer', 'fiscallyInactive'] as const) {
    const flags = readEnums<CompanyAnalysisFlagValue>(
      raw[name],
      name,
      COMPANY_ANALYSIS_FLAG_VALUES
    );
    if (flags.isErr()) return err(flags.error);
    if (flags.value !== undefined) out[name] = flags.value;
  }

  const caen = readCaen(raw['mainCaen']);
  if (caen.isErr()) return err(caen.error);
  if (caen.value !== undefined) out.mainCaen = caen.value;

  const bases = readEnums<CompanyAnalysisCaenBasis>(
    raw['mainCaenBasis'],
    'mainCaenBasis',
    COMPANY_ANALYSIS_CAEN_BASES
  );
  if (bases.isErr()) return err(bases.error);
  if (bases.value !== undefined) out.mainCaenBasis = bases.value;

  const filing = raw['filing'];
  if (!isAbsent(filing)) {
    if (
      typeof filing !== 'string' ||
      !(COMPANY_ANALYSIS_FILING as readonly string[]).includes(filing)
    )
      return err(
        invalidInput(
          `scope.filing must be one of ${COMPANY_ANALYSIS_FILING.join(', ')}`,
          field('filing')
        )
      );
    out.filing = filing as CompanyAnalysisFiling;
  }

  const ranges = readRanges(raw['financialRanges']);
  if (ranges.isErr()) return err(ranges.error);
  if (ranges.value !== undefined) out.financialRanges = ranges.value;

  const bands = readEnums<CompanyAnalysisSizeBand>(
    raw['employeeSizeBands'],
    'employeeSizeBands',
    COMPANY_ANALYSIS_SIZE_BANDS
  );
  if (bands.isErr()) return err(bands.error);
  if (bands.value !== undefined) out.employeeSizeBands = bands.value;

  const onrc = readOnrc(raw['onrc']);
  if (onrc.isErr()) return err(onrc.error);
  if (onrc.value !== undefined) out.onrc = onrc.value;

  // A non-filer has no statement, so it can carry no reported value or band.
  if (
    out.filing === 'NOT_FILED' &&
    (out.financialRanges !== undefined || out.employeeSizeBands !== undefined)
  )
    return err(
      invalidInput(
        'scope.filing NOT_FILED cannot be combined with financialRanges or employeeSizeBands (they need a statement)',
        field('filing')
      )
    );

  return ok(out);
};

/** Phase 2: bind to the release — fiscal year default/existence, range metrics offered. */
export const bindScope = (
  shape: CompanyAnalysisScopeShape,
  release: CompanyAnalysisRelease
): Result<CompanyAnalysisScope, ApiError> => {
  const fiscalYear = shape.fiscalYear ?? release.defaults.fiscalYear;
  if (yearCapability(release, fiscalYear) === undefined)
    return err(
      invalidInput(
        `fiscal year ${String(fiscalYear)} is not in release ${release.ref.releaseId} (years ${release.fiscalYears.join(', ')})`,
        field('fiscalYear')
      )
    );
  for (const range of shape.financialRanges ?? []) {
    if (!metricOffered(release, fiscalYear, range.metric))
      return err(
        invalidInput(
          `${range.metric} is not offered for fiscal year ${String(fiscalYear)} in release ${release.ref.releaseId}`,
          field('financialRanges')
        )
      );
  }
  return ok({ ...shape, fiscalYear });
};

const keyFilterEcho = (f: CompanyAnalysisKeyFilter): Record<string, unknown> => {
  const keys = [...f.bases.map(basisBucketKey), ...f.values];
  return {
    ...(keys.length > 0 && { in: keys }),
    ...(f.includeUnknown && { includeUnknown: true }),
  };
};

const onrcEcho = (f: CompanyAnalysisOnrcFilter): Record<string, unknown> => {
  const echo: Record<string, unknown> = {};
  for (const key of ['status', 'county', 'caenCode', 'onrcCaen'] as const) {
    if (f[key] !== undefined) echo[key] = f[key];
  }
  if (f.exclude !== undefined) {
    const exclude: Record<string, unknown> = {};
    for (const key of ONRC_EXCLUDE_FIELDS) {
      if (f.exclude[key] !== undefined) exclude[key] = f.exclude[key];
    }
    echo['exclude'] = exclude;
  }
  return echo;
};

/** The normalized scope in input shape: fixed field order, sorted values, defaults filled. */
export const canonicalScope = (scope: CompanyAnalysisScope): Readonly<Record<string, unknown>> => {
  const echo: Record<string, unknown> = { fiscalYear: scope.fiscalYear };
  if (scope.cuis !== undefined) echo['cuis'] = scope.cuis;
  if (scope.county !== undefined) echo['county'] = keyFilterEcho(scope.county);
  if (scope.uat !== undefined) echo['uat'] = keyFilterEcho(scope.uat);
  if (scope.legalForms !== undefined) echo['legalForms'] = scope.legalForms;
  if (scope.observedStatus !== undefined)
    echo['observedStatus'] = keyFilterEcho(scope.observedStatus);
  if (scope.vatPayer !== undefined) echo['vatPayer'] = scope.vatPayer;
  if (scope.fiscallyInactive !== undefined) echo['fiscallyInactive'] = scope.fiscallyInactive;
  if (scope.mainCaen !== undefined)
    echo['mainCaen'] = scope.mainCaen.map((s) =>
      s.revision === null ? { code: s.code } : { code: s.code, revision: s.revision }
    );
  if (scope.mainCaenBasis !== undefined) echo['mainCaenBasis'] = scope.mainCaenBasis;
  if (scope.filing !== undefined) echo['filing'] = scope.filing;
  if (scope.financialRanges !== undefined)
    echo['financialRanges'] = scope.financialRanges.map((r) => ({
      metric: r.metric,
      ...(r.min !== null && { min: r.min }),
      ...(r.max !== null && { max: r.max }),
    }));
  if (scope.employeeSizeBands !== undefined) echo['employeeSizeBands'] = scope.employeeSizeBands;
  if (scope.onrc !== undefined) echo['onrc'] = onrcEcho(scope.onrc);
  return echo;
};

/** Stable hash of the normalized scope (cache key part and cursor binding). */
export const scopeHash = (scope: CompanyAnalysisScope): string =>
  filterHash(JSON.stringify(canonicalScope(scope)));
