/**
 * Companies analytics — release metadata → validated release + capabilities.
 *
 * Pure. The repo hands over the PostgreSQL row (`active_release`, or a
 * published historical release); this module refuses anything the reader does
 * not support (schema version, database, table names, malformed coverage) and
 * derives what the release can answer: fiscal years, the metric-specific years
 * on offer, dimensions and defaults. A refusal is a reason string; the caller
 * decides whether it is "unavailable" (the active release) or "invalid pin".
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  COMPANY_ANALYSIS_DIMENSIONS,
  COMPANY_ANALYSIS_LIMITS,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_SCHEMA_VERSION,
  COMPANY_ANALYSIS_SIZE_BANDS,
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

const countText = (value: Static<typeof CountSchema>): string | null => {
  if (typeof value === 'string') return value.replace(/^0+(?=\d)/u, '');
  return Number.isSafeInteger(value) ? String(value) : null;
};

const YEAR_RE = /^(19|20)\d{2}$/u;
const COUNT_TEXT_RE = /^[0-9]+$/u;

export const RELEASE_CAVEATS: readonly string[] = [
  'Registered-office geography, observed ONRC status and ANAF fiscal attributes describe the release snapshot, not the fiscal year.',
  'Observed status is the most advanced ONRC state seen across captures; it does not mean "currently active".',
  'Coverage counts observed filings; a recent year with fewer statements is partial, never labelled complete.',
  'Employee figures are sums of reported average headcounts, not unique people; balances and headcounts are single-year values.',
  'Company names are current public names from the registry, not pinned to the release.',
  'ANAF main activity codes keep their published revision; an unknown revision is shown as unknown, never mapped to a catalog.',
];

const DIMENSION_LABEL_SOURCE: Readonly<Record<CompanyAnalysisDimension, string>> = {
  COUNTY: 'core.territories.county_name by county_code',
  UAT: 'core.territories.name by SIRUTA',
  MAIN_CAEN: 'core.classification_codes (caen_<revision>, code) when the revision is known',
  LEGAL_FORM: 'none: the ONRC legal-form code is shown',
  OBSERVED_STATUS: 'registry status label by code (nomenclature fallback)',
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
    return err(`release schema ${row.schemaVersion} is not supported by this reader`);
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
    ref: { releaseId: String(releaseNumber), publishedAt: row.publishedAt, active: row.active },
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
