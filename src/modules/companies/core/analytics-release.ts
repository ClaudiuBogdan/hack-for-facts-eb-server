/**
 * Companies analytics — release metadata → validated release + capabilities.
 *
 * Pure. The repo hands over the PostgreSQL row (`active_release`, or a
 * published historical release); this module refuses anything the reader does
 * not support (schema or population version, the ONRC source pin, database,
 * table names, malformed coverage) and derives what the release can answer:
 * fiscal years, the metric-specific years on offer, dimensions and defaults.
 * A refusal is a reason string; the caller decides whether it is
 * "unavailable" (the active release) or "invalid pin".
 *
 * Only `companies-analytics-ch-v2` / `public-onrc-edition-legal-person-v2`
 * is served: a v1 release (registration/territory derived dimensions) is
 * refused outright, never reinterpreted under the v2 columns. Its ONRC pin
 * (`inputs.onrc`) must have exactly the frozen eight-key shape and the
 * supported versions; it is never filled from the live pointer.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  COMPANY_ANALYSIS_DIMENSIONS,
  COMPANY_ANALYSIS_LIMITS,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_POPULATION_POLICY_VERSION,
  COMPANY_ANALYSIS_SCHEMA_VERSION,
  COMPANY_ANALYSIS_SIZE_BANDS,
  COMPANY_ANALYSIS_SOURCE_VERSIONS,
  COMPANY_ANALYSIS_STATUSES,
  COVERAGE_FIELD,
  DEFAULT_METRIC,
  METRIC_COLUMN,
  PREFERRED_DEFAULT_YEAR,
  SIZE_BAND_VALUE,
  STATUS_VALUE,
  metricKind,
  metricUnit,
  type CompanyAnalysisCoverage,
  type CompanyAnalysisDimension,
  type CompanyAnalysisDimensionCapability,
  type CompanyAnalysisFrontierEntry,
  type CompanyAnalysisMetric,
  type CompanyAnalysisRelease,
  type CompanyAnalysisSizeBandCount,
  type CompanyAnalysisSource,
  type CompanyAnalysisYearCapability,
  type CompanyAnalysisYearMetric,
} from './analytics-types.js';

/** The release row as PostgreSQL returns it (text for every bigint). */
export interface CompanyAnalysisReleaseRow {
  readonly releaseId: string;
  readonly publicationId: string | null;
  readonly publishedAt: string | null;
  readonly active: boolean;
  readonly schemaVersion: string;
  readonly populationPolicyVersion: string;
  readonly admissionPolicyVersion: string | null;
  readonly admissionPolicySha256: string | null;
  readonly clickhouseDatabase: string;
  readonly companyTable: string;
  readonly companyYearTable: string;
  readonly inputSnapshotAt: string | null;
  readonly companies: string | null;
  readonly companyYears: string | null;
  /**
   * The `companies_analytics.privacy_state` epoch captured by the export
   * (manifest `privacyEpoch`). Internal: compared with the current epoch on
   * every answer, never served.
   */
  readonly privacyEpoch: string | null;
  readonly coverage: unknown;
  readonly inputs: unknown;
}

const RELEASE_ID_RE = /^[1-9][0-9]{0,15}$/u;

/** A canonical non-negative bigint (`privacy_state.epoch`) as text. */
export const PRIVACY_EPOCH_RE = /^(0|[1-9][0-9]{0,18})$/u;

/** A release id as text → a positive safe integer, or null. */
export const parseReleaseNumber = (raw: string): number | null => {
  if (!RELEASE_ID_RE.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
};

export const companyTableName = (releaseNumber: number): string =>
  `company_r${String(releaseNumber)}`;
export const companyYearTableName = (releaseNumber: number): string =>
  `company_year_r${String(releaseNumber)}`;

// ── manifest shapes (never trusted raw) ──────────────────────────────────────

const CountSchema = Type.Union([
  Type.Integer({ minimum: 0 }),
  Type.String({ pattern: '^[0-9]+$' }),
]);
const YearCoverageSchema = Type.Object({
  rows: CountSchema,
  metrics: Type.Record(Type.String(), Type.Record(Type.String(), CountSchema)),
  sizeBands: Type.Record(Type.String(), CountSchema),
});
const CoverageSchema = Type.Record(Type.String(), YearCoverageSchema);
const FrontierSchema = Type.Array(
  Type.Object({
    kind: Type.String(),
    id: Type.Union([Type.String(), Type.Null()]),
    published: Type.Union([Type.String(), Type.Null()]),
    retrieved: Type.Union([Type.String(), Type.Null()]),
    rows: Type.Union([Type.String(), Type.Null()]),
  })
);
const InputsSchema = Type.Object({ frontier: Type.Unknown() });

// ── the ONRC source pin (`inputs.onrc`, frozen source contract §1) ───────────

const SOURCE_PIN_KEYS = [
  'dimensionPolicyVersion',
  'editionId',
  'eligibilityPolicyVersion',
  'interpretationVersion',
  'privacyPolicyVersion',
  'publicationEpoch',
  'sourcePublishedAt',
  'sourceSnapshotId',
] as const;

/** Canonical positive bigint text: no sign, no leading zero, ≤ 19 digits. */
const PIN_ID_RE = /^[1-9][0-9]{0,18}$/u;
const PG_BIGINT_MAX = 9223372036854775807n;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

const isPinId = (value: unknown): value is string =>
  typeof value === 'string' && PIN_ID_RE.test(value) && BigInt(value) <= PG_BIGINT_MAX;

const isPinText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !CONTROL_RE.test(value);

/** An exact calendar date `YYYY-MM-DD` in years 0001–9999 (the source's civil-date domain). */
export const isCivilDate = (value: string): boolean => {
  const match = ISO_DATE_RE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days;
};

/**
 * The release's source pin: exactly the eight keys, canonical id and epoch,
 * non-empty control-free text, a calendar date or null — else a reason. Then
 * every version must be the supported one. Never completed from elsewhere.
 */
export const parseSourcePin = (raw: unknown): Result<CompanyAnalysisSource, string> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return err('release source pin (inputs.onrc) is missing or not an object');
  const record = raw as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (keys.length !== SOURCE_PIN_KEYS.length || keys.some((key, i) => key !== SOURCE_PIN_KEYS[i]))
    return err('release source pin (inputs.onrc) does not have exactly the eight pin keys');
  const date = record['sourcePublishedAt'];
  const text = (key: string): string | null => {
    const value = record[key];
    return isPinText(value) ? value : null;
  };
  const pin = {
    editionId: isPinId(record['editionId']) ? record['editionId'] : null,
    publicationEpoch: isPinId(record['publicationEpoch']) ? record['publicationEpoch'] : null,
    sourceSnapshotId: text('sourceSnapshotId'),
    interpretationVersion: text('interpretationVersion'),
    privacyPolicyVersion: text('privacyPolicyVersion'),
    dimensionPolicyVersion: text('dimensionPolicyVersion'),
    eligibilityPolicyVersion: text('eligibilityPolicyVersion'),
  };
  if (
    pin.editionId === null ||
    pin.publicationEpoch === null ||
    pin.sourceSnapshotId === null ||
    pin.interpretationVersion === null ||
    pin.privacyPolicyVersion === null ||
    pin.dimensionPolicyVersion === null ||
    pin.eligibilityPolicyVersion === null ||
    !(date === null || (typeof date === 'string' && isCivilDate(date)))
  )
    return err('release source pin (inputs.onrc) is malformed');
  const source: CompanyAnalysisSource = {
    editionId: pin.editionId,
    publicationEpoch: pin.publicationEpoch,
    sourceSnapshotId: pin.sourceSnapshotId,
    sourcePublishedAt: date,
    interpretationVersion: pin.interpretationVersion,
    privacyPolicyVersion: pin.privacyPolicyVersion,
    dimensionPolicyVersion: pin.dimensionPolicyVersion,
    eligibilityPolicyVersion: pin.eligibilityPolicyVersion,
  };
  const unsupported = (
    Object.keys(
      COMPANY_ANALYSIS_SOURCE_VERSIONS
    ) as (keyof typeof COMPANY_ANALYSIS_SOURCE_VERSIONS)[]
  ).filter((key) => source[key] !== COMPANY_ANALYSIS_SOURCE_VERSIONS[key]);
  return unsupported.length === 0
    ? ok(source)
    : err(`release source pin has unsupported ${unsupported.join(', ')}`);
};

const countText = (value: Static<typeof CountSchema>): string | null => {
  if (typeof value === 'string') return value.replace(/^0+(?=\d)/u, '');
  return Number.isSafeInteger(value) ? String(value) : null;
};

const YEAR_RE = /^(19|20)\d{2}$/u;
const COUNT_TEXT_RE = /^[0-9]+$/u;

export const RELEASE_CAVEATS: readonly string[] = [
  'County, UAT, observed status and legal form are the consensus of ONE published ONRC edition (see release.source), with an explicit basis when there is none; ANAF fiscal attributes describe the release snapshot. None of them is fiscal-year history.',
  'Observed status is the complete status consensus of that edition; a public 1048 observation does not by itself mean "currently active", and the observation filter (scope.onrc) is a different question from the consensus bucket.',
  'onrcRecordedDate is the date ONRC recorded, never a founding date or an age.',
  'Coverage counts observed filings; a recent year with fewer statements is partial, never labelled complete.',
  'Employee figures are sums of reported average headcounts, not unique people; balances and headcounts are single-year values.',
  'Company names are current public core-directory names, not registry or edition names, and not pinned to the release.',
  'ANAF main activity codes keep their published revision; an unknown revision is shown as unknown, never mapped to a catalog.',
];

const DIMENSION_LABEL_SOURCE: Readonly<Record<CompanyAnalysisDimension, string>> = {
  COUNTY:
    'territory_hub: current public core.territories county name by county_code; basis buckets have no label',
  UAT: 'territory_hub: current public core.territories name by SIRUTA; basis buckets have no label',
  MAIN_CAEN:
    'current_db_catalog: core.classification_codes (caen_<revision>, code) when the ANAF revision is known',
  LEGAL_FORM: 'none: the ONRC legal-form code is shown',
  OBSERVED_STATUS:
    'api_nomenclature: the API status nomenclature by code (never a source-observed label); basis buckets have no label',
  VAT_PAYER: 'none: YES / NO / UNKNOWN',
  FISCALLY_INACTIVE: 'none: YES / NO / UNKNOWN',
  EMPLOYEE_SIZE: 'none: EU headcount band',
};

const DIMENSIONS: readonly CompanyAnalysisDimensionCapability[] = COMPANY_ANALYSIS_DIMENSIONS.map(
  (dimension) => ({
    dimension,
    yearScoped: dimension === 'EMPLOYEE_SIZE',
    labelSource: DIMENSION_LABEL_SOURCE[dimension],
  })
);

const parseYear = (
  fiscalYear: number,
  raw: Static<typeof YearCoverageSchema>
): Result<CompanyAnalysisYearCapability, string> => {
  const rows = countText(raw.rows);
  if (rows === null) return err(`coverage ${String(fiscalYear)}: rows is not an exact count`);
  const metrics: CompanyAnalysisYearMetric[] = [];
  for (const metric of COMPANY_ANALYSIS_METRICS) {
    const statuses = raw.metrics[METRIC_COLUMN[metric]];
    if (statuses === undefined)
      return err(`coverage ${String(fiscalYear)}: metric ${METRIC_COLUMN[metric]} is missing`);
    const coverage: Record<string, string> = {};
    let total = 0n;
    for (const status of COMPANY_ANALYSIS_STATUSES) {
      const value = statuses[STATUS_VALUE[status]];
      const text = value === undefined ? null : countText(value);
      if (text === null)
        return err(
          `coverage ${String(fiscalYear)}: ${METRIC_COLUMN[metric]}.${STATUS_VALUE[status]} is missing`
        );
      coverage[COVERAGE_FIELD[status]] = text;
      total += BigInt(text);
    }
    // Every statement carries exactly one status per metric.
    if (total !== BigInt(rows))
      return err(
        `coverage ${String(fiscalYear)}: ${METRIC_COLUMN[metric]} statuses do not add up to the statements`
      );
    const typed = coverage as unknown as CompanyAnalysisCoverage;
    const admitted = BigInt(rows) - BigInt(typed.notAdmitted) > 0n;
    metrics.push({ metric, offered: admitted && BigInt(typed.reported) > 0n, coverage: typed });
  }
  const sizeBands: CompanyAnalysisSizeBandCount[] = [];
  for (const band of COMPANY_ANALYSIS_SIZE_BANDS) {
    const value = raw.sizeBands[SIZE_BAND_VALUE[band]];
    const text = value === undefined ? '0' : countText(value);
    if (text === null)
      return err(`coverage ${String(fiscalYear)}: size band ${band} is not a count`);
    sizeBands.push({ band, statements: text });
  }
  return ok({ fiscalYear, statements: rows, metrics, sizeBands });
};

const parseFrontier = (inputs: unknown): readonly CompanyAnalysisFrontierEntry[] | null => {
  if (!Value.Check(InputsSchema, inputs)) return null;
  const frontier = inputs.frontier;
  if (!Value.Check(FrontierSchema, frontier)) return null;
  return frontier.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    published: entry.published,
    retrieved: entry.retrieved,
    rows: entry.rows,
  }));
};

const isOffered = (
  years: readonly CompanyAnalysisYearCapability[],
  fiscalYear: number,
  metric: CompanyAnalysisMetric
): boolean =>
  years.find((y) => y.fiscalYear === fiscalYear)?.metrics.find((m) => m.metric === metric)
    ?.offered === true;

/**
 * Validate a release row. `expectedDatabase` is the configured reader database;
 * the row must name the same one and the canonical table names of its id.
 */
export const parseRelease = (
  row: CompanyAnalysisReleaseRow,
  expectedDatabase: string
): Result<CompanyAnalysisRelease, string> => {
  const releaseNumber = parseReleaseNumber(row.releaseId);
  if (releaseNumber === null) return err('release id is not a positive safe integer');
  if (row.schemaVersion !== COMPANY_ANALYSIS_SCHEMA_VERSION)
    return err(
      `release schema ${row.schemaVersion} is not supported by this reader (it serves ${COMPANY_ANALYSIS_SCHEMA_VERSION} only)`
    );
  if (row.populationPolicyVersion !== COMPANY_ANALYSIS_POPULATION_POLICY_VERSION)
    return err(
      `release population ${row.populationPolicyVersion} is not supported by this reader (it serves ${COMPANY_ANALYSIS_POPULATION_POLICY_VERSION} only)`
    );
  const inputs = row.inputs;
  const source = parseSourcePin(
    typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs)
      ? (inputs as Readonly<Record<string, unknown>>)['onrc']
      : undefined
  );
  if (source.isErr()) return err(source.error);
  if (row.clickhouseDatabase !== expectedDatabase)
    return err('release names a different analytics database');
  if (
    row.companyTable !== companyTableName(releaseNumber) ||
    row.companyYearTable !== companyYearTableName(releaseNumber)
  )
    return err('release table names do not match its id');
  if (row.companies === null || !COUNT_TEXT_RE.test(row.companies))
    return err('release company count is missing');
  if (row.companyYears === null || !COUNT_TEXT_RE.test(row.companyYears))
    return err('release company-year count is missing');
  // A release without a captured privacy epoch cannot be guarded: never served.
  if (row.privacyEpoch === null || !PRIVACY_EPOCH_RE.test(row.privacyEpoch))
    return err('release has no valid privacy epoch');
  if (!Value.Check(CoverageSchema, row.coverage)) return err('release coverage is malformed');

  const years: CompanyAnalysisYearCapability[] = [];
  for (const [key, raw] of Object.entries(row.coverage)) {
    if (!YEAR_RE.test(key)) return err(`release coverage has a non-year key ${key}`);
    const parsed = parseYear(Number(key), raw);
    if (parsed.isErr()) return err(parsed.error);
    if (BigInt(parsed.value.statements) > 0n) years.push(parsed.value);
  }
  years.sort((a, b) => a.fiscalYear - b.fiscalYear);
  if (years.length === 0) return err('release coverage holds no fiscal year');
  const statementTotal = years.reduce((sum, y) => sum + BigInt(y.statements), 0n);
  if (statementTotal !== BigInt(row.companyYears))
    return err('release coverage does not add up to its company-years');

  const fiscalYears = years.map((y) => y.fiscalYear);
  const metrics = COMPANY_ANALYSIS_METRICS.map((metric) => ({
    metric,
    unit: metricUnit(metric),
    kind: metricKind(metric),
    offeredYears: fiscalYears.filter((year) => isOffered(years, year, metric)),
  }));

  // FY2024 by default when the default metric is offered there; else the
  // latest year that offers it; else the latest year.
  const defaultMetricYears = metrics.find((m) => m.metric === DEFAULT_METRIC)?.offeredYears ?? [];
  const fiscalYear = defaultMetricYears.includes(PREFERRED_DEFAULT_YEAR)
    ? PREFERRED_DEFAULT_YEAR
    : (defaultMetricYears.at(-1) ?? fiscalYears.at(-1) ?? PREFERRED_DEFAULT_YEAR);
  const metric = isOffered(years, fiscalYear, DEFAULT_METRIC)
    ? DEFAULT_METRIC
    : (metrics.find((m) => m.offeredYears.includes(fiscalYear))?.metric ?? DEFAULT_METRIC);

  const frontier = parseFrontier(row.inputs);
  const caveats =
    frontier === null
      ? [...RELEASE_CAVEATS, 'The input as-of frontier of this release could not be read.']
      : RELEASE_CAVEATS;

  return ok({
    ref: {
      releaseId: String(releaseNumber),
      publishedAt: row.publishedAt,
      active: row.active,
      source: source.value,
    },
    releaseNumber,
    privacyEpoch: row.privacyEpoch,
    publicationId: row.publicationId,
    schemaVersion: row.schemaVersion,
    populationPolicyVersion: row.populationPolicyVersion,
    admissionPolicyVersion: row.admissionPolicyVersion,
    admissionPolicySha256: row.admissionPolicySha256,
    inputSnapshotAt: row.inputSnapshotAt,
    companies: row.companies,
    companyYears: row.companyYears,
    fiscalYears,
    years,
    metrics,
    dimensions: DIMENSIONS,
    defaults: {
      fiscalYear,
      metric,
      // A scope with selected-year filters defaults to REFERENCE_YEAR instead.
      cohortMode: 'EACH_YEAR',
      rankBy: 'METRIC_SUM',
      topN: COMPANY_ANALYSIS_LIMITS.defaultTopN,
      recordSort: 'METRIC',
      direction: 'DESC',
      pageSize: COMPANY_ANALYSIS_LIMITS.defaultPageSize,
    },
    asOf: frontier ?? [],
    nameFilter: false,
    limits: COMPANY_ANALYSIS_LIMITS,
    caveats,
  });
};

/** The year capability, or undefined when the release holds no statement for it. */
export const yearCapability = (
  release: CompanyAnalysisRelease,
  fiscalYear: number
): CompanyAnalysisYearCapability | undefined =>
  release.years.find((y) => y.fiscalYear === fiscalYear);

export const metricOffered = (
  release: CompanyAnalysisRelease,
  fiscalYear: number,
  metric: CompanyAnalysisMetric
): boolean => isOffered(release.years, fiscalYear, metric);
