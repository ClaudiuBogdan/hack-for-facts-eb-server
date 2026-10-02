import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
} from '@/modules/companies/core/analytics-usecases.js';

import {
  DATASET,
  HUGE_TURNOVER,
  analyticsDeps,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
} from '../../../fixtures/companies-analytics.js';

import type {
  CompanyAnalysisBucket,
  CompanyAnalysisDimension,
} from '@/modules/companies/core/analytics-types.js';

const ACTIVE = releaseRow(7, DATASET.companies, DATASET.statements);
const HISTORICAL = releaseRow(6, DATASET.companies, DATASET.statements, { active: false });

const setup = (retained: number[] = [7, 6]) => {
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, retained);
  const releases = fakeReleases(ACTIVE, [HISTORICAL]);
  const labels = fakeLabels(
    { '100': 'ALFA SRL', '400': 'BETA SA' },
    { 'rev2:6201': 'Activități de realizare a soft-ului la comandă' }
  );
  return { engine, releases, labels, deps: analyticsDeps(engine, releases, labels) };
};

describe('release resolution and pinning', () => {
  it('answers a controlled SERVICE_UNAVAILABLE when the reader is not configured', async () => {
    for (const result of [
      await companyAnalysisRelease(null, {}),
      await companyAnalysisStats(null, {}),
      await companyAnalysisBreakdown(null, { dimension: 'COUNTY' }),
      await companyAnalysisSeries(null, {}),
      await companyAnalysisRecords(null, {}),
    ]) {
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    }
  });

  it('answers SERVICE_UNAVAILABLE (never an empty success) when nothing is published', async () => {
    const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
    const result = await companyAnalysisStats(analyticsDeps(engine, fakeReleases(null)), {});
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
      message: 'no companies analytics release is published',
    });
    expect(engine.calls).not.toContain('countPopulation');
  });

  it('refuses an active release with an unsupported schema as unavailable', async () => {
    const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
    const releases = fakeReleases({ ...ACTIVE, schemaVersion: 'companies-analytics-ch-v9' });
    const result = await companyAnalysisStats(analyticsDeps(engine, releases), {});
    expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('serves a published historical pin and echoes it as not active', async () => {
    const { deps } = setup();
    const result = await companyAnalysisStats(deps, { release: '6' });
    expect(result._unsafeUnwrap().release).toEqual({
      releaseId: '6',
      publishedAt: '2026-10-02T18:00:00.000Z',
      active: false,
    });
  });

  it('never switches an unavailable pin: unpublished and no-longer-retained are typed errors', async () => {
    const { deps } = setup([7]);
    const unpublished = await companyAnalysisStats(deps, { release: '99' });
    expect(unpublished._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'release',
    });
    expect(unpublished._unsafeUnwrapErr().message).toContain('not a published release');
    const dropped = await companyAnalysisStats(deps, { release: 6 });
    expect(dropped._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'release' });
    expect(dropped._unsafeUnwrapErr().message).toContain('no longer retained');
  });

  it.each(['abc', '0', '-3', '9007199254740993', 1.5])(
    'validates the pin %j before any I/O',
    async (pin) => {
      const { deps, releases, engine } = setup();
      const result = await companyAnalysisStats(deps, { release: pin });
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'release' });
      expect(releases.calls).toEqual([]);
      expect(engine.calls).toEqual([]);
    }
  );

  it('rejects an invalid scope before any I/O', async () => {
    const { deps, releases, engine } = setup();
    const result = await companyAnalysisStats(deps, { scope: { cuis: ['12345678901234'] } });
    expect(result.isErr()).toBe(true);
    expect([...releases.calls, ...engine.calls]).toEqual([]);
  });

  it('describes the release without its internal number', async () => {
    const { deps } = setup();
    const info = (await companyAnalysisRelease(deps, {}))._unsafeUnwrap();
    expect(info.release.releaseId).toBe('7');
    expect(info).not.toHaveProperty('releaseNumber');
    expect(info).not.toHaveProperty('ref');
    expect(info.defaults.fiscalYear).toBe(2024);
  });
});

describe('companyAnalysisStats', () => {
  it('counts the population on companies and filers on statements, exactly', async () => {
    const { deps } = setup();
    const stats = (
      await companyAnalysisStats(deps, { metrics: ['TURNOVER', 'EMPLOYEES'] })
    )._unsafeUnwrap();
    expect(stats.fiscalYear).toBe(2024);
    expect(stats.companies).toBe('6');
    expect(stats.filers).toBe('5');
    expect(stats.nonFilers).toBe('1');
    const turnover = stats.metrics[0];
    // 9007199254740993.07 + 0 + 1000.5 − 20.25, beyond any float.
    expect(turnover).toMatchObject({
      metric: 'TURNOVER',
      unit: 'RON',
      kind: 'FLOW',
      sum: '9007199254741973.32',
      contributors: '4',
      mean: '2251799813685493.33',
    });
    expect(turnover?.coverage).toMatchObject({ reported: '4', heldObservation: '1' });
    expect(stats.metrics[1]).toMatchObject({
      metric: 'EMPLOYEES',
      unit: 'HEADCOUNT',
      kind: 'HEADCOUNT',
      sum: '312',
      contributors: '3',
      mean: '104.00',
      coverage: { reported: '3', missing: '1', heldProfile: '1' },
    });
  });

  it('keeps an explicit zero as 0.00 and an empty contributor set as null', async () => {
    const { deps } = setup();
    const zero = (await companyAnalysisStats(deps, { scope: { cuis: ['200'] } }))._unsafeUnwrap();
    expect(zero.metrics[0]).toMatchObject({ sum: '0.00', contributors: '1', mean: '0.00' });
    const held = (await companyAnalysisStats(deps, { scope: { cuis: ['300'] } }))._unsafeUnwrap();
    expect(held.metrics[0]).toMatchObject({
      sum: null,
      contributors: '0',
      mean: null,
      coverage: { heldObservation: '1', reported: '0' },
    });
  });

  it('separates filers from non-filers and applies filing presence', async () => {
    const { deps } = setup();
    const nonFiler = (
      await companyAnalysisStats(deps, { scope: { cuis: ['600'] } })
    )._unsafeUnwrap();
    expect(nonFiler).toMatchObject({ companies: '1', filers: '0', nonFilers: '1' });
    expect(nonFiler.metrics[0]?.sum).toBeNull();
    const notFiled = (
      await companyAnalysisStats(deps, { scope: { filing: 'NOT_FILED' } })
    )._unsafeUnwrap();
    expect(notFiled).toMatchObject({ companies: '1', filers: '0' });
    const filed = (
      await companyAnalysisStats(deps, { scope: { filing: 'FILED' } })
    )._unsafeUnwrap();
    expect(filed).toMatchObject({ companies: '5', filers: '5', nonFilers: '0' });
  });

  it('filters on reported values only', async () => {
    const { deps } = setup();
    const stats = (
      await companyAnalysisStats(deps, {
        scope: { financialRanges: [{ metric: 'TURNOVER', min: '0' }] },
      })
    )._unsafeUnwrap();
    expect(stats).toMatchObject({ companies: '3', filers: '3' });
    expect(stats.metrics[0]?.sum).toBe('9007199254741993.57');
  });

  it('refuses a metric the fiscal year does not offer before the engine runs', async () => {
    const { deps, engine } = setup();
    const result = await companyAnalysisStats(deps, { metrics: ['NET_RESULT'] });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'metrics' });
    expect(engine.calls.filter((c) => !c.startsWith('tablesAvailable'))).toEqual([]);
  });

  it('fails fast when statuses do not add up to the statements', async () => {
    const { engine, releases } = setup();
    const broken = {
      ...engine,
      aggregateFilers: () =>
        Promise.resolve(
          ok({
            filers: '5',
            metrics: new Map([
              [
                'TURNOVER' as const,
                {
                  sum: '1',
                  statuses: {
                    REPORTED: '1',
                    MISSING: '0',
                    NOT_ADMITTED: '0',
                    HELD_PROFILE: '0',
                    HELD_OBSERVATION: '0',
                    HELD_QUALITY: '0',
                    HELD_COMPONENT: '0',
                  },
                },
              ],
            ]),
          })
        ),
    };
    const result = await companyAnalysisStats(analyticsDeps(broken, releases), {});
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Database' });
  });
});

const sumBuckets = (buckets: readonly CompanyAnalysisBucket[]) => {
  let companies = 0n;
  let filers = 0n;
  let contributors = 0n;
  let bani = 0n;
  for (const b of buckets) {
    companies += BigInt(b.companies);
    filers += BigInt(b.filers);
    contributors += BigInt(b.metric?.contributors ?? '0');
    const sum = b.metric?.sum ?? null;
    if (sum !== null) bani += BigInt(sum.replace('.', ''));
  }
  return { companies, filers, contributors, bani };
};

describe('companyAnalysisBreakdown', () => {
  const dimensions: readonly CompanyAnalysisDimension[] = [
    'COUNTY',
    'UAT',
    'MAIN_CAEN',
    'LEGAL_FORM',
    'OBSERVED_STATUS',
    'VAT_PAYER',
    'FISCALLY_INACTIVE',
    'EMPLOYEE_SIZE',
  ];

  it.each(dimensions)('%s: top groups + other + unknown = totals = stats', async (dimension) => {
    const { deps } = setup();
    const stats = (await companyAnalysisStats(deps, {}))._unsafeUnwrap();
    const breakdown = (
      await companyAnalysisBreakdown(deps, { dimension, topN: 1 })
    )._unsafeUnwrap();
    const parts = sumBuckets([...breakdown.groups, breakdown.other, breakdown.unknown]);
    const totals = sumBuckets([breakdown.totals]);
    expect(parts).toEqual(totals);
    expect(breakdown.totals.companies).toBe(stats.companies);
    expect(breakdown.totals.filers).toBe(stats.filers);
    expect(breakdown.totals.metric).toEqual(stats.metrics[0]);
    expect(breakdown.groups.length + breakdown.other.groups).toBe(breakdown.groupCount);
  });

  it('ranks by the reported sum (nulls last), labels by key and folds the rest into other', async () => {
    const { deps } = setup();
    const b = (
      await companyAnalysisBreakdown(deps, { dimension: 'COUNTY', topN: 2 })
    )._unsafeUnwrap();
    expect(b.rankedBy).toBe('METRIC_SUM');
    expect(b.groups.map((g) => [g.key, g.label, g.companies, g.filers, g.metric?.sum])).toEqual([
      ['CJ', 'Cluj', '3', '2', '9007199254741993.57'],
      ['B', 'București', '1', '1', '0.00'],
    ]);
    expect(b.other).toMatchObject({ kind: 'OTHER', groups: 1, companies: '1' });
    expect(b.other.metric?.sum).toBe('-20.25');
    expect(b.unknown).toMatchObject({ kind: 'UNKNOWN', key: null, companies: '1', filers: '1' });
    expect(b.unknown.metric).toMatchObject({ sum: null, contributors: '0' });
  });

  it('keeps an unknown CAEN revision unknown: own key, no catalog label', async () => {
    const { deps, labels } = setup();
    const b = (await companyAnalysisBreakdown(deps, { dimension: 'MAIN_CAEN' }))._unsafeUnwrap();
    const unknownRevision = b.groups.find((g) => g.key === '?:6201');
    const knownRevision = b.groups.find((g) => g.key === 'rev2:6201');
    expect(unknownRevision?.caen).toEqual({
      code: '6201',
      revision: null,
      basis: 'REVISION_UNKNOWN',
      label: null,
    });
    expect(unknownRevision?.label).toBeNull();
    expect(knownRevision?.caen?.label).toBe('Activități de realizare a soft-ului la comandă');
    expect(labels.calls.filter((c) => c.startsWith('caen:'))).toEqual(['caen:rev2:6201']);
    // basis 'missing' is the unknown group.
    expect(b.unknown.companies).toBe('1');
  });

  it('puts non-filers and unreported headcounts in the unknown size group', async () => {
    const { deps } = setup();
    const b = (
      await companyAnalysisBreakdown(deps, { dimension: 'EMPLOYEE_SIZE', rankBy: 'COMPANIES' })
    )._unsafeUnwrap();
    expect(b.groups.map((g) => g.key).sort()).toEqual(['FROM_10_TO_49', 'FROM_250', 'ZERO']);
    expect(b.unknown).toMatchObject({ companies: '3', filers: '2' });
  });

  it('falls back to a COMPANIES ranking when no group has a contributor', async () => {
    const { deps } = setup();
    const b = (
      await companyAnalysisBreakdown(deps, {
        dimension: 'COUNTY',
        scope: { cuis: ['300', '600'] },
      })
    )._unsafeUnwrap();
    expect(b.rankBy).toBe('METRIC_SUM');
    expect(b.rankedBy).toBe('COMPANIES');
  });

  it('validates the dimension and topN before any I/O', async () => {
    const { deps, engine } = setup();
    expect((await companyAnalysisBreakdown(deps, {}))._unsafeUnwrapErr()).toMatchObject({
      field: 'dimension',
    });
    expect(
      (await companyAnalysisBreakdown(deps, { dimension: 'COUNTY', topN: 101 }))._unsafeUnwrapErr()
    ).toMatchObject({ field: 'topN' });
    expect(engine.calls).toEqual([]);
  });
});

describe('companyAnalysisSeries', () => {
  it('EACH_YEAR: one point per year, gaps named, population per year', async () => {
    const { deps } = setup();
    const s = (await companyAnalysisSeries(deps, {}))._unsafeUnwrap();
    expect(s.cohortMode).toBe('EACH_YEAR');
    expect([s.fromYear, s.toYear]).toEqual([2021, 2024]);
    expect(
      s.points.map((p) => [
        p.fiscalYear,
        p.available,
        p.gapReason,
        p.companies,
        p.filers,
        p.metric.sum,
      ])
    ).toEqual([
      [2021, true, null, '6', '1', '5.00'],
      [2022, false, 'NO_STATEMENTS', '6', '0', null],
      [2023, true, null, '6', '3', '30.00'],
      [2024, true, null, '6', '5', '9007199254741973.32'],
    ]);
    expect(s.points[2]?.metric.coverage.heldQuality).toBe('1');
  });

  it('names a not-admitted year as a gap, never as zero', async () => {
    const { deps } = setup();
    const s = (await companyAnalysisSeries(deps, { metric: 'EMPLOYEES' }))._unsafeUnwrap();
    const y2023 = s.points.find((p) => p.fiscalYear === 2023);
    expect(y2023).toMatchObject({ available: false, gapReason: 'NOT_ADMITTED', filers: '3' });
    expect(y2023?.metric.sum).toBeNull();
    expect(y2023?.metric.coverage.notAdmitted).toBe('3');
  });

  it('REFERENCE_YEAR follows the fixed cohort selected in the fiscal year', async () => {
    const { deps } = setup();
    const scope = { financialRanges: [{ metric: 'TURNOVER', min: '1000' }] };
    const s = (await companyAnalysisSeries(deps, { scope }))._unsafeUnwrap();
    expect(s.cohortMode).toBe('REFERENCE_YEAR');
    expect(s.referenceYear).toBe(2024);
    expect(s.cohortCompanies).toBe('2');
    expect(s.points.map((p) => [p.fiscalYear, p.companies, p.filers, p.metric.sum])).toEqual([
      [2021, '2', '1', '5.00'],
      [2022, '2', '0', null],
      [2023, '2', '2', '30.00'],
      [2024, '2', '2', '9007199254741993.57'],
    ]);
    const each = (
      await companyAnalysisSeries(deps, { scope, cohortMode: 'EACH_YEAR' })
    )._unsafeUnwrap();
    // Re-applied per year: nobody reached 1000 RON in 2021 or 2023 — those
    // points are scoped gaps, not available nulls.
    for (const year of [2021, 2023]) {
      expect(each.points.find((p) => p.fiscalYear === year)).toMatchObject({
        companies: '0',
        filers: '0',
        available: false,
        gapReason: 'NO_STATEMENTS',
        metric: { sum: null, contributors: '0' },
      });
    }
    expect(each.points.find((p) => p.fiscalYear === 2024)).toMatchObject({
      available: true,
      gapReason: null,
    });
  });

  it('EACH_YEAR NOT_FILED counts each year non-filers without metric values', async () => {
    const { deps } = setup();
    const s = (
      await companyAnalysisSeries(deps, { scope: { filing: 'NOT_FILED' } })
    )._unsafeUnwrap();
    expect(s.points.map((p) => [p.fiscalYear, p.companies, p.filers])).toEqual([
      [2021, '5', '0'],
      [2022, '6', '0'],
      [2023, '3', '0'],
      [2024, '1', '0'],
    ]);
    expect(s.points.every((p) => p.metric.sum === null)).toBe(true);
    // Non-filers carry no statement: every point is a NO_STATEMENTS gap.
    expect(s.points.every((p) => !p.available && p.gapReason === 'NO_STATEMENTS')).toBe(true);
  });

  it('judges availability on the scope: a held-only year is NO_REPORTED_VALUES', async () => {
    const { deps } = setup();
    const s = (
      await companyAnalysisSeries(deps, { scope: { cuis: ['300'] }, cohortMode: 'EACH_YEAR' })
    )._unsafeUnwrap();
    // CUI 300 filed in 2024 with turnover held_observation (release-wide, 2024 is offered).
    expect(s.points.find((p) => p.fiscalYear === 2024)).toMatchObject({
      filers: '1',
      available: false,
      gapReason: 'NO_REPORTED_VALUES',
      metric: { sum: null, contributors: '0', coverage: { heldObservation: '1' } },
    });
  });

  it('judges availability on the scope: a year without the scope’s filing is NO_STATEMENTS', async () => {
    const { deps } = setup();
    const s = (
      await companyAnalysisSeries(deps, { scope: { cuis: ['600'] }, cohortMode: 'EACH_YEAR' })
    )._unsafeUnwrap();
    // CUI 600: no statement in 2021, 2022 or 2024; a held_quality turnover in 2023.
    expect(s.points.map((p) => [p.fiscalYear, p.available, p.gapReason])).toEqual([
      [2021, false, 'NO_STATEMENTS'],
      [2022, false, 'NO_STATEMENTS'],
      [2023, false, 'NO_REPORTED_VALUES'],
      [2024, false, 'NO_STATEMENTS'],
    ]);
  });

  it('keeps an explicit reported zero available', async () => {
    const { deps } = setup();
    const s = (
      await companyAnalysisSeries(deps, { scope: { cuis: ['200'] }, cohortMode: 'EACH_YEAR' })
    )._unsafeUnwrap();
    expect(s.points.find((p) => p.fiscalYear === 2024)).toMatchObject({
      available: true,
      gapReason: null,
      metric: { sum: '0.00', contributors: '1' },
    });
  });

  it('names a scoped NOT_ADMITTED gap only when every scoped statement is not admitted', async () => {
    const { deps } = setup();
    const s = (
      await companyAnalysisSeries(deps, {
        metric: 'EMPLOYEES',
        scope: { cuis: ['100', '600'] },
        cohortMode: 'EACH_YEAR',
      })
    )._unsafeUnwrap();
    expect(s.points.find((p) => p.fiscalYear === 2023)).toMatchObject({
      filers: '2',
      available: false,
      gapReason: 'NOT_ADMITTED',
    });
    expect(s.points.find((p) => p.fiscalYear === 2021)).toMatchObject({
      available: true,
      metric: { sum: '3' },
    });
  });

  it('refuses REFERENCE_YEAR over NOT_FILED and a range outside the release', async () => {
    const { deps } = setup();
    expect(
      (
        await companyAnalysisSeries(deps, {
          scope: { filing: 'NOT_FILED' },
          cohortMode: 'REFERENCE_YEAR',
        })
      )._unsafeUnwrapErr()
    ).toMatchObject({ field: 'cohortMode' });
    expect(
      (await companyAnalysisSeries(deps, { fromYear: 2019 }))._unsafeUnwrapErr()
    ).toMatchObject({ field: 'fromYear' });
  });
});

describe('companyAnalysisRecords', () => {
  const pageThrough = async (
    deps: ReturnType<typeof setup>['deps'],
    input: Record<string, unknown>
  ) => {
    const cuis: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = (
        await companyAnalysisRecords(deps, {
          ...input,
          first: 2,
          ...(after !== undefined && { after }),
        })
      )._unsafeUnwrap();
      expect(page.totalCount).toBe('6');
      cuis.push(...page.edges.map((e) => e.node.cui));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor ?? undefined;
    }
    return cuis;
  };

  it('pages by money DESC with NULLS LAST and a cui tie-breaker', async () => {
    const { deps } = setup();
    expect(await pageThrough(deps, {})).toEqual(['100', '400', '200', '500', '300', '600']);
  });

  it('pages by money ASC with the same NULLS LAST tail', async () => {
    const { deps } = setup();
    expect(await pageThrough(deps, { direction: 'ASC' })).toEqual([
      '500',
      '200',
      '400',
      '100',
      '300',
      '600',
    ]);
  });

  it('pages by CUI', async () => {
    const { deps } = setup();
    expect(await pageThrough(deps, { sort: 'CUI' })).toEqual([
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
    ]);
  });

  it('hydrates current names and labels, and leaves non-filers without values', async () => {
    const { deps, labels } = setup();
    const page = (
      await companyAnalysisRecords(deps, { metrics: ['TURNOVER', 'EMPLOYEES'], first: 6 })
    )._unsafeUnwrap();
    const byCui = new Map(page.edges.map((e) => [e.node.cui, e.node]));
    expect(byCui.get('100')).toMatchObject({
      currentName: 'ALFA SRL',
      county: { code: 'CJ', label: 'Cluj' },
      uat: { code: '54975', label: 'Cluj-Napoca' },
      observedStatus: { code: '1048', label: 'funcțiune' },
      vatPayer: 'YES',
      filed: true,
      employeeSizeBand: 'FROM_10_TO_49',
      values: [
        { metric: 'TURNOVER', value: HUGE_TURNOVER, status: 'REPORTED' },
        { metric: 'EMPLOYEES', value: '12', status: 'REPORTED' },
      ],
    });
    expect(byCui.get('200')).toMatchObject({ currentName: null, vatPayer: 'UNKNOWN' });
    expect(byCui.get('300')?.values[0]).toEqual({
      metric: 'TURNOVER',
      value: null,
      status: 'HELD_OBSERVATION',
    });
    expect(byCui.get('600')).toMatchObject({
      filed: false,
      employeeSizeBand: null,
      values: [
        { metric: 'TURNOVER', value: null, status: null },
        { metric: 'EMPLOYEES', value: null, status: null },
      ],
    });
    // One batched name read per page.
    expect(labels.calls.filter((c) => c.startsWith('names:'))).toHaveLength(1);
  });

  it('rejects a cursor from another scope, sort, direction or release', async () => {
    const { deps } = setup();
    const first = (await companyAnalysisRecords(deps, { first: 2 }))._unsafeUnwrap();
    const after = first.pageInfo.endCursor;
    expect(after).not.toBeNull();
    for (const changed of [
      { scope: { county: { in: ['CJ'] } } },
      { scope: { fiscalYear: 2023 } },
      { sort: 'CUI' },
      { direction: 'ASC' },
      { sortMetric: 'EMPLOYEES' },
    ]) {
      const result = await companyAnalysisRecords(deps, { first: 2, after, ...changed });
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'after' });
    }
    const otherRelease = await companyAnalysisRecords(deps, { first: 2, after, release: '6' });
    expect(otherRelease._unsafeUnwrapErr().message).toContain('cursor belongs to release 7');
    const garbage = await companyAnalysisRecords(deps, { first: 2, after: 'not-a-cursor' });
    expect(garbage._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'after' });
  });

  it('caps the page size and the carried metrics', async () => {
    const { deps } = setup();
    expect((await companyAnalysisRecords(deps, { first: 101 }))._unsafeUnwrapErr()).toMatchObject({
      field: 'first',
    });
    const nine = await companyAnalysisRecords(deps, {
      sortMetric: 'TURNOVER',
      metrics: [
        'EMPLOYEES',
        'DEBTS',
        'RECEIVABLES',
        'CURRENT_ASSETS',
        'FIXED_ASSETS',
        'CASH_AND_BANK',
        'INVENTORIES',
        'TOTAL_EQUITY',
      ],
    });
    expect(nine._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'metrics' });
  });
});
