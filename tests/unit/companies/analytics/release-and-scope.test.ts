import { describe, expect, it } from 'vitest';

import { parseRelease, parseReleaseNumber } from '@/modules/companies/core/analytics-release.js';
import {
  bindScope,
  canonicalScope,
  parseScopeShape,
  scopeHash,
} from '@/modules/companies/core/analytics-scope.js';

import {
  DATASET,
  SOURCE_PIN,
  company,
  releaseRow,
  reported,
  statement,
} from './analytics-fixtures.js';

const row = releaseRow(7, DATASET.companies, DATASET.statements);

const parsed = () => {
  const result = parseRelease(row, 'companies_analytics');
  if (result.isErr()) throw new Error(result.error);
  return result.value;
};

describe('companies analytics release parsing', () => {
  it('derives fiscal years, metric-specific offered years and the FY2024 default', () => {
    const release = parsed();
    expect(release.releaseNumber).toBe(7);
    expect(release.ref).toEqual({
      releaseId: '7',
      publishedAt: '2026-10-02T18:00:00.000Z',
      active: true,
      source: SOURCE_PIN,
    });
    expect(release.fiscalYears).toEqual([2021, 2023, 2024]);
    const offered = (metric: string) =>
      release.metrics.find((m) => m.metric === metric)?.offeredYears;
    expect(offered('TURNOVER')).toEqual([2021, 2023, 2024]);
    // Not admitted in 2023 → not offered there.
    expect(offered('EMPLOYEES')).toEqual([2021, 2024]);
    // Admitted but never reported, and never admitted: both unavailable.
    expect(offered('DEBTS')).toEqual([]);
    expect(offered('NET_RESULT')).toEqual([]);
    expect(release.defaults.fiscalYear).toBe(2024);
    expect(release.defaults.metric).toBe('TURNOVER');
    expect(release.defaults.cohortMode).toBe('EACH_YEAR');
    expect(release.nameFilter).toBe(false);
    expect(release.asOf).toHaveLength(1);
  });

  it('keeps held_observation and every other status visible in the year coverage', () => {
    const y2024 = parsed().years.find((y) => y.fiscalYear === 2024);
    expect(y2024?.statements).toBe('5');
    expect(y2024?.metrics.find((m) => m.metric === 'TURNOVER')?.coverage).toEqual({
      reported: '4',
      missing: '0',
      notAdmitted: '0',
      heldProfile: '0',
      heldObservation: '1',
      heldQuality: '0',
      heldComponent: '0',
    });
    expect(y2024?.sizeBands.find((b) => b.band === 'UNAVAILABLE')?.statements).toBe('2');
  });

  it('falls back to the latest offered year when FY2024 is absent', () => {
    const only2023 = DATASET.statements.filter((s) => s.year === 2023);
    const result = parseRelease(releaseRow(8, DATASET.companies, only2023), 'companies_analytics');
    expect(result._unsafeUnwrap().defaults.fiscalYear).toBe(2023);
  });

  it.each([
    ['the v1 schema', { schemaVersion: 'companies-analytics-ch-v1' }],
    ['an unknown schema', { schemaVersion: 'companies-analytics-ch-v3' }],
    ['the v1 population', { populationPolicyVersion: 'public-legal-person-v1' }],
    ['another database', { clickhouseDatabase: 'proto' }],
    ['table names that do not match the id', { companyTable: 'company_r9' }],
    ['a non-integer id', { releaseId: '7.5' }],
    ['a missing company count', { companies: null }],
    ['coverage that does not add up to the company-years', { companyYears: '999' }],
    ['malformed coverage', { coverage: { '2024': { rows: 'x' } } }],
  ])('refuses %s', (_label, over) => {
    expect(parseRelease({ ...row, ...over }, 'companies_analytics').isErr()).toBe(true);
  });

  it('refuses coverage whose statuses do not add up to the statements', () => {
    const coverage = structuredClone(row.coverage) as Record<
      string,
      { metrics: Record<string, Record<string, number>> }
    >;
    const turnover = coverage['2024']?.metrics['turnover'];
    if (turnover === undefined) throw new Error('fixture');
    turnover['reported'] = 3;
    const result = parseRelease({ ...row, coverage }, 'companies_analytics');
    expect(result._unsafeUnwrapErr()).toContain('do not add up');
  });

  it.each(['0', '-1', '01', 'abc', '9007199254740993', '1e3', ''])(
    'release id %j is not a positive safe integer',
    (raw) => {
      expect(parseReleaseNumber(raw)).toBeNull();
    }
  );

  it('accepts the largest safe integer id', () => {
    expect(parseReleaseNumber('9007199254740991')).toBe(9007199254740991);
  });
});

describe('companies analytics scope', () => {
  const release = parsed();

  it('normalizes, de-duplicates and orders values so equivalent scopes hash alike', () => {
    const a = parseScopeShape({
      cuis: ['RO 400', '100', '400'],
      county: { in: ['IS', 'CJ'] },
      vatPayer: ['UNKNOWN', 'YES'],
    })._unsafeUnwrap();
    const b = parseScopeShape({
      vatPayer: ['YES', 'UNKNOWN'],
      county: { in: ['CJ', 'IS', 'CJ'], includeUnknown: false },
      cuis: ['100', '400'],
      fiscalYear: 2024,
    })._unsafeUnwrap();
    const boundA = bindScope(a, release)._unsafeUnwrap();
    const boundB = bindScope(b, release)._unsafeUnwrap();
    expect(canonicalScope(boundA)).toEqual({
      fiscalYear: 2024,
      cuis: ['100', '400'],
      county: { in: ['CJ', 'IS'] },
      vatPayer: ['YES', 'UNKNOWN'],
    });
    expect(scopeHash(boundA)).toBe(scopeHash(boundB));
  });

  it('refuses withheld (>10 digit) identifiers categorically', () => {
    const result = parseScopeShape({ cuis: ['1234567890123'] });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'scope.cuis' });
  });

  it.each([
    ['an unknown field', { name: 'x' }],
    ['an empty list', { legalForms: [] }],
    ['a key filter with nothing selected', { county: {} }],
    ['a key with SQL text', { county: { in: ["CJ' OR 1=1 --"] } }],
    ['too many CUIs', { cuis: Array.from({ length: 501 }, (_, i) => String(i + 1)) }],
    ['an unknown flag value', { vatPayer: ['MAYBE'] }],
    ['a sub-bani bound', { financialRanges: [{ metric: 'TURNOVER', min: '1.005' }] }],
    ['a float headcount', { financialRanges: [{ metric: 'EMPLOYEES', min: '1.5' }] }],
    ['a range without bounds', { financialRanges: [{ metric: 'TURNOVER' }] }],
    ['min above max', { financialRanges: [{ metric: 'TURNOVER', min: '10', max: '9' }] }],
    [
      'the same metric twice',
      {
        financialRanges: [
          { metric: 'TURNOVER', min: '1' },
          { metric: 'TURNOVER', max: '9' },
        ],
      },
    ],
    [
      'a bound beyond Decimal(18,2)',
      { financialRanges: [{ metric: 'TURNOVER', max: '10000000000000000' }] },
    ],
    ['a numeric (float) bound', { financialRanges: [{ metric: 'TURNOVER', min: 1.5 }] }],
    [
      'NOT_FILED with a financial range',
      { filing: 'NOT_FILED', financialRanges: [{ metric: 'TURNOVER', min: '1' }] },
    ],
    ['a non-integer year', { fiscalYear: 2024.5 }],
  ])('refuses %s', (_label, raw) => {
    expect(parseScopeShape(raw)._unsafeUnwrapErr().type).toBe('InvalidInput');
  });

  it('keeps exact decimal bounds as canonical 2-place strings', () => {
    const shape = parseScopeShape({
      financialRanges: [{ metric: 'TURNOVER', min: '-0.5', max: '9007199254740993.07' }],
    })._unsafeUnwrap();
    expect(shape.financialRanges).toEqual([
      { metric: 'TURNOVER', min: '-0.50', max: '9007199254740993.07' },
    ]);
  });

  it('binds the release default year and refuses a year the release does not hold', () => {
    expect(bindScope({}, release)._unsafeUnwrap().fiscalYear).toBe(2024);
    expect(bindScope({ fiscalYear: 2022 }, release)._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'scope.fiscalYear',
    });
  });

  it('refuses a financial range on a metric not offered in the fiscal year', () => {
    const shape = parseScopeShape({
      fiscalYear: 2023,
      financialRanges: [{ metric: 'EMPLOYEES', min: '1' }],
    })._unsafeUnwrap();
    expect(bindScope(shape, release)._unsafeUnwrapErr().message).toContain('not offered');
  });

  it('keeps an unknown CAEN revision unknown (no guessed revision)', () => {
    const shape = parseScopeShape({
      mainCaen: [{ code: '6201' }, { code: '6201', revision: 'rev2' }],
    });
    expect(shape._unsafeUnwrap().mainCaen).toEqual([
      { code: '6201', revision: null },
      { code: '6201', revision: 'rev2' },
    ]);
  });

  it('builds fixtures that pass the release invariants', () => {
    const small = releaseRow(
      3,
      [company('1')],
      [statement(2024, '1', { TURNOVER: reported('1') })]
    );
    expect(parseRelease(small, 'companies_analytics').isOk()).toBe(true);
  });
});
