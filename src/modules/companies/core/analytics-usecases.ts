/**
 * Companies analytics — usecases (GraphQL and MCP call exactly these).
 *
 * Every answer runs the same pipeline:
 *  1. parse every argument's shape (no I/O): release pin, scope, enums, caps;
 *  2. resolve the release ONCE: the active publication, or the pinned one when
 *     it is published, schema-supported (v2 with a well-formed ONRC source
 *     pin) and its tables are still retained — an unavailable pin is a typed
 *     `release` error, never a silent switch — and confirm, before any engine
 *     work, that its privacy epoch is still current AND that its pinned ONRC
 *     edition is still the published source;
 *  3. bind the scope to the release (fiscal year, offered metrics);
 *  4. read the engine (keys and numbers), then hydrate labels in batches;
 *  5. confirm epoch and source again; only then does the answer leave. A
 *     GraphQL operation decides each served answer once more when it settled
 *     (`confirmServedAnalysis`, the request's owning-result guard).
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
  isCivilDate,
  metricOffered,
  parseRelease,
  parseReleaseNumber,
  type CompanyAnalysisReleaseRow,
} from './analytics-release.js';
import { bindScope, canonicalScope, parseScopeShape, scopeHash } from './analytics-scope.js';
import {
  BASIS_BY_VALUE,
  COVERAGE_BY_VALUE,
  basisBucketKey,
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
  type CompanyAnalysisOnrcBasis,
  type CompanyAnalysisOnrcCoverage,
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
import { COMPANY_STATUS_NOMENCLATURE } from './filters.js';

import type {
  AnalyticsCurrentState,
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
  'Company keys (ONRC edition consensus with its basis, ANAF fiscal attributes, main activity) describe the release snapshot and its pinned ONRC edition, not the fiscal year.';

/** Label attribution (the vocabulary of the companies resolve hits). */
const LABEL_SOURCE = {
  territory: 'territory_hub',
  nomenclature: 'api_nomenclature',
  catalog: 'current_db_catalog',
} as const;

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
 * The guard runs here, before any engine call: the release's captured
 * privacy epoch and ONRC pin must still be current (see `confirmCurrent`).
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
    const current = await confirmCurrent(deps, resolved);
    if (current.isErr()) return err(current.error);
    const tables = await deps.engine.tablesAvailable(parsed.value.releaseNumber);
    if (tables.isErr()) return err(tables.error);
    if (!tables.value)
      return err(
        serviceUnavailable('the active companies analytics release tables are not available')
      );
    return ok(resolved);
  }

  const pinned = await pinnedRelease(deps, pin, active.value);
  if (pinned.isErr()) return err(pinned.error);
  const resolved = { release: pinned.value, pinned: true };
  const current = await confirmCurrent(deps, resolved);
  if (current.isErr()) return err(current.error);
  const tables = await deps.engine.tablesAvailable(pinned.value.releaseNumber);
  if (tables.isErr()) return err(tables.error);
  if (!tables.value) return err(pinRefused(String(pin), 'is no longer retained'));
  return ok(resolved);
};

const pinRefused = (releaseId: string, reason: string): ApiError =>
  invalidInput(
    `companies analytics release ${releaseId} ${reason}; re-read companyAnalysisRelease and repeat the request`,
    'release'
  );

/** A pinned release: published (active or historical) and parseable, else a `release` error. */
const pinnedRelease = async (
  deps: CompanyAnalysisDeps,
  pin: number,
  active: CompanyAnalysisReleaseRow | null
): Promise<Result<CompanyAnalysisRelease, ApiError>> => {
  const pinText = String(pin);
  const row =
    active !== null && active.releaseId === pinText
      ? ok(active)
      : await deps.releases.publishedRelease(pin);
  if (row.isErr()) return err(row.error);
  if (row.value === null) return err(pinRefused(pinText, 'is not a published release'));
  const parsed = parseRelease(row.value, deps.database);
  return parsed.isErr()
    ? err(pinRefused(pinText, `cannot be served (${parsed.error})`))
    : ok(parsed.value);
};

// ─────────────────────────────────────────────────────────────────────────────
// Privacy and source guard
// ─────────────────────────────────────────────────────────────────────────────

/** The release an answer reads, and whether the caller pinned it. */
export interface ResolvedRelease {
  readonly release: CompanyAnalysisRelease;
  readonly pinned: boolean;
}

const privacyUnconfirmed = (): ApiError =>
  serviceUnavailable('companies analytics cannot confirm the current privacy state; retry later');

/** Why a release no longer answers; null while it still does. */
type Staleness = 'privacy' | 'source' | null;

/**
 * Is the release still current? Its captured privacy epoch must equal the
 * current one, and its pinned ONRC edition must still be the published,
 * listed source with the same epoch, snapshot, date and versions (the
 * eligibility version is sealed per edition and bound through its id). Every
 * ONRC publish, rollback or access withdrawal also moves the privacy epoch;
 * the pin comparison names that case and does not trust it alone.
 */
const staleness = (release: CompanyAnalysisRelease, state: AnalyticsCurrentState): Staleness => {
  if (state.epoch !== release.privacyEpoch) return 'privacy';
  const pin = release.ref.source;
  const onrc = state.onrc;
  const sourceHolds =
    onrc.publicationState === 'published' &&
    onrc.listed &&
    onrc.editionId === pin.editionId &&
    onrc.publicationEpoch === pin.publicationEpoch &&
    onrc.sourceSnapshotId === pin.sourceSnapshotId &&
    onrc.sourcePublishedAt === pin.sourcePublishedAt &&
    onrc.interpretationVersion === pin.interpretationVersion &&
    onrc.dimensionPolicyVersion === pin.dimensionPolicyVersion &&
    onrc.privacyPolicyVersion === pin.privacyPolicyVersion;
  return sourceHolds ? null : 'source';
};

/** One fresh reading, trusted only from the primary under READ COMMITTED. */
const readCurrent = async (
  deps: CompanyAnalysisDeps
): Promise<Result<AnalyticsCurrentState, ApiError>> => {
  const reading = await deps.releases.currentState();
  // A failed read never forwards driver text: the answer is simply unavailable.
  if (reading.isErr()) return err(privacyUnconfirmed());
  const { epoch, inRecovery, isolation } = reading.value;
  if (inRecovery || isolation !== 'read committed' || !PRIVACY_EPOCH_RE.test(epoch))
    return err(privacyUnconfirmed());
  return ok(reading.value);
};

const staleMessage = (releaseId: string, why: Exclude<Staleness, null>): string =>
  why === 'privacy'
    ? `companies analytics release ${releaseId} was withdrawn after a privacy change`
    : `companies analytics release ${releaseId} was exported from an ONRC edition that is no longer the published source`;

/**
 * Fail closed unless the CURRENT state — one fresh statement on the primary,
 * under READ COMMITTED — still holds the release (`staleness`). A privacy
 * withdrawal or an ONRC source event makes every release built before it
 * stop answering: the active one as SERVICE_UNAVAILABLE, a pin as an
 * INVALID_INPUT `release` error. Rows are never filtered after the fact (that
 * would break totals), and no other release is substituted. Called before any
 * engine work and again just before an answer is returned, so cached release
 * metadata, engine results and labels can never bypass it; the last check is
 * the answer's linearization point.
 */
export const confirmCurrent = async (
  deps: CompanyAnalysisDeps,
  resolved: ResolvedRelease
): Promise<Result<void, ApiError>> => {
  const state = await readCurrent(deps);
  if (state.isErr()) return err(state.error);
  const why = staleness(resolved.release, state.value);
  if (why === null) return ok(undefined);
  if (resolved.pinned)
    return err(
      invalidInput(
        `${staleMessage(resolved.release.ref.releaseId, why)}; re-read companyAnalysisRelease and repeat the request`,
        'release'
      )
    );
  return err(
    serviceUnavailable(
      why === 'privacy'
        ? 'the active companies analytics release was withdrawn after a privacy change; retry once a refreshed release is published'
        : 'the active companies analytics release was exported from an ONRC edition that is no longer the published source; retry once a refreshed release is published'
    )
  );
};

/** The final guard: the answer leaves only if epoch and source still hold. */
const finish = async <T>(
  deps: CompanyAnalysisDeps,
  resolved: ResolvedRelease,
  answer: T
): Promise<Result<T, ApiError>> => {
  const current = await confirmCurrent(deps, resolved);
  return current.isErr() ? err(current.error) : ok(answer);
};

/**
 * The transport's final decision for an answer ALREADY computed on release
 * `releaseId` (a GraphQL operation whose sibling roots settled later). No
 * engine or label work: the release row (immutable, cached) and one fresh
 * reading. Any staleness — privacy, source, a release no longer published —
 * is an INVALID_INPUT `release` error, because the answer names a release the
 * caller must re-read; an unconfirmable state stays SERVICE_UNAVAILABLE.
 */
export const confirmServedAnalysis = async (
  ctx: CompanyAnalysisContext,
  releaseId: string
): Promise<Result<void, ApiError>> => {
  if (ctx === null) return err(notConfigured());
  const pin = parseReleaseNumber(releaseId);
  if (pin === null) return err(pinRefused(releaseId, 'is not a release id'));
  const active = await ctx.releases.activeRelease();
  if (active.isErr()) return err(active.error);
  const release = await pinnedRelease(ctx, pin, active.value);
  if (release.isErr()) return err(release.error);
  return confirmCurrent(ctx, { release: release.value, pinned: true });
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
  /** A consensus dimension's basis bucket (no consensus value). */
  readonly basis: CompanyAnalysisOnrcBasis | null;
}

/** The consensus dimensions: one value-or-basis bucket per CUI, never `unknown`. */
const CONSENSUS_DIMENSIONS: ReadonlySet<CompanyAnalysisDimension> = new Set([
  'COUNTY',
  'UAT',
  'OBSERVED_STATUS',
]);

const basisOf = (raw: string | null, what: string): Result<CompanyAnalysisOnrcBasis, ApiError> => {
  const basis = raw === null ? undefined : BASIS_BY_VALUE.get(raw);
  return basis === undefined
    ? err(invariant(`${what} basis ${String(raw)} is not in the edition vocabulary`))
    : ok(basis);
};

const coverageOf = (
  raw: string | null,
  what: string
): Result<CompanyAnalysisOnrcCoverage, ApiError> => {
  const coverage = raw === null ? undefined : COVERAGE_BY_VALUE.get(raw);
  return coverage === undefined
    ? err(invariant(`${what} coverage ${String(raw)} is not in the edition vocabulary`))
    : ok(coverage);
};

/** The value's own bucket, or its basis bucket `(<basis>)` when there is no consensus value. */
const consensusGroup = (
  value: string | null,
  rawBasis: string | null,
  what: string
): Result<GroupValue, ApiError> => {
  const basis = basisOf(rawBasis, what);
  if (basis.isErr()) return err(basis.error);
  return ok(
    value !== null
      ? { key: value, caen: null, basis: null }
      : { key: basisBucketKey(basis.value), caen: null, basis: basis.value }
  );
};

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
    case 'COUNTY':
    case 'UAT':
    case 'OBSERVED_STATUS':
      return consensusGroup(first, parts[1] ?? null, dimension);
    case 'MAIN_CAEN': {
      const caen = caenValue(first, parts[1] ?? null, parts[2] ?? null);
      if (caen.isErr()) return err(caen.error);
      return ok(
        caen.value === null
          ? { key: null, caen: null, basis: null }
          : {
              key: caenKey(caen.value.revision, caen.value.code),
              caen: caen.value,
              basis: null,
            }
      );
    }
    case 'EMPLOYEE_SIZE': {
      // No statement, or a statement without a reported headcount, has no band.
      if (first === null || first === '' || first === SIZE_BAND_VALUE.UNAVAILABLE)
        return ok({ key: null, caen: null, basis: null });
      const band = SIZE_BAND_BY_VALUE.get(first);
      return band === undefined
        ? err(invariant(`unknown employee size band ${first}`))
        : ok({ key: band, caen: null, basis: null });
    }
    case 'VAT_PAYER':
    case 'FISCALLY_INACTIVE':
      if (first !== null && first !== 'YES' && first !== 'NO')
        return err(invariant(`flag value ${first} is not YES/NO`));
      return ok({ key: first, caen: null, basis: null });
    default:
      // LEGAL_FORM: an eligible profile always carries its legal form.
      if (first === null) return err(invariant(`${dimension} value is missing`));
      return ok({ key: first, caen: null, basis: null });
  }
};

interface GroupAcc {
  readonly value: GroupValue;
  companies: bigint;
  filers: bigint;
  metric: MetricAcc;
}

const NO_GROUP: GroupValue = { key: null, caen: null, basis: null };

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

interface BucketLabel {
  readonly label: string | null;
  readonly labelSource: string | null;
}

const NO_LABEL: BucketLabel = { label: null, labelSource: null };

const bucketOf = (
  kind: CompanyAnalysisBucketKind,
  group: GroupAcc,
  groups: number,
  metric: CompanyAnalysisMetric | null,
  { label, labelSource }: BucketLabel
): CompanyAnalysisBucket => ({
  kind,
  key: kind === 'GROUP' ? group.value.key : null,
  label,
  labelSource,
  basis: kind === 'GROUP' ? group.value.basis : null,
  caen: kind === 'GROUP' && group.value.caen !== null ? { ...group.value.caen, label } : null,
  groups,
  companies: group.companies.toString(),
  filers: group.filers.toString(),
  metric: metric === null ? null : toAggregate(metric, group.metric),
});

/** Status labels: the API's static nomenclature only (no source-observed label is read). */
const nomenclatureLabels = (codes: readonly string[]): ReadonlyMap<string, string> =>
  new Map(
    codes.flatMap((code) => {
      const label = COMPANY_STATUS_NOMENCLATURE[code];
      return label === undefined ? [] : [[code, label] as const];
    })
  );

const groupLabels = async (
  labels: CompanyAnalysisLabelSource,
  dimension: CompanyAnalysisDimension,
  groups: readonly GroupAcc[]
): Promise<Result<ReadonlyMap<string, string>, ApiError>> => {
  // Basis buckets carry no label.
  const keys = groups
    .filter((g) => g.value.basis === null)
    .map((g) => g.value.key)
    .filter((key): key is string => key !== null);
  if (keys.length === 0) return ok(new Map());
  switch (dimension) {
    case 'COUNTY':
      return labels.countyLabels(keys);
    case 'UAT':
      return labels.uatLabels(keys);
    case 'OBSERVED_STATUS':
      return ok(nomenclatureLabels(keys));
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
  const unknown = newGroup(NO_GROUP);
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

  // A consensus dimension puts every CUI in a value or basis bucket: its
  // `unknown` bucket stays an empty compatibility slot, never a second count.
  if (CONSENSUS_DIMENSIONS.has(dimension.value) && (unknown.companies > 0n || unknown.filers > 0n))
    return err(invariant(`${dimension.value} has rows without a value or a basis`));

  const other = newGroup(NO_GROUP);
  for (const group of rest) addGroup(other, group);
  const totals = newGroup(NO_GROUP);
  for (const group of [...known, unknown]) addGroup(totals, group);

  const labels = await groupLabels(ctx.labels, dimension.value, top);
  if (labels.isErr()) return err(labels.error);
  const labelSource =
    dimension.value === 'COUNTY' || dimension.value === 'UAT'
      ? LABEL_SOURCE.territory
      : dimension.value === 'OBSERVED_STATUS'
        ? LABEL_SOURCE.nomenclature
        : LABEL_SOURCE.catalog;
  const labelOf = (group: GroupAcc): BucketLabel => {
    const value = group.value;
    if (value.key === null || value.basis !== null) return NO_LABEL;
    const label =
      value.caen !== null
        ? value.caen.revision === null
          ? null
          : (labels.value.get(caenKey(value.caen.revision, value.caen.code)) ?? null)
        : (labels.value.get(value.key) ?? null);
    return label === null ? NO_LABEL : { label, labelSource };
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
    other: bucketOf('OTHER', other, rest.length, metric, NO_LABEL),
    unknown: bucketOf('UNKNOWN', unknown, 1, metric, NO_LABEL),
    totals: bucketOf('TOTAL', totals, known.length + 1, metric, NO_LABEL),
    caveats:
      dimension.value === 'EMPLOYEE_SIZE'
        ? [
            SNAPSHOT_CAVEAT,
            'The unknown size group holds companies without a statement for the year and statements without a reported headcount.',
          ]
        : CONSENSUS_DIMENSIONS.has(dimension.value)
          ? [
              SNAPSHOT_CAVEAT,
              'Every company is in exactly one group: its edition consensus value, or the basis group (multiple_values), (partial_observations), (missing) or (unresolved) when it has none. The unknown bucket is always empty here.',
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

/**
 * `onrc_recorded_date` must be an exact civil date (years 0001–9999) and
 * `onrc_recorded_year` exactly its year: both NULL or both present. Served as
 * text — never a Date, a founding date or an age.
 */
const recordedDateOf = (
  row: RecordRow
): Result<{ readonly date: string | null; readonly year: number | null }, ApiError> => {
  if (row.recordedDate === null && row.recordedYear === null) return ok({ date: null, year: null });
  if (row.recordedDate === null || row.recordedYear === null || !isCivilDate(row.recordedDate))
    return err(invariant(`recorded date of ${row.cui} is not an exact civil date with its year`));
  const year = Number(row.recordedDate.slice(0, 4));
  if (!/^[0-9]{1,4}$/u.test(row.recordedYear) || Number(row.recordedYear) !== year)
    return err(invariant(`recorded year of ${row.cui} does not match its recorded date`));
  return ok({ date: row.recordedDate, year });
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
  const legalFormBasis = basisOf(row.legalFormBasis, `legal form of ${row.cui}`);
  if (legalFormBasis.isErr()) return err(legalFormBasis.error);
  const countyBasis = basisOf(row.countyBasis, `county of ${row.cui}`);
  if (countyBasis.isErr()) return err(countyBasis.error);
  const uatBasis = basisOf(row.uatBasis, `UAT of ${row.cui}`);
  if (uatBasis.isErr()) return err(uatBasis.error);
  const statusBasis = basisOf(row.statusBasis, `status of ${row.cui}`);
  if (statusBasis.isErr()) return err(statusBasis.error);
  const recordedDateBasis = basisOf(row.recordedDateBasis, `recorded date of ${row.cui}`);
  if (recordedDateBasis.isErr()) return err(recordedDateBasis.error);
  const statusCoverage = coverageOf(row.statusCoverage, `status of ${row.cui}`);
  if (statusCoverage.isErr()) return err(statusCoverage.error);
  const caenCoverage = coverageOf(row.caenCoverage, `CAEN of ${row.cui}`);
  if (caenCoverage.isErr()) return err(caenCoverage.error);
  // The exact recorded civil date and the year derived from it alone.
  const recorded = recordedDateOf(row);
  if (recorded.isErr()) return err(recorded.error);
  const labelled = (code: string | null, map: ReadonlyMap<string, string>, source: string) => {
    if (code === null) return null;
    const label = map.get(code) ?? null;
    return { code, label, labelSource: label === null ? null : source };
  };
  return ok({
    cui: row.cui,
    currentName: labels.names.get(row.cui) ?? null,
    legalForm: row.legalForm,
    legalFormBasis: legalFormBasis.value,
    county: labelled(row.countyCode, labels.counties, LABEL_SOURCE.territory),
    countyBasis: countyBasis.value,
    uat: labelled(row.uatSiruta, labels.uats, LABEL_SOURCE.territory),
    uatBasis: uatBasis.value,
    observedStatus: labelled(row.statusCode, labels.statuses, LABEL_SOURCE.nomenclature),
    observedStatusBasis: statusBasis.value,
    observedStatusCoverage: statusCoverage.value,
    onrcCaenCoverage: caenCoverage.value,
    onrcRecordedDate: recorded.value.date,
    onrcRecordedYear: recorded.value.year,
    onrcRecordedDateBasis: recordedDateBasis.value,
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
  // One fresh batch per label source per page; the names are CURRENT public
  // core-directory names. Status labels are the static nomenclature (no read).
  const [names, counties, uats, caen] = await Promise.all([
    batch(unique(page.map((r) => r.cui)), (keys) => ctx.labels.companyNames(keys)),
    batch(unique(page.map((r) => r.countyCode)), (keys) => ctx.labels.countyLabels(keys)),
    batch(unique(page.map((r) => r.uatSiruta)), (keys) => ctx.labels.uatLabels(keys)),
    caenKeys.length === 0 ? Promise.resolve(ok(empty)) : ctx.labels.caenLabels(caenKeys),
  ]);
  for (const result of [names, counties, uats, caen]) {
    if (result.isErr()) return err(result.error);
  }
  const labelMaps = {
    names: names.unwrapOr(empty),
    counties: counties.unwrapOr(empty),
    uats: uats.unwrapOr(empty),
    statuses: nomenclatureLabels(unique(page.map((r) => r.statusCode))),
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
      'currentName is the current public core-directory name: not a registry or edition name, and not pinned to the release.',
      'onrcRecordedDate is the date ONRC recorded, never a founding date or an age.',
    ],
  });
};
