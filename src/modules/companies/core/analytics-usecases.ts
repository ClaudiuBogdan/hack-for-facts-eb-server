/**
 * Companies analytics — usecases (GraphQL and MCP call exactly these).
 *
 * Every answer runs the same pipeline:
 *  1. parse every argument's shape (no I/O): release pin, scope, enums, caps;
 *  2. resolve the release ONCE: the active publication, or the pinned one when
 *     it is published, schema-supported and its tables are still retained —
 *     an unavailable pin is a typed `release` error, never a silent switch —
 *     and confirm its privacy epoch is still current (before any engine work);
 *  3. bind the scope to the release (fiscal year, offered metrics);
 *  4. read the engine (keys and numbers), then hydrate labels in batches;
 *  5. confirm the privacy epoch again; only then does the answer leave.
 *
 * Exactness: counts and sums arrive as decimal strings and are combined with
 * BigInt. An empty contributor set has a null sum; an explicit 0 stays "0.00".
 * Release invariants (statuses add up to statements, filers ⊆ population) are
 * checked on every answer and fail fast as a `Database` error.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  invalidInput,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  fitsColumn,
  formatMetricValue,
  meanOf,
  parseCount,
  parseMetricValue,
} from './analytics-decimal.js';
import {
  PRIVACY_EPOCH_RE,
  metricOffered,
  parseRelease,
  parseReleaseNumber,
} from './analytics-release.js';
import { bindScope, canonicalScope, parseScopeShape, scopeHash } from './analytics-scope.js';
import {
  CAEN_BASIS_VALUE,
  COMPANY_ANALYSIS_COHORT_MODES,
  COMPANY_ANALYSIS_DIMENSIONS,
  COMPANY_ANALYSIS_DIRECTIONS,
  COMPANY_ANALYSIS_LIMITS,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_RANKINGS,
  COMPANY_ANALYSIS_RECORD_SORTS,
  COMPANY_ANALYSIS_SIZE_BANDS,
  COMPANY_ANALYSIS_STATUSES,
  COVERAGE_FIELD,
  SIZE_BAND_VALUE,
  STATUS_VALUE,
  isCompanyAnalysisMetric,
  metricKind,
  metricUnit,
  requiresStatement,
  type CompanyAnalysisBreakdown,
  type CompanyAnalysisBucket,
  type CompanyAnalysisBucketKind,
  type CompanyAnalysisCaenValue,
  type CompanyAnalysisCohortMode,
  type CompanyAnalysisCoverage,
  type CompanyAnalysisDimension,
  type CompanyAnalysisDirection,
  type CompanyAnalysisFlagValue,
  type CompanyAnalysisGapReason,
  type CompanyAnalysisMetric,
  type CompanyAnalysisMetricAggregate,
  type CompanyAnalysisRankBy,
  type CompanyAnalysisRecord,
  type CompanyAnalysisRecordSort,
  type CompanyAnalysisRecordValue,
  type CompanyAnalysisRecordsPage,
  type CompanyAnalysisRelease,
  type CompanyAnalysisReleaseInfo,
  type CompanyAnalysisScope,
  type CompanyAnalysisSeries,
  type CompanyAnalysisSeriesPoint,
  type CompanyAnalysisSizeBand,
  type CompanyAnalysisStats,
  type CompanyAnalysisStatus,
} from './analytics-types.js';

import type {
  CaenLabelKey,
  CompanyAnalysisEngine,
  CompanyAnalysisLabelSource,
  CompanyAnalysisReleaseSource,
  DimensionParts,
  MetricAggregateRow,
  RecordRow,
  RecordsAfter,
} from './analytics-ports.js';

export interface CompanyAnalysisDeps {
  readonly releases: CompanyAnalysisReleaseSource;
  readonly engine: CompanyAnalysisEngine;
  readonly labels: CompanyAnalysisLabelSource;
  /** The configured reader database; a release naming another one is refused. */
  readonly database: string;
}

/** null = the analytics reader is not configured on this server. */
export type CompanyAnalysisContext = CompanyAnalysisDeps | null;

const notConfigured = (): ApiError =>
  serviceUnavailable('companies analytics is not configured on this server');

const SNAPSHOT_CAVEAT =
  'Company keys (geography, observed status, ANAF fiscal attributes, main activity) describe the release snapshot, not the fiscal year.';

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing (shared by every shape)
// ─────────────────────────────────────────────────────────────────────────────

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** `release` pin: absent → active; otherwise a positive safe integer (string or number). */
const parsePin = (raw: unknown): Result<number | null, ApiError> => {
  if (isAbsent(raw)) return ok(null);
  const text =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isInteger(raw)
        ? String(raw)
        : '';
  const releaseNumber = parseReleaseNumber(text);
  return releaseNumber === null
    ? err(invalidInput('release must be a positive integer release id', 'release'))
    : ok(releaseNumber);
};

const parseEnum = <T extends string>(
  raw: unknown,
  name: string,
  allowed: readonly T[]
): Result<T | undefined, ApiError> => {
  if (isAbsent(raw)) return ok(undefined);
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? ok(raw as T)
    : err(invalidInput(`${name} must be one of ${allowed.join(', ')}`, name));
};

const parseMetricArg = (
  raw: unknown,
  name: string
): Result<CompanyAnalysisMetric | undefined, ApiError> =>
  parseEnum(raw, name, COMPANY_ANALYSIS_METRICS);

const parseMetricList = (
  raw: unknown,
  name: string
): Result<readonly CompanyAnalysisMetric[] | undefined, ApiError> => {
  if (isAbsent(raw)) return ok(undefined);
  if (!Array.isArray(raw) || raw.length === 0)
    return err(invalidInput(`${name} must be a non-empty list of metrics`, name));
  if (raw.length > COMPANY_ANALYSIS_LIMITS.maxMetrics)
    return err(
      invalidInput(
        `${name} accepts at most ${String(COMPANY_ANALYSIS_LIMITS.maxMetrics)} metrics`,
        name
      )
    );
  if (!raw.every(isCompanyAnalysisMetric))
    return err(
      invalidInput(`${name} values must be one of ${COMPANY_ANALYSIS_METRICS.join(', ')}`, name)
    );
  return ok(COMPANY_ANALYSIS_METRICS.filter((metric) => raw.includes(metric)));
};

const parseInteger = (
  raw: unknown,
  name: string,
  min: number,
  max: number
): Result<number | undefined, ApiError> => {
  if (isAbsent(raw)) return ok(undefined);
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max
    ? ok(raw)
    : err(
        invalidInput(`${name} must be an integer between ${String(min)} and ${String(max)}`, name)
      );
};

// ─────────────────────────────────────────────────────────────────────────────
// Release resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the release the answer reads. Without a pin: the active publication
 * (none → ServiceUnavailable). With a pin: the same release or a typed
 * `release` error; never another release.
 *
 * The privacy guard runs here, before any engine call: the release's captured
 * privacy epoch must equal the CURRENT epoch (see `confirmPrivacy`).
 */
export const resolveRelease = async (
  deps: CompanyAnalysisDeps,
  pin: number | null
): Promise<Result<ResolvedRelease, ApiError>> => {
  const active = await deps.releases.activeRelease();
  if (active.isErr()) return err(active.error);

  if (pin === null) {
    if (active.value === null)
      return err(serviceUnavailable('no companies analytics release is published'));
    const parsed = parseRelease(active.value, deps.database);
    if (parsed.isErr())
      return err(
        serviceUnavailable(
          `the active companies analytics release cannot be served: ${parsed.error}`
        )
      );
    const resolved = { release: parsed.value, pinned: false };
    const privacy = await confirmPrivacy(deps, resolved);
    if (privacy.isErr()) return err(privacy.error);
    const tables = await deps.engine.tablesAvailable(parsed.value.releaseNumber);
    if (tables.isErr()) return err(tables.error);
    if (!tables.value)
      return err(
        serviceUnavailable('the active companies analytics release tables are not available')
      );
    return ok(resolved);
  }

  const pinText = String(pin);
  const row =
    active.value !== null && active.value.releaseId === pinText
      ? ok(active.value)
      : await deps.releases.publishedRelease(pin);
  if (row.isErr()) return err(row.error);
  const refused = (reason: string): ApiError =>
    invalidInput(
      `companies analytics release ${pinText} ${reason}; re-read companyAnalysisRelease and repeat the request`,
      'release'
    );
  if (row.value === null) return err(refused('is not a published release'));
  const parsed = parseRelease(row.value, deps.database);
  if (parsed.isErr()) return err(refused(`cannot be served (${parsed.error})`));
  const resolved = { release: parsed.value, pinned: true };
  const privacy = await confirmPrivacy(deps, resolved);
  if (privacy.isErr()) return err(privacy.error);
  const tables = await deps.engine.tablesAvailable(parsed.value.releaseNumber);
  if (tables.isErr()) return err(tables.error);
  if (!tables.value) return err(refused('is no longer retained'));
  return ok(resolved);
};

// ─────────────────────────────────────────────────────────────────────────────
// Privacy guard
// ─────────────────────────────────────────────────────────────────────────────

/** The release an answer reads, and whether the caller pinned it. */
export interface ResolvedRelease {
  readonly release: CompanyAnalysisRelease;
  readonly pinned: boolean;
}

const privacyUnconfirmed = (): ApiError =>
  serviceUnavailable('companies analytics cannot confirm the current privacy state; retry later');

/**
 * Fail closed unless the CURRENT privacy epoch — one fresh statement on the
 * primary, under READ COMMITTED — equals the epoch the release was captured
 * under. A privacy withdrawal bumps the epoch, so every release built before
 * it stops answering: the active one as SERVICE_UNAVAILABLE, a pin as an
 * INVALID_INPUT `release` error. Rows are never filtered after the fact (that
 * would break totals), and no other release is substituted. Called before any
 * engine work and again just before an answer is returned, so cached release
 * metadata, engine results and labels can never bypass it; the last check is
 * the answer's linearization point.
 */
export const confirmPrivacy = async (
  deps: CompanyAnalysisDeps,
  resolved: ResolvedRelease
): Promise<Result<void, ApiError>> => {
  const reading = await deps.releases.currentPrivacyEpoch();
  // A failed read never forwards driver text: the answer is simply unavailable.
  if (reading.isErr()) return err(privacyUnconfirmed());
  const { epoch, inRecovery, isolation } = reading.value;
  if (inRecovery || isolation !== 'read committed' || !PRIVACY_EPOCH_RE.test(epoch))
    return err(privacyUnconfirmed());
  if (epoch === resolved.release.privacyEpoch) return ok(undefined);
  return err(
    resolved.pinned
      ? invalidInput(
          `companies analytics release ${resolved.release.ref.releaseId} was withdrawn after a privacy change; re-read companyAnalysisRelease and repeat the request`,
          'release'
        )
      : serviceUnavailable(
          'the active companies analytics release was withdrawn after a privacy change; retry once a refreshed release is published'
        )
  );
};

/** The final guard: the answer leaves only if the epoch still matches. */
const finish = async <T>(
  deps: CompanyAnalysisDeps,
  resolved: ResolvedRelease,
  answer: T
): Promise<Result<T, ApiError>> => {
  const privacy = await confirmPrivacy(deps, resolved);
  return privacy.isErr() ? err(privacy.error) : ok(answer);
};

const defaultMetricFor = (
  release: CompanyAnalysisRelease,
  fiscalYear: number
): CompanyAnalysisMetric | null => {
  if (metricOffered(release, fiscalYear, release.defaults.metric)) return release.defaults.metric;
  return (
    COMPANY_ANALYSIS_METRICS.find((metric) => metricOffered(release, fiscalYear, metric)) ?? null
  );
};

const requireOffered = (
  release: CompanyAnalysisRelease,
  fiscalYear: number,
  metrics: readonly CompanyAnalysisMetric[],
  name: string
): Result<void, ApiError> => {
  const missing = metrics.filter((metric) => !metricOffered(release, fiscalYear, metric));
  return missing.length === 0
    ? ok(undefined)
    : err(
        invalidInput(
          `${missing.join(', ')} not offered for fiscal year ${String(fiscalYear)} in release ${release.ref.releaseId}`,
          name
        )
      );
};

// ─────────────────────────────────────────────────────────────────────────────
// Exact accumulation
// ─────────────────────────────────────────────────────────────────────────────

interface MetricAcc {
  sum: bigint | null;
  statuses: Record<CompanyAnalysisStatus, bigint>;
}

const emptyStatuses = (): Record<CompanyAnalysisStatus, bigint> =>
  Object.fromEntries(COMPANY_ANALYSIS_STATUSES.map((status) => [status, 0n])) as Record<
    CompanyAnalysisStatus,
    bigint
  >;

const emptyMetricAcc = (): MetricAcc => ({ sum: null, statuses: emptyStatuses() });

const invariant = (message: string): ApiError =>
  databaseError(`companies analytics release invariant violated: ${message}`);

/**
 * Read one engine aggregate. `statements` is the row count it covers: every
 * statement has exactly one status, values exist iff REPORTED.
 */
const readMetricRow = (
  metric: CompanyAnalysisMetric,
  row: MetricAggregateRow | undefined | null,
  statements: bigint
): Result<MetricAcc, ApiError> => {
  if (row === undefined || row === null) {
    return statements === 0n
      ? ok(emptyMetricAcc())
      : err(invariant(`${metric} aggregate missing for ${statements.toString()} statements`));
  }
  const statuses = emptyStatuses();
  let total = 0n;
  for (const status of COMPANY_ANALYSIS_STATUSES) {
    const count = parseCount(row.statuses[status]);
    if (count === null) return err(invariant(`${metric} ${status} count is not exact`));
    statuses[status] = count;
    total += count;
  }
  if (total !== statements)
    return err(
      invariant(`${metric} statuses (${total.toString()}) ≠ statements (${statements.toString()})`)
    );
  let sum: bigint | null = null;
  if (row.sum !== null) {
    sum = parseMetricValue(row.sum, metricUnit(metric));
    if (sum === null) return err(invariant(`${metric} sum is not an exact value`));
  }
  if ((statuses.REPORTED === 0n) !== (sum === null))
    return err(invariant(`${metric} sum and reported count disagree`));
  return ok({ sum, statuses });
};

const addMetricAcc = (into: MetricAcc, add: MetricAcc): void => {
  if (add.sum !== null) into.sum = (into.sum ?? 0n) + add.sum;
  for (const status of COMPANY_ANALYSIS_STATUSES) into.statuses[status] += add.statuses[status];
};

const toAggregate = (
  metric: CompanyAnalysisMetric,
  acc: MetricAcc
): CompanyAnalysisMetricAggregate => {
  const unit = metricUnit(metric);
  const coverage = Object.fromEntries(
    COMPANY_ANALYSIS_STATUSES.map((status) => [
      COVERAGE_FIELD[status],
      acc.statuses[status].toString(),
    ])
  ) as unknown as CompanyAnalysisCoverage;
  return {
    metric,
    unit,
    kind: metricKind(metric),
    sum: acc.sum === null ? null : formatMetricValue(acc.sum, unit),
    contributors: acc.statuses.REPORTED.toString(),
    mean: meanOf(acc.sum, acc.statuses.REPORTED, unit),
    coverage,
  };
};

const readCount = (raw: string, what: string): Result<bigint, ApiError> => {
  const count = parseCount(raw);
  return count === null ? err(invariant(`${what} is not an exact count`)) : ok(count);
};

const answerBase = (release: CompanyAnalysisRelease, scope: CompanyAnalysisScope) => ({
  release: release.ref,
  scope: canonicalScope(scope),
  scopeHash: scopeHash(scope),
  fiscalYear: scope.fiscalYear,
});

// ─────────────────────────────────────────────────────────────────────────────
// companyAnalysisRelease
// ─────────────────────────────────────────────────────────────────────────────

export const companyAnalysisRelease = async (
  ctx: CompanyAnalysisContext,
  input: { readonly release?: unknown }
): Promise<Result<CompanyAnalysisReleaseInfo, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parsePin(input.release);
  if (pin.isErr()) return err(pin.error);
  const resolved = await resolveRelease(ctx, pin.value);
  if (resolved.isErr()) return err(resolved.error);
  const r = resolved.value.release;
  // The privacy epoch stays internal: it is never part of the answer.
  return finish(ctx, resolved.value, {
    release: r.ref,
    publicationId: r.publicationId,
    schemaVersion: r.schemaVersion,
    populationPolicyVersion: r.populationPolicyVersion,
    admissionPolicyVersion: r.admissionPolicyVersion,
    admissionPolicySha256: r.admissionPolicySha256,
    inputSnapshotAt: r.inputSnapshotAt,
    companies: r.companies,
    companyYears: r.companyYears,
    fiscalYears: r.fiscalYears,
    years: r.years,
    metrics: r.metrics,
    dimensions: r.dimensions,
    defaults: r.defaults,
    asOf: r.asOf,
    nameFilter: r.nameFilter,
    limits: r.limits,
    caveats: r.caveats,
  } satisfies CompanyAnalysisReleaseInfo);
};

// ─────────────────────────────────────────────────────────────────────────────
// companyAnalysisStats
// ─────────────────────────────────────────────────────────────────────────────

export const companyAnalysisStats = async (
  ctx: CompanyAnalysisContext,
  input: { readonly release?: unknown; readonly scope?: unknown; readonly metrics?: unknown }
): Promise<Result<CompanyAnalysisStats, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parsePin(input.release);
  if (pin.isErr()) return err(pin.error);
  const shape = parseScopeShape(input.scope);
  if (shape.isErr()) return err(shape.error);
  const requested = parseMetricList(input.metrics, 'metrics');
  if (requested.isErr()) return err(requested.error);

  const resolved = await resolveRelease(ctx, pin.value);
  if (resolved.isErr()) return err(resolved.error);
  const release = resolved.value.release;
  const scope = bindScope(shape.value, release);
  if (scope.isErr()) return err(scope.error);
  const fallback = defaultMetricFor(release, scope.value.fiscalYear);
  const metrics = requested.value ?? (fallback === null ? [] : [fallback]);
  const offered = requireOffered(release, scope.value.fiscalYear, metrics, 'metrics');
  if (offered.isErr()) return err(offered.error);

  const [population, filerRows] = await Promise.all([
    ctx.engine.countPopulation(release.releaseNumber, scope.value),
    ctx.engine.aggregateFilers(release.releaseNumber, scope.value, metrics),
  ]);
  if (population.isErr()) return err(population.error);
  if (filerRows.isErr()) return err(filerRows.error);
  const companies = readCount(population.value, 'population');
  if (companies.isErr()) return err(companies.error);
  const filers = readCount(filerRows.value.filers, 'filers');
  if (filers.isErr()) return err(filers.error);
  if (filers.value > companies.value) return err(invariant('filers exceed the population'));

  const aggregates: CompanyAnalysisMetricAggregate[] = [];
  for (const metric of metrics) {
    const acc = readMetricRow(metric, filerRows.value.metrics.get(metric), filers.value);
    if (acc.isErr()) return err(acc.error);
    aggregates.push(toAggregate(metric, acc.value));
  }

  return finish(ctx, resolved.value, {
    ...answerBase(release, scope.value),
    companies: companies.value.toString(),
    filers: filers.value.toString(),
    nonFilers: (companies.value - filers.value).toString(),
    metrics: aggregates,
    caveats: [SNAPSHOT_CAVEAT],
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// companyAnalysisBreakdown
// ─────────────────────────────────────────────────────────────────────────────

interface GroupValue {
  /** null = the unknown group. */
  readonly key: string | null;
  readonly caen: Omit<CompanyAnalysisCaenValue, 'label'> | null;
}

const SIZE_BAND_BY_VALUE = new Map<string, CompanyAnalysisSizeBand>(
  COMPANY_ANALYSIS_SIZE_BANDS.map((band) => [SIZE_BAND_VALUE[band], band])
);
const STATUS_BY_VALUE = new Map<string, CompanyAnalysisStatus>(
  COMPANY_ANALYSIS_STATUSES.map((status) => [STATUS_VALUE[status], status])
);

/** `revision:code`, or `?:code` when ANAF published no revision. */
export const caenKey = (revision: string | null, code: string): string =>
  `${revision ?? '?'}:${code}`;

const caenValue = (
  basis: string | null,
  revision: string | null,
  code: string | null
): Result<Omit<CompanyAnalysisCaenValue, 'label'> | null, ApiError> => {
  if (basis === CAEN_BASIS_VALUE.MISSING || code === null) return ok(null);
  if (basis === CAEN_BASIS_VALUE.REVISION_KNOWN && revision !== null)
    return ok({ code, revision, basis: 'REVISION_KNOWN' });
  // Unknown revision stays unknown: never matched to a catalog revision.
  if (basis === CAEN_BASIS_VALUE.REVISION_UNKNOWN)
    return ok({ code, revision: null, basis: 'REVISION_UNKNOWN' });
  return err(invariant(`main CAEN basis ${String(basis)} is inconsistent with its revision`));
};

const groupValue = (
  dimension: CompanyAnalysisDimension,
  parts: DimensionParts
): Result<GroupValue, ApiError> => {
  const first = parts[0] ?? null;
  switch (dimension) {
    case 'MAIN_CAEN': {
      const caen = caenValue(first, parts[1] ?? null, parts[2] ?? null);
      if (caen.isErr()) return err(caen.error);
      return ok(
        caen.value === null
          ? { key: null, caen: null }
          : { key: caenKey(caen.value.revision, caen.value.code), caen: caen.value }
      );
    }
    case 'EMPLOYEE_SIZE': {
      // No statement, or a statement without a reported headcount, has no band.
      if (first === null || first === '' || first === SIZE_BAND_VALUE.UNAVAILABLE)
        return ok({ key: null, caen: null });
      const band = SIZE_BAND_BY_VALUE.get(first);
      return band === undefined
        ? err(invariant(`unknown employee size band ${first}`))
        : ok({ key: band, caen: null });
    }
    case 'VAT_PAYER':
    case 'FISCALLY_INACTIVE':
      if (first !== null && first !== 'YES' && first !== 'NO')
        return err(invariant(`flag value ${first} is not YES/NO`));
      return ok({ key: first, caen: null });
    default:
      return ok({ key: first, caen: null });
  }
};

interface GroupAcc {
  readonly value: GroupValue;
  companies: bigint;
  filers: bigint;
  metric: MetricAcc;
}

const newGroup = (value: GroupValue): GroupAcc => ({
  value,
  companies: 0n,
  filers: 0n,
  metric: emptyMetricAcc(),
});

const addGroup = (into: GroupAcc, add: GroupAcc): void => {
  into.companies += add.companies;
  into.filers += add.filers;
  addMetricAcc(into.metric, add.metric);
};

const rankValue = (group: GroupAcc, rankedBy: CompanyAnalysisRankBy): bigint | null => {
  switch (rankedBy) {
    case 'METRIC_SUM':
      return group.metric.sum;
    case 'FILERS':
      return group.filers;
    case 'CONTRIBUTORS':
      return group.metric.statuses.REPORTED;
    default:
      return group.companies;
  }
};

/** Descending by the ranking value (nulls last), then key ascending: total and stable. */
const compareGroups =
  (rankedBy: CompanyAnalysisRankBy) =>
  (a: GroupAcc, b: GroupAcc): number => {
    const va = rankValue(a, rankedBy);
    const vb = rankValue(b, rankedBy);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return va > vb ? -1 : 1;
    }
    const ka = a.value.key ?? '';
    const kb = b.value.key ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

const bucketOf = (
  kind: CompanyAnalysisBucketKind,
  group: GroupAcc,
  groups: number,
  metric: CompanyAnalysisMetric | null,
  label: string | null
): CompanyAnalysisBucket => ({
  kind,
  key: kind === 'GROUP' ? group.value.key : null,
  label,
  caen: kind === 'GROUP' && group.value.caen !== null ? { ...group.value.caen, label } : null,
  groups,
  companies: group.companies.toString(),
  filers: group.filers.toString(),
  metric: metric === null ? null : toAggregate(metric, group.metric),
});

const groupLabels = async (
  labels: CompanyAnalysisLabelSource,
  dimension: CompanyAnalysisDimension,
  groups: readonly GroupAcc[]
): Promise<Result<ReadonlyMap<string, string>, ApiError>> => {
  const keys = groups.map((g) => g.value.key).filter((key): key is string => key !== null);
  if (keys.length === 0) return ok(new Map());
  switch (dimension) {
    case 'COUNTY':
      return labels.countyLabels(keys);
    case 'UAT':
      return labels.uatLabels(keys);
    case 'OBSERVED_STATUS':
      return labels.statusLabels(keys);
    case 'MAIN_CAEN': {
      const known: CaenLabelKey[] = [];
      for (const g of groups) {
        const caen = g.value.caen;
        if (caen !== null && caen.revision !== null)
          known.push({ revision: caen.revision, code: caen.code });
      }
      return known.length === 0 ? ok(new Map()) : labels.caenLabels(known);
    }
    default:
      return ok(new Map());
  }
};

export const companyAnalysisBreakdown = async (
  ctx: CompanyAnalysisContext,
  input: {
    readonly release?: unknown;
    readonly scope?: unknown;
    readonly dimension?: unknown;
    readonly metric?: unknown;
    readonly rankBy?: unknown;
    readonly topN?: unknown;
  }
): Promise<Result<CompanyAnalysisBreakdown, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parsePin(input.release);
  if (pin.isErr()) return err(pin.error);
  const shape = parseScopeShape(input.scope);
  if (shape.isErr()) return err(shape.error);
  const dimension = parseEnum(input.dimension, 'dimension', COMPANY_ANALYSIS_DIMENSIONS);
  if (dimension.isErr()) return err(dimension.error);
  if (dimension.value === undefined)
    return err(
      invalidInput(`dimension is required (${COMPANY_ANALYSIS_DIMENSIONS.join(', ')})`, 'dimension')
    );
  const requestedMetric = parseMetricArg(input.metric, 'metric');
  if (requestedMetric.isErr()) return err(requestedMetric.error);
  const rankBy = parseEnum(input.rankBy, 'rankBy', COMPANY_ANALYSIS_RANKINGS);
  if (rankBy.isErr()) return err(rankBy.error);
  const topN = parseInteger(input.topN, 'topN', 1, COMPANY_ANALYSIS_LIMITS.maxTopN);
  if (topN.isErr()) return err(topN.error);

  const resolved = await resolveRelease(ctx, pin.value);
  if (resolved.isErr()) return err(resolved.error);
  const release = resolved.value.release;
  const scope = bindScope(shape.value, release);
  if (scope.isErr()) return err(scope.error);
  const metric = requestedMetric.value ?? defaultMetricFor(release, scope.value.fiscalYear);
  if (metric !== null) {
    const offered = requireOffered(release, scope.value.fiscalYear, [metric], 'metric');
    if (offered.isErr()) return err(offered.error);
  }

  const rows = await ctx.engine.breakdown(
    release.releaseNumber,
    scope.value,
    dimension.value,
    metric
  );
  if (rows.isErr()) return err(rows.error);

  const groups = new Map<string, GroupAcc>();
  const unknown = newGroup({ key: null, caen: null });
  const groupFor = (value: GroupValue): GroupAcc => {
    if (value.key === null) return unknown;
    const existing = groups.get(value.key);
    if (existing !== undefined) return existing;
    const created = newGroup(value);
    groups.set(value.key, created);
    return created;
  };
  for (const row of rows.value.population) {
    const value = groupValue(dimension.value, row.parts);
    if (value.isErr()) return err(value.error);
    const companies = readCount(row.companies, 'group companies');
    if (companies.isErr()) return err(companies.error);
    groupFor(value.value).companies += companies.value;
  }
  for (const row of rows.value.filers) {
    const value = groupValue(dimension.value, row.parts);
    if (value.isErr()) return err(value.error);
    const filers = readCount(row.filers, 'group filers');
    if (filers.isErr()) return err(filers.error);
    const group = groupFor(value.value);
    group.filers += filers.value;
    if (metric !== null) {
      const acc = readMetricRow(metric, row.metric, filers.value);
      if (acc.isErr()) return err(acc.error);
      addMetricAcc(group.metric, acc.value);
    }
  }
  for (const group of [...groups.values(), unknown]) {
    if (group.filers > group.companies)
      return err(invariant(`group ${group.value.key ?? 'unknown'} has more filers than companies`));
  }

  const known = [...groups.values()];
  const wantedRank = rankBy.value ?? release.defaults.rankBy;
  const metricRanked = wantedRank === 'METRIC_SUM' || wantedRank === 'CONTRIBUTORS';
  // A metric ranking with no contributing group would order a tie of nulls:
  // the answer would claim a ranking it never made, so it ranks by companies.
  const rankedBy: CompanyAnalysisRankBy =
    metricRanked && (metric === null || !known.some((g) => g.metric.statuses.REPORTED > 0n))
      ? 'COMPANIES'
      : wantedRank;
  known.sort(compareGroups(rankedBy));
  const limit = topN.value ?? release.defaults.topN;
  const top = known.slice(0, limit);
  const rest = known.slice(limit);

  const other = newGroup({ key: null, caen: null });
  for (const group of rest) addGroup(other, group);
  const totals = newGroup({ key: null, caen: null });
  for (const group of [...known, unknown]) addGroup(totals, group);

  const labels = await groupLabels(ctx.labels, dimension.value, top);
  if (labels.isErr()) return err(labels.error);
  const labelOf = (group: GroupAcc): string | null => {
    const value = group.value;
    if (value.key === null) return null;
    if (value.caen !== null)
      return value.caen.revision === null
        ? null
        : (labels.value.get(caenKey(value.caen.revision, value.caen.code)) ?? null);
    return labels.value.get(value.key) ?? null;
  };

  return finish(ctx, resolved.value, {
    ...answerBase(release, scope.value),
    dimension: dimension.value,
    metric,
    rankBy: wantedRank,
    rankedBy,
    topN: limit,
    groupCount: known.length,
    groups: top.map((group) => bucketOf('GROUP', group, 1, metric, labelOf(group))),
    other: bucketOf('OTHER', other, rest.length, metric, null),
    unknown: bucketOf('UNKNOWN', unknown, 1, metric, null),
    totals: bucketOf('TOTAL', totals, known.length + 1, metric, null),
    caveats:
      dimension.value === 'EMPLOYEE_SIZE'
        ? [
            SNAPSHOT_CAVEAT,
            'The unknown size group holds companies without a statement for the year and statements without a reported headcount.',
          ]
        : [SNAPSHOT_CAVEAT],
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// companyAnalysisSeries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a point has no figure, judged on the SCOPE's own statements for that
 * year (not on the release-wide capability): none in scope; every one with
 * the metric not admitted; or statements without a single REPORTED value
 * (missing or held). A point is available iff it has a reported sum — an
 * explicit reported zero is available.
 */
const scopedGap = (filers: bigint, acc: MetricAcc): CompanyAnalysisGapReason | null => {
  if (filers === 0n) return 'NO_STATEMENTS';
  if (acc.statuses.NOT_ADMITTED === filers) return 'NOT_ADMITTED';
  return acc.statuses.REPORTED === 0n ? 'NO_REPORTED_VALUES' : null;
};

export const companyAnalysisSeries = async (
  ctx: CompanyAnalysisContext,
  input: {
    readonly release?: unknown;
    readonly scope?: unknown;
    readonly metric?: unknown;
    readonly cohortMode?: unknown;
    readonly fromYear?: unknown;
    readonly toYear?: unknown;
  }
): Promise<Result<CompanyAnalysisSeries, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parsePin(input.release);
  if (pin.isErr()) return err(pin.error);
  const shape = parseScopeShape(input.scope);
  if (shape.isErr()) return err(shape.error);
  const requestedMetric = parseMetricArg(input.metric, 'metric');
  if (requestedMetric.isErr()) return err(requestedMetric.error);
  const requestedMode = parseEnum(input.cohortMode, 'cohortMode', COMPANY_ANALYSIS_COHORT_MODES);
  if (requestedMode.isErr()) return err(requestedMode.error);
  const from = parseInteger(input.fromYear, 'fromYear', 1990, 2100);
  if (from.isErr()) return err(from.error);
  const to = parseInteger(input.toYear, 'toYear', 1990, 2100);
  if (to.isErr()) return err(to.error);

  const resolved = await resolveRelease(ctx, pin.value);
  if (resolved.isErr()) return err(resolved.error);
  const release = resolved.value.release;
  const scope = bindScope(shape.value, release);
  if (scope.isErr()) return err(scope.error);
  const metric = requestedMetric.value ?? release.defaults.metric;
  const offeredYears = release.metrics.find((m) => m.metric === metric)?.offeredYears ?? [];
  if (offeredYears.length === 0)
    return err(
      invalidInput(`${metric} is not offered in any fiscal year of this release`, 'metric')
    );

  // The evolution of a selected-year question follows the cohort selected in
  // that year by default; an unfiltered question follows every year's filers.
  const mode: CompanyAnalysisCohortMode =
    requestedMode.value ?? (requiresStatement(scope.value) ? 'REFERENCE_YEAR' : 'EACH_YEAR');
  if (mode === 'REFERENCE_YEAR' && scope.value.filing === 'NOT_FILED')
    return err(
      invalidInput(
        'cohortMode REFERENCE_YEAR follows companies that filed in the fiscal year; it cannot follow NOT_FILED',
        'cohortMode'
      )
    );

  const firstYear = release.fiscalYears[0] ?? scope.value.fiscalYear;
  const lastYear = release.fiscalYears.at(-1) ?? scope.value.fiscalYear;
  const fromYear = from.value ?? offeredYears[0] ?? firstYear;
  const toYear = to.value ?? offeredYears.at(-1) ?? lastYear;
  if (fromYear < firstYear || toYear > lastYear || fromYear > toYear)
    return err(
      invalidInput(
        `fromYear/toYear must satisfy ${String(firstYear)} ≤ fromYear ≤ toYear ≤ ${String(lastYear)}`,
        'fromYear'
      )
    );

  const rows = await ctx.engine.series(
    release.releaseNumber,
    scope.value,
    metric,
    fromYear,
    toYear,
    mode
  );
  if (rows.isErr()) return err(rows.error);
  let base: bigint | null = null;
  if (rows.value.base !== null) {
    const parsed = readCount(rows.value.base, 'series base');
    if (parsed.isErr()) return err(parsed.error);
    base = parsed.value;
  }
  if ((mode === 'REFERENCE_YEAR' || !requiresStatement(scope.value)) && base === null)
    return err(invariant('series population base is missing'));

  const points: CompanyAnalysisSeriesPoint[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    const row = rows.value.years.find((y) => y.fiscalYear === year);
    const statements = readCount(row?.statements ?? '0', 'series statements');
    if (statements.isErr()) return err(statements.error);
    const notFiled = mode === 'EACH_YEAR' && scope.value.filing === 'NOT_FILED';
    let acc = emptyMetricAcc();
    if (!notFiled) {
      const read = readMetricRow(metric, row?.metric, statements.value);
      if (read.isErr()) return err(read.error);
      acc = read.value;
    }
    // EACH_YEAR population per year: the company keys' population when the
    // scope needs no statement; the matching filers when it does; the
    // complement of the year's statements for NOT_FILED. Copied company keys
    // are identical to the company grain (contract), so every statement row
    // belongs to exactly one population company.
    let companies: bigint;
    let filers: bigint;
    if (mode === 'REFERENCE_YEAR') {
      companies = base ?? 0n;
      filers = statements.value;
    } else if (notFiled) {
      companies = (base ?? 0n) - statements.value;
      filers = 0n;
    } else if (requiresStatement(scope.value)) {
      companies = statements.value;
      filers = statements.value;
    } else {
      companies = base ?? 0n;
      filers = statements.value;
    }
    if (companies < 0n || filers > companies)
      return err(invariant(`series ${String(year)} filers exceed the population`));

    const gapReason = scopedGap(filers, acc);
    points.push({
      fiscalYear: year,
      available: gapReason === null,
      gapReason,
      companies: companies.toString(),
      filers: filers.toString(),
      metric: toAggregate(metric, acc),
    });
  }

  const caveats = [
    SNAPSHOT_CAVEAT,
    'Each point is a single-year value: never add balance-sheet or headcount points across years.',
    mode === 'REFERENCE_YEAR'
      ? `Every point follows the fixed cohort of companies selected in fiscal year ${String(scope.value.fiscalYear)}.`
      : 'Every point re-applies the selected-year filters, so the reporting population differs between years.',
  ];
  return finish(ctx, resolved.value, {
    ...answerBase(release, scope.value),
    metric,
    unit: metricUnit(metric),
    kind: metricKind(metric),
    cohortMode: mode,
    referenceYear: mode === 'REFERENCE_YEAR' ? scope.value.fiscalYear : null,
    cohortCompanies: mode === 'REFERENCE_YEAR' ? (base ?? 0n).toString() : null,
    fromYear,
    toYear,
    points,
    caveats,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// companyAnalysisRecords
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_CUI_RE = /^[0-9]{1,10}$/u;

const sortToken = (
  sort: CompanyAnalysisRecordSort,
  metric: CompanyAnalysisMetric | null
): string => (sort === 'METRIC' && metric !== null ? `METRIC:${metric}` : 'CUI');

const cursorDir = (direction: CompanyAnalysisDirection): 'asc' | 'desc' =>
  direction === 'ASC' ? 'asc' : 'desc';

/**
 * Decode `after`: it must carry this release, this scope (hash includes the
 * fiscal year), this sort/direction, and a well-formed last `(value, cui)`.
 */
const decodeAfter = (
  raw: unknown,
  release: CompanyAnalysisRelease,
  hash: string,
  sort: CompanyAnalysisRecordSort,
  sortMetric: CompanyAnalysisMetric | null,
  direction: CompanyAnalysisDirection
): Result<RecordsAfter | null, ApiError> => {
  if (isAbsent(raw)) return ok(null);
  if (typeof raw !== 'string' || raw.length > 512)
    return err(invalidInput('malformed cursor; restart pagination', 'after'));
  const decoded = decodeCursor(raw, {
    sort: sortToken(sort, sortMetric),
    dir: cursorDir(direction),
    fhash: hash,
  });
  if (decoded.isErr()) return err(invalidInput(decoded.error.message, 'after'));
  const [releaseId, kind, value, cui] = decoded.value.keys;
  if (decoded.value.keys.length !== 4 || releaseId === undefined || cui === undefined)
    return err(invalidInput('malformed cursor; restart pagination', 'after'));
  if (releaseId !== release.ref.releaseId)
    return err(
      invalidInput(
        `cursor belongs to release ${releaseId}, not ${release.ref.releaseId}; restart pagination`,
        'after'
      )
    );
  if (!CURSOR_CUI_RE.test(cui))
    return err(invalidInput('malformed cursor; restart pagination', 'after'));
  if (sort === 'CUI') {
    return kind === 'c'
      ? ok({ value: null, cui })
      : err(invalidInput('malformed cursor; restart pagination', 'after'));
  }
  if (kind === 'n') return ok({ value: null, cui });
  if (kind !== 'v' || value === undefined || sortMetric === null)
    return err(invalidInput('malformed cursor; restart pagination', 'after'));
  const unit = metricUnit(sortMetric);
  const scaled = parseMetricValue(value, unit);
  return scaled === null || !fitsColumn(scaled, unit)
    ? err(invalidInput('malformed cursor; restart pagination', 'after'))
    : ok({ value: formatMetricValue(scaled, unit), cui });
};

const flagOf = (raw: string | null): Result<CompanyAnalysisFlagValue, ApiError> => {
  if (raw === null) return ok('UNKNOWN');
  if (raw === 'YES' || raw === 'NO') return ok(raw);
  return err(invariant(`flag value ${raw} is not YES/NO`));
};

const mapRecord = (
  row: RecordRow,
  metrics: readonly CompanyAnalysisMetric[],
  labels: {
    readonly names: ReadonlyMap<string, string>;
    readonly counties: ReadonlyMap<string, string>;
    readonly uats: ReadonlyMap<string, string>;
    readonly statuses: ReadonlyMap<string, string>;
    readonly caen: ReadonlyMap<string, string>;
  }
): Result<CompanyAnalysisRecord, ApiError> => {
  const vat = flagOf(row.vatPayer);
  if (vat.isErr()) return err(vat.error);
  const inactive = flagOf(row.fiscallyInactive);
  if (inactive.isErr()) return err(inactive.error);
  const caen = caenValue(row.caenBasis, row.caenRevision, row.caenCode);
  if (caen.isErr()) return err(caen.error);
  let sizeBand: CompanyAnalysisSizeBand | null = null;
  if (row.filed) {
    sizeBand = row.sizeBand === null ? null : (SIZE_BAND_BY_VALUE.get(row.sizeBand) ?? null);
    if (sizeBand === null) return err(invariant(`statement of ${row.cui} has no valid size band`));
  }
  const values: CompanyAnalysisRecordValue[] = [];
  for (const metric of metrics) {
    if (!row.filed) {
      values.push({ metric, value: null, status: null });
      continue;
    }
    const raw = row.values.get(metric);
    const rawStatus = raw?.status ?? null;
    const status = rawStatus === null ? undefined : STATUS_BY_VALUE.get(rawStatus);
    if (raw === undefined || status === undefined)
      return err(invariant(`${metric} status of ${row.cui} is unknown`));
    // A value exists iff the status is REPORTED (contract §2).
    if ((status === 'REPORTED') !== (raw.value !== null))
      return err(invariant(`${metric} value of ${row.cui} disagrees with its status`));
    let value: string | null = null;
    if (raw.value !== null) {
      const scaled = parseMetricValue(raw.value, metricUnit(metric));
      if (scaled === null) return err(invariant(`${metric} value of ${row.cui} is not exact`));
      value = formatMetricValue(scaled, metricUnit(metric));
    }
    values.push({ metric, value, status });
  }
  const registrationYear =
    row.registrationYear === null || !/^\d{4}$/u.test(row.registrationYear)
      ? null
      : Number(row.registrationYear);
  const labelled = (code: string | null, map: ReadonlyMap<string, string>) =>
    code === null ? null : { code, label: map.get(code) ?? null };
  return ok({
    cui: row.cui,
    currentName: labels.names.get(row.cui) ?? null,
    legalForm: row.legalForm,
    county: labelled(row.countyCode, labels.counties),
    uat: labelled(row.uatSiruta, labels.uats),
    observedStatus: labelled(row.statusCode, labels.statuses),
    vatPayer: vat.value,
    fiscallyInactive: inactive.value,
    mainCaen:
      caen.value === null
        ? null
        : {
            ...caen.value,
            label:
              caen.value.revision === null
                ? null
                : (labels.caen.get(caenKey(caen.value.revision, caen.value.code)) ?? null),
          },
    registrationYear,
    filed: row.filed,
    employeeSizeBand: sizeBand,
    values,
  });
};

export const companyAnalysisRecords = async (
  ctx: CompanyAnalysisContext,
  input: {
    readonly release?: unknown;
    readonly scope?: unknown;
    readonly sort?: unknown;
    readonly sortMetric?: unknown;
    readonly direction?: unknown;
    readonly metrics?: unknown;
    readonly first?: unknown;
    readonly after?: unknown;
  }
): Promise<Result<CompanyAnalysisRecordsPage, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parsePin(input.release);
  if (pin.isErr()) return err(pin.error);
  const shape = parseScopeShape(input.scope);
  if (shape.isErr()) return err(shape.error);
  const requestedSort = parseEnum(input.sort, 'sort', COMPANY_ANALYSIS_RECORD_SORTS);
  if (requestedSort.isErr()) return err(requestedSort.error);
  const requestedSortMetric = parseMetricArg(input.sortMetric, 'sortMetric');
  if (requestedSortMetric.isErr()) return err(requestedSortMetric.error);
  const requestedDirection = parseEnum(input.direction, 'direction', COMPANY_ANALYSIS_DIRECTIONS);
  if (requestedDirection.isErr()) return err(requestedDirection.error);
  const requestedMetrics = parseMetricList(input.metrics, 'metrics');
  if (requestedMetrics.isErr()) return err(requestedMetrics.error);
  const first = parseInteger(input.first, 'first', 1, COMPANY_ANALYSIS_LIMITS.maxPageSize);
  if (first.isErr()) return err(first.error);
  if (requestedSort.value === 'CUI' && requestedSortMetric.value !== undefined)
    return err(invalidInput('sortMetric applies only to sort METRIC', 'sortMetric'));

  const resolved = await resolveRelease(ctx, pin.value);
  if (resolved.isErr()) return err(resolved.error);
  const release = resolved.value.release;
  const scope = bindScope(shape.value, release);
  if (scope.isErr()) return err(scope.error);
  const fiscalYear = scope.value.fiscalYear;

  const fallbackMetric = defaultMetricFor(release, fiscalYear);
  const sort: CompanyAnalysisRecordSort =
    requestedSort.value ?? (fallbackMetric === null ? 'CUI' : 'METRIC');
  const sortMetric = sort === 'METRIC' ? (requestedSortMetric.value ?? fallbackMetric) : null;
  if (sort === 'METRIC' && sortMetric === null)
    return err(
      invalidInput(`no metric is offered for fiscal year ${String(fiscalYear)}`, 'sortMetric')
    );
  const direction: CompanyAnalysisDirection =
    requestedDirection.value ?? (sort === 'CUI' ? 'ASC' : 'DESC');
  const display = requestedMetrics.value ?? (sortMetric === null ? [] : [sortMetric]);
  const metrics =
    sortMetric === null || display.includes(sortMetric) ? display : [sortMetric, ...display];
  if (metrics.length > COMPANY_ANALYSIS_LIMITS.maxRecordMetrics)
    return err(
      invalidInput(
        `records carry at most ${String(COMPANY_ANALYSIS_LIMITS.maxRecordMetrics)} metrics (sortMetric included)`,
        'metrics'
      )
    );
  const offered = requireOffered(release, fiscalYear, metrics, 'metrics');
  if (offered.isErr()) return err(offered.error);
  const pageSize = first.value ?? release.defaults.pageSize;

  const hash = scopeHash(scope.value);
  const after = decodeAfter(input.after, release, hash, sort, sortMetric, direction);
  if (after.isErr()) return err(after.error);

  const [rows, total] = await Promise.all([
    ctx.engine.records(release.releaseNumber, scope.value, {
      sort,
      sortMetric,
      direction,
      after: after.value,
      limit: pageSize + 1,
      metrics,
    }),
    ctx.engine.countPopulation(release.releaseNumber, scope.value),
  ]);
  if (rows.isErr()) return err(rows.error);
  if (total.isErr()) return err(total.error);
  const totalCount = readCount(total.value, 'records total');
  if (totalCount.isErr()) return err(totalCount.error);

  const page = rows.value.slice(0, pageSize);
  const unique = (values: readonly (string | null)[]): readonly string[] =>
    [...new Set(values)].filter((v): v is string => v !== null);
  const caenKeys: CaenLabelKey[] = [];
  for (const row of page) {
    if (
      row.caenBasis === CAEN_BASIS_VALUE.REVISION_KNOWN &&
      row.caenRevision !== null &&
      row.caenCode !== null
    )
      caenKeys.push({ revision: row.caenRevision, code: row.caenCode });
  }
  const empty: ReadonlyMap<string, string> = new Map();
  const batch = (
    keys: readonly string[],
    read: (keys: readonly string[]) => Promise<Result<ReadonlyMap<string, string>, ApiError>>
  ): Promise<Result<ReadonlyMap<string, string>, ApiError>> =>
    keys.length === 0 ? Promise.resolve(ok(empty)) : read(keys);
  // One batch per label source per page; the names are CURRENT public names.
  const [names, counties, uats, statuses, caen] = await Promise.all([
    batch(unique(page.map((r) => r.cui)), (keys) => ctx.labels.companyNames(keys)),
    batch(unique(page.map((r) => r.countyCode)), (keys) => ctx.labels.countyLabels(keys)),
    batch(unique(page.map((r) => r.uatSiruta)), (keys) => ctx.labels.uatLabels(keys)),
    batch(unique(page.map((r) => r.statusCode)), (keys) => ctx.labels.statusLabels(keys)),
    caenKeys.length === 0 ? Promise.resolve(ok(empty)) : ctx.labels.caenLabels(caenKeys),
  ]);
  for (const result of [names, counties, uats, statuses, caen]) {
    if (result.isErr()) return err(result.error);
  }
  const labelMaps = {
    names: names.unwrapOr(empty),
    counties: counties.unwrapOr(empty),
    uats: uats.unwrapOr(empty),
    statuses: statuses.unwrapOr(empty),
    caen: caen.unwrapOr(empty),
  };

  const edges: { cursor: string; node: CompanyAnalysisRecord }[] = [];
  for (const row of page) {
    const node = mapRecord(row, metrics, labelMaps);
    if (node.isErr()) return err(node.error);
    const sortValue =
      sortMetric === null
        ? null
        : (node.value.values.find((v) => v.metric === sortMetric)?.value ?? null);
    const kind = sort === 'CUI' ? 'c' : sortValue === null ? 'n' : 'v';
    edges.push({
      node: node.value,
      cursor: buildNextCursor({
        sort: sortToken(sort, sortMetric),
        dir: cursorDir(direction),
        fhash: hash,
        lastKeys: [release.ref.releaseId, kind, sortValue, row.cui],
      }),
    });
  }

  // Names and labels were read above: the final check covers them too.
  return finish(ctx, resolved.value, {
    ...answerBase(release, scope.value),
    sort,
    sortMetric,
    direction,
    totalCount: totalCount.value.toString(),
    edges,
    pageInfo: {
      hasNextPage: rows.value.length > pageSize,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    caveats: [
      SNAPSHOT_CAVEAT,
      'currentName is the current public registry name, not pinned to the release.',
    ],
  });
};
