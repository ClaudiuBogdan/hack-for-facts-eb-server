/**
 * Companies analytics v2 fakes (schema `companies-analytics-ch-v2`): an
 * in-memory engine with the contract semantics (population on companies,
 * filers on statements, reported-only values, nulls-last keyset pages, edition
 * consensus buckets with their basis, and ONRC observation filters on ONE
 * identifier), a release-row builder whose coverage is derived from the same
 * rows and whose source pin is literal, and fake release/label sources that
 * count their calls. The engine is an independent TypeScript oracle of the
 * semantics, not a copy of the ClickHouse SQL. No containers, no credentials.
 */

import { err, ok, type Result } from 'neverthrow';

import { parseMetricValue, formatMetricValue } from '@/modules/companies/core/analytics-decimal.js';
import {
  CAEN_BASIS_VALUE,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_STATUSES,
  METRIC_COLUMN,
  ONRC_BASIS_VALUE,
  SIZE_BAND_VALUE,
  STATUS_VALUE,
  metricUnit,
  requiresStatement,
  type CompanyAnalysisKeyFilter,
  type CompanyAnalysisMetric,
  type CompanyAnalysisOnrcFilter,
  type CompanyAnalysisScope,
  type CompanyAnalysisStatus,
} from '@/modules/companies/core/analytics-types.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type {
  CompanyAnalysisEngine,
  CompanyAnalysisLabelSource,
  CompanyAnalysisReleaseSource,
  CurrentOnrcPublication,
  DimensionParts,
  MetricAggregateRow,
  RecordRow,
  RecordValueRow,
} from '@/modules/companies/core/analytics-ports.js';
import type { CompanyAnalysisReleaseRow } from '@/modules/companies/core/analytics-release.js';
import type { CompanyAnalysisDeps } from '@/modules/companies/core/analytics-usecases.js';

export type Basis =
  | 'single_observation'
  | 'consistent_observations'
  | 'partial_observations'
  | 'multiple_values'
  | 'missing'
  | 'unresolved';
export type Coverage = 'complete' | 'complete_empty' | 'partial' | 'unresolved';

/** One element of `onrc_identifiers`: a public resolved identifier and its sets. */
export interface FakeIdentifier {
  readonly key: string;
  readonly status: readonly string[];
  readonly county: readonly string[];
  readonly caen: readonly string[];
  /** Exact `rev<N>:<code>` keys of known-revision rows only. */
  readonly keys: readonly string[];
}

export interface FakeCompany {
  readonly cui: string;
  readonly legalForm: string;
  readonly legalFormBasis: Basis;
  readonly status: string | null;
  readonly statusBasis: Basis;
  readonly statusCoverage: Coverage;
  readonly caenCoverage: Coverage;
  readonly county: string | null;
  readonly countyBasis: Basis;
  readonly uat: string | null;
  readonly uatBasis: Basis;
  /** Exact `YYYY-MM-DD` the edition recorded, or null. */
  readonly recordedDate: string | null;
  readonly recordedDateBasis: Basis;
  readonly identifiers: readonly FakeIdentifier[];
  readonly vat: boolean | null;
  readonly inactive: boolean | null;
  readonly caenBasis: 'revision_known' | 'revision_unknown' | 'missing';
  readonly caenRev: string | null;
  readonly caenCode: string | null;
}

/** A metric cell: value present iff status is reported. */
export interface FakeCell {
  readonly status: string;
  readonly value: string | null;
}

export interface FakeStatement {
  readonly year: number;
  readonly cui: string;
  readonly band: string;
  readonly cells: Readonly<Partial<Record<CompanyAnalysisMetric, FakeCell>>>;
}

/**
 * A company of the pinned edition. By default one identifier carrying the
 * company's status and county observations (a single-observation consensus),
 * complete coverage and a recorded date.
 */
export const company = (cui: string, over: Partial<FakeCompany> = {}): FakeCompany => {
  const base = {
    cui,
    legalForm: 'SRL',
    legalFormBasis: 'single_observation' as Basis,
    status: '1048' as string | null,
    statusBasis: 'single_observation' as Basis,
    statusCoverage: 'complete' as Coverage,
    caenCoverage: 'complete' as Coverage,
    county: 'CJ' as string | null,
    countyBasis: 'single_observation' as Basis,
    uat: '54975' as string | null,
    uatBasis: 'single_observation' as Basis,
    recordedDate: '2010-05-17' as string | null,
    recordedDateBasis: 'single_observation' as Basis,
    vat: true as boolean | null,
    inactive: false as boolean | null,
    caenBasis: 'revision_unknown' as FakeCompany['caenBasis'],
    caenRev: null as string | null,
    caenCode: '6201' as string | null,
    ...over,
  };
  return {
    ...base,
    identifiers: over.identifiers ?? [
      {
        key: `J12/${cui}/2010`,
        status: base.status === null ? [] : [base.status],
        county: base.county === null ? [] : [base.county],
        caen: ['6201'],
        keys: ['rev2:6201'],
      },
    ],
  };
};

export const reported = (value: string): FakeCell => ({ status: 'reported', value });
export const held = (status: string): FakeCell => ({ status, value: null });

/** A statement; unlisted metrics are `missing`. */
export const statement = (
  year: number,
  cui: string,
  cells: Partial<Record<CompanyAnalysisMetric, FakeCell>>,
  band = '1-9'
): FakeStatement => ({ year, cui, band, cells });

const cellOf = (s: FakeStatement, metric: CompanyAnalysisMetric): FakeCell =>
  s.cells[metric] ?? { status: 'missing', value: null };

// ── release rows ─────────────────────────────────────────────────────────────

/** The literal v2 source pin of the fixture releases (frozen source contract §1). */
export const SOURCE_PIN = {
  editionId: '42',
  publicationEpoch: '3',
  sourceSnapshotId: 'onrc:2026-07-08',
  sourcePublishedAt: '2026-07-08',
  interpretationVersion: 'onrc-edition-v1',
  privacyPolicyVersion: 'onrc-privacy-v1',
  dimensionPolicyVersion: 'onrc-dimensions-v1',
  eligibilityPolicyVersion: 'public-legal-person-v1',
} as const;

/** The current ONRC publication that still holds SOURCE_PIN (as the PG statement renders it). */
export const currentPublication = (
  over: Partial<CurrentOnrcPublication> = {}
): CurrentOnrcPublication => ({
  publicationState: 'published',
  listed: true,
  editionId: SOURCE_PIN.editionId,
  publicationEpoch: SOURCE_PIN.publicationEpoch,
  sourceSnapshotId: SOURCE_PIN.sourceSnapshotId,
  sourcePublishedAt: SOURCE_PIN.sourcePublishedAt,
  interpretationVersion: SOURCE_PIN.interpretationVersion,
  dimensionPolicyVersion: SOURCE_PIN.dimensionPolicyVersion,
  privacyPolicyVersion: SOURCE_PIN.privacyPolicyVersion,
  ...over,
});

export const releaseRow = (
  releaseId: number,
  companies: readonly FakeCompany[],
  statements: readonly FakeStatement[],
  over: Partial<CompanyAnalysisReleaseRow> = {}
): CompanyAnalysisReleaseRow => {
  const coverage: Record<string, unknown> = {};
  for (const year of [...new Set(statements.map((s) => s.year))]) {
    const rows = statements.filter((s) => s.year === year);
    const metrics: Record<string, Record<string, number>> = {};
    for (const metric of COMPANY_ANALYSIS_METRICS) {
      const counts: Record<string, number> = Object.fromEntries(
        COMPANY_ANALYSIS_STATUSES.map((status) => [STATUS_VALUE[status], 0])
      );
      for (const row of rows) {
        const status = cellOf(row, metric).status;
        counts[status] = (counts[status] ?? 0) + 1;
      }
      metrics[METRIC_COLUMN[metric]] = counts;
    }
    const sizeBands: Record<string, number> = {};
    for (const row of rows) sizeBands[row.band] = (sizeBands[row.band] ?? 0) + 1;
    coverage[String(year)] = { rows: rows.length, metrics, sizeBands };
  }
  return {
    releaseId: String(releaseId),
    publicationId: String(releaseId + 100),
    publishedAt: '2026-10-02T18:00:00.000Z',
    active: true,
    schemaVersion: 'companies-analytics-ch-v2',
    populationPolicyVersion: 'public-onrc-edition-legal-person-v2',
    admissionPolicyVersion: 'admission-v1',
    admissionPolicySha256: 'a'.repeat(64),
    clickhouseDatabase: 'companies_analytics',
    companyTable: `company_r${String(releaseId)}`,
    companyYearTable: `company_year_r${String(releaseId)}`,
    inputSnapshotAt: '2026-10-02T17:00:00Z',
    companies: String(companies.length),
    companyYears: String(statements.length),
    privacyEpoch: '0',
    coverage,
    inputs: {
      frontier: [
        { kind: 'onrc_edition', id: '42', published: '2026-07-08', retrieved: null, rows: '10' },
      ],
      onrc: { ...SOURCE_PIN },
    },
    ...over,
  };
};

// ── in-memory engine (the semantics oracle) ──────────────────────────────────

const flagText = (value: boolean | null): string | null =>
  value === null ? null : value ? 'YES' : 'NO';

/** A consensus bucket selector: value key, basis bucket, or every basis bucket. */
const bucketMatches = (
  value: string | null,
  basis: Basis,
  filter: CompanyAnalysisKeyFilter | undefined
): boolean => {
  if (filter === undefined) return true;
  if (value !== null) return filter.values.includes(value);
  return filter.includeUnknown || filter.bases.some((b) => ONRC_BASIS_VALUE[b] === basis);
};

const flagMatches = (value: boolean | null, wanted: readonly string[] | undefined): boolean =>
  wanted === undefined || wanted.includes(value === null ? 'UNKNOWN' : value ? 'YES' : 'NO');

const intersects = (have: readonly string[], wanted: readonly string[] | undefined): boolean =>
  wanted === undefined || wanted.some((w) => have.includes(w));

const COMPLETE: readonly Coverage[] = ['complete', 'complete_empty'];
const KNOWN: readonly Basis[] = ['single_observation', 'consistent_observations'];

/** ONRC observation filters: positives on ONE identifier; exclusions need complete evidence. */
const onrcMatches = (c: FakeCompany, f: CompanyAnalysisOnrcFilter | undefined): boolean => {
  if (f === undefined) return true;
  const positive =
    f.status !== undefined ||
    f.county !== undefined ||
    f.caenCode !== undefined ||
    f.onrcCaen !== undefined;
  if (
    positive &&
    !c.identifiers.some(
      (i) =>
        intersects(i.status, f.status) &&
        intersects(i.county, f.county) &&
        intersects(i.caen, f.caenCode) &&
        intersects(i.keys, f.onrcCaen)
    )
  )
    return false;
  const x = f.exclude;
  if (x === undefined) return true;
  if (
    x.status !== undefined &&
    (!COMPLETE.includes(c.statusCoverage) ||
      c.identifiers.some((i) => i.status.some((s) => x.status?.includes(s) === true)))
  )
    return false;
  if (
    x.caenCode !== undefined &&
    (!COMPLETE.includes(c.caenCoverage) ||
      c.identifiers.some((i) => i.caen.some((s) => x.caenCode?.includes(s) === true)))
  )
    return false;
  if (
    x.county !== undefined &&
    (!KNOWN.includes(c.countyBasis) || c.county === null || x.county.includes(c.county))
  )
    return false;
  if (
    x.legalForm !== undefined &&
    (!KNOWN.includes(c.legalFormBasis) || x.legalForm.includes(c.legalForm))
  )
    return false;
  return true;
};

export const companyMatches = (scope: CompanyAnalysisScope, c: FakeCompany): boolean =>
  (scope.cuis === undefined || scope.cuis.includes(c.cui)) &&
  bucketMatches(c.county, c.countyBasis, scope.county) &&
  bucketMatches(c.uat, c.uatBasis, scope.uat) &&
  (scope.legalForms === undefined || scope.legalForms.includes(c.legalForm)) &&
  bucketMatches(c.status, c.statusBasis, scope.observedStatus) &&
  onrcMatches(c, scope.onrc) &&
  flagMatches(c.vat, scope.vatPayer) &&
  flagMatches(c.inactive, scope.fiscallyInactive) &&
  (scope.mainCaen === undefined ||
    scope.mainCaen.some((sel) =>
      sel.revision === null
        ? c.caenBasis === 'revision_unknown' && c.caenCode === sel.code
        : c.caenBasis === 'revision_known' && c.caenRev === sel.revision && c.caenCode === sel.code
    )) &&
  (scope.mainCaenBasis === undefined ||
    scope.mainCaenBasis.map((b) => CAEN_BASIS_VALUE[b]).includes(c.caenBasis));

const statementMatches = (scope: CompanyAnalysisScope, s: FakeStatement): boolean =>
  (scope.financialRanges ?? []).every((range) => {
    const cell = cellOf(s, range.metric);
    if (cell.status !== 'reported' || cell.value === null) return false;
    const unit = metricUnit(range.metric);
    const value = parseMetricValue(cell.value, unit) ?? 0n;
    return (
      (range.min === null || value >= (parseMetricValue(range.min, unit) ?? 0n)) &&
      (range.max === null || value <= (parseMetricValue(range.max, unit) ?? 0n))
    );
  }) &&
  (scope.employeeSizeBands === undefined ||
    scope.employeeSizeBands.map((b) => SIZE_BAND_VALUE[b]).includes(s.band));

/** ClickHouse prints decimals without trailing zeros; mimic it to exercise the parser. */
const chDecimal = (scaled: bigint, metric: CompanyAnalysisMetric): string => {
  const text = formatMetricValue(scaled, metricUnit(metric));
  if (metricUnit(metric) !== 'RON') return text;
  // '1000.50' → '1000.5', '10.00' → '10' (the match must reach the end).
  const trimmed = text.replace(/\.?0+$/u, '');
  return trimmed === '' ? '0' : trimmed;
};

const aggregate = (
  metric: CompanyAnalysisMetric,
  rows: readonly FakeStatement[]
): MetricAggregateRow => {
  const statuses = Object.fromEntries(COMPANY_ANALYSIS_STATUSES.map((s) => [s, 0])) as Record<
    CompanyAnalysisStatus,
    number
  >;
  let sum: bigint | null = null;
  for (const row of rows) {
    const cell = cellOf(row, metric);
    const status = COMPANY_ANALYSIS_STATUSES.find((s) => STATUS_VALUE[s] === cell.status);
    if (status !== undefined) statuses[status] += 1;
    if (cell.status === 'reported' && cell.value !== null)
      sum = (sum ?? 0n) + (parseMetricValue(cell.value, metricUnit(metric)) ?? 0n);
  }
  return {
    sum: sum === null ? null : chDecimal(sum, metric),
    statuses: Object.fromEntries(
      COMPANY_ANALYSIS_STATUSES.map((s) => [s, String(statuses[s])])
    ) as Record<CompanyAnalysisStatus, string>,
  };
};

export interface InMemoryEngine extends CompanyAnalysisEngine {
  readonly calls: string[];
  dropTables(releaseNumber: number): void;
}

export const makeInMemoryEngine = (
  companies: readonly FakeCompany[],
  statements: readonly FakeStatement[],
  retained: number[] = []
): InMemoryEngine => {
  const calls: string[] = [];
  const byCui = new Map(companies.map((c) => [c.cui, c]));
  const companyOf = (s: FakeStatement): FakeCompany => {
    const found = byCui.get(s.cui);
    if (found === undefined) throw new Error(`statement without company ${s.cui}`);
    return found;
  };
  const statementOf = (year: number, cui: string): FakeStatement | undefined =>
    statements.find((s) => s.year === year && s.cui === cui);
  const filersOf = (scope: CompanyAnalysisScope, year = scope.fiscalYear): FakeStatement[] =>
    scope.filing === 'NOT_FILED'
      ? []
      : statements.filter(
          (s) =>
            s.year === year && companyMatches(scope, companyOf(s)) && statementMatches(scope, s)
        );
  const population = (scope: CompanyAnalysisScope): FakeCompany[] =>
    companies.filter((c) => {
      if (!companyMatches(scope, c)) return false;
      const st = statementOf(scope.fiscalYear, c.cui);
      if (requiresStatement(scope)) return st !== undefined && statementMatches(scope, st);
      if (scope.filing === 'NOT_FILED') return st === undefined;
      return true;
    });

  const partsOf = (dimension: string, c: FakeCompany, band: string | null): DimensionParts => {
    switch (dimension) {
      case 'COUNTY':
        return [c.county, c.countyBasis];
      case 'UAT':
        return [c.uat, c.uatBasis];
      case 'LEGAL_FORM':
        return [c.legalForm];
      case 'OBSERVED_STATUS':
        return [c.status, c.statusBasis];
      case 'VAT_PAYER':
        return [flagText(c.vat)];
      case 'FISCALLY_INACTIVE':
        return [flagText(c.inactive)];
      case 'MAIN_CAEN':
        return [c.caenBasis, c.caenRev, c.caenCode];
      default:
        return [band];
    }
  };

  const group = <T>(items: readonly T[], key: (item: T) => DimensionParts) => {
    const out = new Map<string, { parts: DimensionParts; items: T[] }>();
    for (const item of items) {
      const parts = key(item);
      const k = JSON.stringify(parts);
      const entry = out.get(k) ?? { parts, items: [] };
      entry.items.push(item);
      out.set(k, entry);
    }
    return [...out.values()];
  };

  return {
    calls,
    dropTables(releaseNumber) {
      const index = retained.indexOf(releaseNumber);
      if (index >= 0) retained.splice(index, 1);
    },
    tablesAvailable(releaseNumber) {
      calls.push(`tablesAvailable:${String(releaseNumber)}`);
      return Promise.resolve(ok(retained.includes(releaseNumber)));
    },
    countPopulation(_release, scope) {
      calls.push('countPopulation');
      return Promise.resolve(ok(String(population(scope).length)));
    },
    aggregateFilers(_release, scope, metrics) {
      calls.push('aggregateFilers');
      const rows = filersOf(scope);
      return Promise.resolve(
        ok({
          filers: String(rows.length),
          metrics: new Map(metrics.map((m) => [m, aggregate(m, rows)])),
        })
      );
    },
    breakdown(_release, scope, dimension, metric) {
      calls.push('breakdown');
      const pop = group(population(scope), (c) =>
        partsOf(dimension, c, statementOf(scope.fiscalYear, c.cui)?.band ?? '')
      );
      const fil = group(filersOf(scope), (s) => partsOf(dimension, companyOf(s), s.band));
      return Promise.resolve(
        ok({
          population: pop.map((g) => ({ parts: g.parts, companies: String(g.items.length) })),
          filers: fil.map((g) => ({
            parts: g.parts,
            filers: String(g.items.length),
            metric: metric === null ? null : aggregate(metric, g.items),
          })),
        })
      );
    },
    series(_release, scope, metric, fromYear, toYear, mode) {
      calls.push(`series:${mode}`);
      const years = [];
      let base: string | null;
      if (mode === 'REFERENCE_YEAR') {
        const cohort = new Set(filersOf(scope).map((s) => s.cui));
        base = String(cohort.size);
        for (let y = fromYear; y <= toYear; y++) {
          const rows = statements.filter((s) => s.year === y && cohort.has(s.cui));
          if (rows.length > 0)
            years.push({
              fiscalYear: y,
              statements: String(rows.length),
              metric: aggregate(metric, rows),
            });
        }
      } else {
        base = requiresStatement(scope)
          ? null
          : String(companies.filter((c) => companyMatches(scope, c)).length);
        for (let y = fromYear; y <= toYear; y++) {
          const rows = statements.filter(
            (s) => s.year === y && companyMatches(scope, companyOf(s)) && statementMatches(scope, s)
          );
          if (rows.length > 0)
            years.push({
              fiscalYear: y,
              statements: String(rows.length),
              metric: aggregate(metric, rows),
            });
        }
      }
      return Promise.resolve(ok({ base, years }));
    },
    records(_release, scope, request) {
      calls.push('records');
      const unitOf = (m: CompanyAnalysisMetric) => metricUnit(m);
      const sortMetric = request.sort === 'METRIC' ? request.sortMetric : null;
      const rows = population(scope).map((c) => {
        const st = statementOf(scope.fiscalYear, c.cui);
        const value = sortMetric === null || st === undefined ? null : cellOf(st, sortMetric).value;
        return {
          c,
          st,
          v:
            value === null || sortMetric === null
              ? null
              : parseMetricValue(value, unitOf(sortMetric)),
        };
      });
      const desc = request.direction === 'DESC';
      rows.sort((a, b) => {
        if (sortMetric === null) return (a.c.cui < b.c.cui ? -1 : 1) * (desc ? -1 : 1);
        if (a.v !== b.v) {
          if (a.v === null) return 1;
          if (b.v === null) return -1;
          return (a.v > b.v ? 1 : -1) * (desc ? -1 : 1);
        }
        return a.c.cui < b.c.cui ? -1 : 1;
      });
      const after = request.after;
      const filtered = rows.filter((r) => {
        if (after === null) return true;
        if (sortMetric === null) return desc ? r.c.cui < after.cui : r.c.cui > after.cui;
        if (after.value === null) return r.v === null && r.c.cui > after.cui;
        const v = parseMetricValue(after.value, unitOf(sortMetric)) ?? 0n;
        if (r.v === null) return true;
        return (desc ? r.v < v : r.v > v) || (r.v === v && r.c.cui > after.cui);
      });
      return Promise.resolve(
        ok(
          filtered.slice(0, request.limit).map((r): RecordRow => ({
            cui: r.c.cui,
            legalForm: r.c.legalForm,
            legalFormBasis: r.c.legalFormBasis,
            statusCode: r.c.status,
            statusBasis: r.c.statusBasis,
            statusCoverage: r.c.statusCoverage,
            caenCoverage: r.c.caenCoverage,
            countyCode: r.c.county,
            countyBasis: r.c.countyBasis,
            uatSiruta: r.c.uat,
            uatBasis: r.c.uatBasis,
            recordedYear:
              r.c.recordedDate === null ? null : String(Number(r.c.recordedDate.slice(0, 4))),
            recordedDate: r.c.recordedDate,
            recordedDateBasis: r.c.recordedDateBasis,
            vatPayer: flagText(r.c.vat),
            fiscallyInactive: flagText(r.c.inactive),
            caenBasis: r.c.caenBasis,
            caenRevision: r.c.caenRev,
            caenCode: r.c.caenCode,
            filed: r.st !== undefined,
            sizeBand: r.st?.band ?? null,
            values: new Map(
              request.metrics.map((m): [CompanyAnalysisMetric, RecordValueRow] => {
                if (r.st === undefined) return [m, { value: null, status: null }];
                const cell = cellOf(r.st, m);
                return [m, { value: cell.value, status: cell.status }];
              })
            ),
          }))
        )
      );
    },
  };
};

// ── release + label sources ─────────────────────────────────────────────────

/**
 * The current state as the fake primary reports it: privacy epoch and the
 * current ONRC publication. Mutable, so a test can withdraw (bump the epoch)
 * or publish a new edition between or inside answers; `beforeRead` runs
 * before each reading (index 0 = the first read of the run).
 */
export interface FakePrivacy {
  epoch: string;
  inRecovery: boolean;
  isolation: string;
  onrc: CurrentOnrcPublication;
  /** The read fails with a driver-like error carrying text that must never leak. */
  fail: boolean;
  reads: number;
  beforeRead?: (index: number) => void;
}

export const fakePrivacy = (over: Partial<FakePrivacy> = {}): FakePrivacy => ({
  epoch: '0',
  inRecovery: false,
  isolation: 'read committed',
  onrc: currentPublication(),
  fail: false,
  reads: 0,
  ...over,
});

export interface FakeReleaseSource extends CompanyAnalysisReleaseSource {
  readonly calls: string[];
  readonly privacy: FakePrivacy;
}

export const fakeReleases = (
  active: CompanyAnalysisReleaseRow | null,
  historical: readonly CompanyAnalysisReleaseRow[] = [],
  privacy: FakePrivacy = fakePrivacy()
): FakeReleaseSource => {
  const calls: string[] = [];
  return {
    calls,
    privacy,
    activeRelease() {
      calls.push('active');
      return Promise.resolve(ok(active));
    },
    publishedRelease(releaseNumber) {
      calls.push(`published:${String(releaseNumber)}`);
      const row = historical.find((r) => r.releaseId === String(releaseNumber)) ?? null;
      return Promise.resolve(ok(row === null ? null : { ...row, active: false }));
    },
    currentState() {
      calls.push('privacy');
      privacy.beforeRead?.(privacy.reads);
      privacy.reads += 1;
      if (privacy.fail)
        return Promise.resolve(
          err(databaseError('connect ECONNREFUSED postgres://reader:pw@primary:5432'))
        );
      return Promise.resolve(
        ok({
          epoch: privacy.epoch,
          inRecovery: privacy.inRecovery,
          isolation: privacy.isolation,
          onrc: privacy.onrc,
        })
      );
    },
  };
};

export interface FakeLabels extends CompanyAnalysisLabelSource {
  readonly calls: string[];
}

export const fakeLabels = (
  names: Readonly<Record<string, string>> = {},
  caen: Readonly<Record<string, string>> = {}
): FakeLabels => {
  const calls: string[] = [];
  const map = (
    keys: readonly string[],
    table: Readonly<Record<string, string>>
  ): Promise<Result<ReadonlyMap<string, string>, ApiError>> =>
    Promise.resolve(
      ok(
        new Map(
          keys.flatMap((k) => {
            const label = table[k];
            return label === undefined ? [] : [[k, label] as const];
          })
        )
      )
    );
  return {
    calls,
    companyNames(cuis) {
      calls.push(`names:${cuis.join(',')}`);
      return map(cuis, names);
    },
    countyLabels(codes) {
      calls.push(`counties:${codes.join(',')}`);
      return map(codes, { CJ: 'Cluj', B: 'București', IS: 'Iași' });
    },
    uatLabels(sirutas) {
      calls.push(`uats:${sirutas.join(',')}`);
      return map(sirutas, { '54975': 'Cluj-Napoca' });
    },
    caenLabels(keys) {
      calls.push(`caen:${keys.map((k) => `${k.revision}:${k.code}`).join(',')}`);
      return map(
        keys.map((k) => `${k.revision}:${k.code}`),
        caen
      );
    },
  };
};

export const analyticsDeps = (
  engine: CompanyAnalysisEngine,
  releases: CompanyAnalysisReleaseSource,
  labels: CompanyAnalysisLabelSource = fakeLabels()
): CompanyAnalysisDeps => ({ engine, releases, labels, database: 'companies_analytics' });

// ── the shared dataset ───────────────────────────────────────────────────────

/** 2^53 + 1 RON and 7 bani: a float would already have lost the bani. */
export const HUGE_TURNOVER = '9007199254740993.07';

/**
 * Six companies; FY2021, FY2023, FY2024 (FY2022 has no statement); money
 * beyond 2^53, an explicit zero, a held observation, a revision-known and a
 * revision-unknown ANAF CAEN, a FY2024 non-filer, EMPLOYEES not admitted in
 * 2023 and NET_RESULT never admitted.
 *
 * Edition evidence is SOURCE-SHAPED (hand-declared, never derived by the
 * runtime): a county/UAT/status value exists only on complete agreement of
 * the public observations; incomplete status evidence has no status value
 * (partial_observations); a parsed CAEN code without a known-revision key
 * makes CAEN coverage partial; county and UAT share one address geography.
 *  - 300: no county observation on its one identifier (county and UAT
 *    missing); 1048 next to 1070 on ONE identifier: status multiple_values,
 *    still a public 1048 observation; partial CAEN coverage;
 *  - 400: TWO identifiers, 1048 in AB and 1070 in CJ: county, UAT and status
 *    multiple_values (1048 + CJ never holds on one identifier); 6201 of
 *    unknown revision on one of them: CAEN coverage partial. Its ANAF main
 *    activity (revision_known rev2:6201) is an independent source;
 *  - 500: partial status evidence with a public 1048 observation: status
 *    null/partial_observations; 6201 of unknown revision: CAEN coverage
 *    partial; county IS with an IS UAT key;
 *  - 200: county B without a UAT (missing) and a consistent status.
 * The corrections keep every company, statement and money value: only the
 * edition fields moved (whole-population and monetary totals unchanged).
 * The recorded dates 0001-01-01 (400) and 9999-12-31 (500) and money beyond
 * 2^53 are BEYOND-POLICY boundary values for text/arithmetic tests only; they
 * claim nothing about what the national admission policy would admit.
 */
export const DATASET = (() => {
  const companies: FakeCompany[] = [
    company('100', { county: 'CJ' }),
    company('200', {
      county: 'B',
      uat: null,
      uatBasis: 'missing',
      vat: null,
      statusBasis: 'consistent_observations',
    }),
    company('300', {
      county: null,
      countyBasis: 'missing',
      uat: null,
      uatBasis: 'missing',
      status: null,
      statusBasis: 'multiple_values',
      caenCoverage: 'partial',
      caenBasis: 'missing',
      caenCode: null,
      recordedDate: null,
      recordedDateBasis: 'missing',
      identifiers: [
        { key: 'J40/300/2001', status: ['1048', '1070'], county: [], caen: [], keys: [] },
      ],
    }),
    company('400', {
      county: null,
      countyBasis: 'multiple_values',
      uat: null,
      uatBasis: 'multiple_values',
      status: null,
      statusBasis: 'multiple_values',
      caenCoverage: 'partial',
      caenBasis: 'revision_known',
      caenRev: 'rev2',
      caenCode: '6201',
      legalForm: 'SA',
      recordedDate: '0001-01-01',
      identifiers: [
        {
          key: 'J01/400/1999',
          status: ['1048'],
          county: ['AB'],
          caen: ['0111'],
          keys: ['rev0:0111'],
        },
        { key: 'J12/400/2004', status: ['1070'], county: ['CJ'], caen: ['6201'], keys: [] },
      ],
    }),
    company('500', {
      county: 'IS',
      uat: '95060',
      inactive: null,
      status: null,
      statusBasis: 'partial_observations',
      statusCoverage: 'partial',
      caenCoverage: 'partial',
      recordedDate: '9999-12-31',
      identifiers: [
        { key: 'J22/500/2015', status: ['1048'], county: ['IS'], caen: ['6201'], keys: [] },
      ],
    }),
    company('600', { county: 'CJ' }),
  ];
  const statements: FakeStatement[] = [
    statement(
      2024,
      '100',
      { TURNOVER: reported(HUGE_TURNOVER), EMPLOYEES: reported('12') },
      '10-49'
    ),
    statement(2024, '200', { TURNOVER: reported('0'), EMPLOYEES: reported('0') }, '0'),
    statement(
      2024,
      '300',
      { TURNOVER: held('held_observation'), EMPLOYEES: held('missing') },
      'unavailable'
    ),
    statement(2024, '400', { TURNOVER: reported('1000.5'), EMPLOYEES: reported('300') }, '250+'),
    statement(
      2024,
      '500',
      { TURNOVER: reported('-20.25'), EMPLOYEES: held('held_profile') },
      'unavailable'
    ),
    // 600 did not file in 2024.
    statement(
      2023,
      '100',
      { TURNOVER: reported('10'), EMPLOYEES: held('not_admitted') },
      'unavailable'
    ),
    statement(
      2023,
      '400',
      { TURNOVER: reported('20'), EMPLOYEES: held('not_admitted') },
      'unavailable'
    ),
    statement(
      2023,
      '600',
      { TURNOVER: held('held_quality'), EMPLOYEES: held('not_admitted') },
      'unavailable'
    ),
    statement(2021, '100', { TURNOVER: reported('5'), EMPLOYEES: reported('3') }, '1-9'),
  ];
  // Every other metric is missing; NET_RESULT is not admitted at all.
  const withNotAdmittedNetResult = statements.map((s) => ({
    ...s,
    cells: { ...s.cells, NET_RESULT: held('not_admitted') },
  }));
  return { companies, statements: withNotAdmittedNetResult };
})();

/**
 * Small source-shaped controls (a release of their own, so DATASET totals do
 * not move), hand-declared:
 *  - 701: incomplete evidence. County, UAT and status are NULL with basis
 *    partial_observations; status and CAEN coverage partial. Its one public
 *    identifier still observes 1048 in CJ and a 6201 of unknown revision.
 *  - 702: unresolved evidence. County, UAT and status are NULL/unresolved;
 *    status and CAEN coverage unresolved. Its one public identifier still
 *    observes 1070 and rev0:0111.
 *  - 703: complete and empty. One resolved public identifier with no child
 *    observations (empty status, county, CAEN and key sets; `[]` would mean
 *    no identifier, which is not complete identity evidence); status and CAEN
 *    coverage complete_empty; county, UAT and status NULL/missing: absence is
 *    known.
 *  - 704: a complete consensus (CJ, 54975, 1048) on one identifier.
 * One FY2024 statement each, turnover 10 / 20 / 30 / 40 RON (100 in total).
 */
export const ONRC_CONTROLS = (() => {
  const companies: FakeCompany[] = [
    company('701', {
      county: null,
      countyBasis: 'partial_observations',
      uat: null,
      uatBasis: 'partial_observations',
      status: null,
      statusBasis: 'partial_observations',
      statusCoverage: 'partial',
      caenCoverage: 'partial',
      identifiers: [
        { key: 'J12/701/2011', status: ['1048'], county: ['CJ'], caen: ['6201'], keys: [] },
      ],
    }),
    company('702', {
      county: null,
      countyBasis: 'unresolved',
      uat: null,
      uatBasis: 'unresolved',
      status: null,
      statusBasis: 'unresolved',
      statusCoverage: 'unresolved',
      caenCoverage: 'unresolved',
      identifiers: [
        { key: 'J40/702/2012', status: ['1070'], county: [], caen: ['0111'], keys: ['rev0:0111'] },
      ],
    }),
    company('703', {
      county: null,
      countyBasis: 'missing',
      uat: null,
      uatBasis: 'missing',
      status: null,
      statusBasis: 'missing',
      statusCoverage: 'complete_empty',
      caenCoverage: 'complete_empty',
      identifiers: [{ key: 'J12/703/2010', status: [], county: [], caen: [], keys: [] }],
    }),
    company('704', {
      identifiers: [
        {
          key: 'J12/704/2014',
          status: ['1048'],
          county: ['CJ'],
          caen: ['6201'],
          keys: ['rev2:6201'],
        },
      ],
    }),
  ];
  const statements: FakeStatement[] = [
    statement(2024, '701', { TURNOVER: reported('10') }),
    statement(2024, '702', { TURNOVER: reported('20') }),
    statement(2024, '703', { TURNOVER: reported('30') }),
    statement(2024, '704', { TURNOVER: reported('40') }),
  ];
  return { companies, statements };
})();
