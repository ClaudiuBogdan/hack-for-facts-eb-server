/**
 * Companies analytics fakes: an in-memory engine with the contract semantics
 * (population on companies, filers on statements, reported-only values,
 * nulls-last keyset pages), a release-row builder whose coverage is derived
 * from the same rows, and fake release/label sources that count their calls.
 * No containers, no credentials.
 */

import { err, ok, type Result } from 'neverthrow';

import { parseMetricValue, formatMetricValue } from '@/modules/companies/core/analytics-decimal.js';
import {
  CAEN_BASIS_VALUE,
  COMPANY_ANALYSIS_METRICS,
  COMPANY_ANALYSIS_STATUSES,
  METRIC_COLUMN,
  SIZE_BAND_VALUE,
  STATUS_VALUE,
  metricUnit,
  requiresStatement,
  type CompanyAnalysisMetric,
  type CompanyAnalysisScope,
  type CompanyAnalysisStatus,
} from '@/modules/companies/core/analytics-types.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type {
  CompanyAnalysisEngine,
  CompanyAnalysisLabelSource,
  CompanyAnalysisReleaseSource,
  DimensionParts,
  MetricAggregateRow,
  RecordRow,
  RecordValueRow,
} from '@/modules/companies/core/analytics-ports.js';
import type { CompanyAnalysisReleaseRow } from '@/modules/companies/core/analytics-release.js';
import type { CompanyAnalysisDeps } from '@/modules/companies/core/analytics-usecases.js';

export interface FakeCompany {
  readonly cui: string;
  readonly legalForm: string;
  readonly status: string | null;
  readonly county: string | null;
  readonly uat: string | null;
  readonly vat: boolean | null;
  readonly inactive: boolean | null;
  readonly caenBasis: 'revision_known' | 'revision_unknown' | 'missing';
  readonly caenRev: string | null;
  readonly caenCode: string | null;
  readonly registrationYear: number | null;
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

export const company = (cui: string, over: Partial<FakeCompany> = {}): FakeCompany => ({
  cui,
  legalForm: 'SRL',
  status: '1048',
  county: 'CJ',
  uat: '54975',
  vat: true,
  inactive: false,
  caenBasis: 'revision_unknown',
  caenRev: null,
  caenCode: '6201',
  registrationYear: 2010,
  ...over,
});

export const reported = (value: string): FakeCell => ({ status: 'reported', value });
export const held = (status: string): FakeCell => ({ status, value: null });

/** A statement; unlisted metrics are `missing` (or `not_admitted` via `defaultStatus`). */
export const statement = (
  year: number,
  cui: string,
  cells: Partial<Record<CompanyAnalysisMetric, FakeCell>>,
  band = '1-9'
): FakeStatement => ({ year, cui, band, cells });

const cellOf = (s: FakeStatement, metric: CompanyAnalysisMetric): FakeCell =>
  s.cells[metric] ?? { status: 'missing', value: null };

// ── release rows ─────────────────────────────────────────────────────────────

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
    schemaVersion: 'companies-analytics-ch-v1',
    populationPolicyVersion: 'public-legal-person-v1',
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
        { kind: 'onrc_snapshot', id: 's1', published: '2026-07-08', retrieved: null, rows: '10' },
      ],
    },
    ...over,
  };
};

// ── in-memory engine ─────────────────────────────────────────────────────────

const flagText = (value: boolean | null): string | null =>
  value === null ? null : value ? 'YES' : 'NO';

const keyMatches = (
  value: string | null,
  filter: { readonly values: readonly string[]; readonly includeUnknown: boolean } | undefined
): boolean =>
  filter === undefined || (value === null ? filter.includeUnknown : filter.values.includes(value));

const flagMatches = (value: boolean | null, wanted: readonly string[] | undefined): boolean =>
  wanted === undefined || wanted.includes(value === null ? 'UNKNOWN' : value ? 'YES' : 'NO');

export const companyMatches = (scope: CompanyAnalysisScope, c: FakeCompany): boolean =>
  (scope.cuis === undefined || scope.cuis.includes(c.cui)) &&
  keyMatches(c.county, scope.county) &&
  keyMatches(c.uat, scope.uat) &&
  (scope.legalForms === undefined || scope.legalForms.includes(c.legalForm)) &&
  keyMatches(c.status, scope.observedStatus) &&
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
        return [c.county];
      case 'UAT':
        return [c.uat];
      case 'LEGAL_FORM':
        return [c.legalForm];
      case 'OBSERVED_STATUS':
        return [c.status];
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
            statusCode: r.c.status,
            countyCode: r.c.county,
            uatSiruta: r.c.uat,
            vatPayer: flagText(r.c.vat),
            fiscallyInactive: flagText(r.c.inactive),
            caenBasis: r.c.caenBasis,
            caenRevision: r.c.caenRev,
            caenCode: r.c.caenCode,
            registrationYear: r.c.registrationYear === null ? null : String(r.c.registrationYear),
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
 * The current `privacy_state` as the fake primary reports it. Mutable, so a
 * test can withdraw (bump the epoch) between or inside answers; `beforeRead`
 * runs before each reading (index 0 = the first read of the run).
 */
export interface FakePrivacy {
  epoch: string;
  inRecovery: boolean;
  isolation: string;
  /** The read fails with a driver-like error carrying text that must never leak. */
  fail: boolean;
  reads: number;
  beforeRead?: (index: number) => void;
}

export const fakePrivacy = (over: Partial<FakePrivacy> = {}): FakePrivacy => ({
  epoch: '0',
  inRecovery: false,
  isolation: 'read committed',
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
    currentPrivacyEpoch() {
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
    statusLabels(codes) {
      calls.push(`statuses:${codes.join(',')}`);
      return map(codes, { '1048': 'funcțiune' });
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
 * revision-unknown CAEN, unknown county/status/flags, a FY2024 non-filer,
 * EMPLOYEES not admitted in 2023 and NET_RESULT never admitted.
 */
export const DATASET = (() => {
  const companies: FakeCompany[] = [
    company('100', { county: 'CJ' }),
    company('200', { county: 'B', uat: null, vat: null }),
    company('300', { county: null, status: null, caenBasis: 'missing', caenCode: null }),
    company('400', {
      county: 'CJ',
      caenBasis: 'revision_known',
      caenRev: 'rev2',
      caenCode: '6201',
      legalForm: 'SA',
    }),
    company('500', { county: 'IS', inactive: null }),
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
