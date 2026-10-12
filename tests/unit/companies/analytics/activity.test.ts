/**
 * Companies analytics — the derived activity selection (schema
 * `companies-analytics-ch-v3`, CAEN contract §D): the release capability,
 * the typed refusal on a v2 release, the ACTIVITY breakdown (one bucket per
 * ONRC class key, ANAF codes apart, unclassified buckets never ranked, every
 * total exact), the activity filters and the record fields. Expected values
 * are written by hand from `ACTIVITY_DATASET`.
 */

import { describe, expect, it } from 'vitest';

import { parseScopeShape } from '@/modules/companies/core/analytics-scope.js';
import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
} from '@/modules/companies/core/analytics-usecases.js';

import {
  ACTIVITY_DATASET,
  DATASET,
  HUGE_TURNOVER,
  activity,
  analyticsDeps,
  company,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
  statement,
  reported,
  v3ReleaseRow,
  type FakeCompany,
} from './analytics-fixtures.js';

import type { CompanyAnalysisBucket } from '@/modules/companies/core/analytics-types.js';

const V2 = releaseRow(7, DATASET.companies, DATASET.statements);

const CATALOG = {
  'rev2:6201': 'Software (rev2)',
  'rev3:6201': 'Software (rev3)',
  'rev2:4711': 'Comerț cu amănuntul',
};

const v3Setup = (
  companies: readonly FakeCompany[] = ACTIVITY_DATASET.companies,
  catalog: Readonly<Record<string, string>> = CATALOG
) => {
  const engine = makeInMemoryEngine(companies, ACTIVITY_DATASET.statements, [9]);
  const labels = fakeLabels({}, catalog);
  const release = v3ReleaseRow(9, companies, ACTIVITY_DATASET.statements);
  return { engine, labels, deps: analyticsDeps(engine, fakeReleases(release), labels) };
};

const v2Setup = () => {
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
  return { engine, deps: analyticsDeps(engine, fakeReleases(V2)) };
};

const sumOf = (buckets: readonly CompanyAnalysisBucket[]): bigint =>
  buckets.reduce((acc, b) => {
    const sum = b.metric?.sum ?? null;
    return sum === null ? acc : acc + BigInt(sum.replace('.', ''));
  }, 0n);

const breakdownOf = async (args: Record<string, unknown> = {}) => {
  const { deps } = v3Setup();
  return (await companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', ...args }))._unsafeUnwrap();
};

describe('the ACTIVITY capability', () => {
  it('is listed for a v3 release only, with the derived-selection caveats', async () => {
    const v3 = (await companyAnalysisRelease(v3Setup().deps, {}))._unsafeUnwrap();
    expect(v3.schemaVersion).toBe('companies-analytics-ch-v3');
    expect(v3.dimensions.map((d) => d.dimension)).toContain('ACTIVITY');
    expect(v3.caveats.some((c) => c.includes('never a published principal or main activity'))).toBe(
      true
    );
    const v2 = (await companyAnalysisRelease(v2Setup().deps, {}))._unsafeUnwrap();
    expect(v2.dimensions.map((d) => d.dimension)).not.toContain('ACTIVITY');
    expect(v2.dimensions.map((d) => d.dimension)).toEqual([
      'COUNTY',
      'UAT',
      'MAIN_CAEN',
      'LEGAL_FORM',
      'OBSERVED_STATUS',
      'VAT_PAYER',
      'FISCALLY_INACTIVE',
      'EMPLOYEE_SIZE',
    ]);
  });

  it('states truthfully that the ANAF fiscal CAEN code has no published revision and is labelled only by CONSENSUS, never as a principal activity', async () => {
    const v2 = (await companyAnalysisRelease(v2Setup().deps, {}))._unsafeUnwrap();
    const caveat = v2.caveats.find((c) => c.startsWith('MAIN_CAEN (legacy name)'));
    expect(caveat).toContain('ANAF fiscal CAEN code');
    expect(caveat).toContain('never a published principal or main activity');
    expect(caveat).toContain('ANAF TVA publishes no revision');
    expect(caveat).toContain('CONSENSUS');
    expect(caveat).not.toContain('never mapped to a catalog');
    // No caveat claims ANAF publishes a main activity or its revision.
    expect(v2.caveats.join(' ')).not.toMatch(/ANAF main activity|keep their published revision/u);
    const mainCaen = v2.dimensions.find((d) => d.dimension === 'MAIN_CAEN');
    expect(mainCaen?.labelSource).toContain('CONSENSUS');
    expect(mainCaen?.labelSource).toContain('ANAF TVA publishes no revision');
    expect(mainCaen?.labelSource).not.toMatch(/main activity|when the ANAF revision is known/u);
  });

  it.each([
    [
      'the ACTIVITY dimension',
      (deps: ReturnType<typeof v2Setup>['deps']) =>
        companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY' }),
      'dimension',
    ],
    [
      'an activity filter on stats',
      (deps: ReturnType<typeof v2Setup>['deps']) =>
        companyAnalysisStats(deps, {
          scope: { activity: [{ source: 'ONRC', code: '6201', revision: 'rev2' }] },
        }),
      'scope.activity',
    ],
    [
      'an activityBasis filter on a breakdown',
      (deps: ReturnType<typeof v2Setup>['deps']) =>
        companyAnalysisBreakdown(deps, {
          dimension: 'COUNTY',
          scope: { activityBasis: ['ONRC_SINGLE_CLASS'] },
        }),
      'scope.activityBasis',
    ],
    [
      'an activity filter on a series',
      (deps: ReturnType<typeof v2Setup>['deps']) =>
        companyAnalysisSeries(deps, { scope: { activity: [{ source: 'ANAF', code: '6201' }] } }),
      'scope.activity',
    ],
    [
      'an activityBasis filter on records',
      (deps: ReturnType<typeof v2Setup>['deps']) =>
        companyAnalysisRecords(deps, { scope: { activityBasis: ['ANAF_FISCAL_CODE'] } }),
      'scope.activityBasis',
    ],
  ] as const)(
    'refuses %s on a v2 release with RELEASE_CAPABILITY_UNAVAILABLE before any engine work',
    async (_label, answer, field) => {
      const { engine, deps } = v2Setup();
      const error = (await answer(deps))._unsafeUnwrapErr();
      expect(error).toMatchObject({
        type: 'ReleaseCapabilityUnavailable',
        field,
        capability: 'ACTIVITY',
        releaseId: '7',
        schemaVersion: 'companies-analytics-ch-v2',
      });
      expect(engine.calls.filter((c) => c !== 'tablesAvailable:7')).toEqual([]);
    }
  );

  it('keeps every v2 answer exactly as before: no activity fields, empty unclassified', async () => {
    const { deps } = v2Setup();
    const breakdown = (
      await companyAnalysisBreakdown(deps, { dimension: 'MAIN_CAEN' })
    )._unsafeUnwrap();
    expect(breakdown.unclassified).toEqual([]);
    for (const bucket of [
      ...breakdown.groups,
      breakdown.other,
      breakdown.unknown,
      breakdown.totals,
    ]) {
      expect(bucket.activity).toBeNull();
      expect(bucket.activityQuality).toBeNull();
    }
    const records = (await companyAnalysisRecords(deps, { first: 100 }))._unsafeUnwrap();
    for (const { node } of records.edges) {
      expect(node).toMatchObject({
        activity: null,
        onrcClassKeyCount: null,
        onrcUnqualifiedRowCount: null,
        anafCaenForm: null,
        anafOnrcAgreement: null,
        anafStatusDate: null,
      });
    }
  });
});

describe('the ACTIVITY breakdown', () => {
  it('puts each company in exactly one bucket, ONRC keys by revision and ANAF codes apart', async () => {
    const b = await breakdownOf({ topN: 100 });
    expect(b.groups.map((g) => [g.key, g.companies, g.filers, g.metric?.sum])).toEqual([
      ['onrc:rev2:4711', '2', '2', '1000.00'],
      ['anaf:6201', '1', '1', '400.40'],
      // Same digits in two revisions and in ANAF: three buckets, never one.
      ['onrc:rev2:6201', '2', '2', '300.30'],
      ['onrc:rev3:6201', '1', '1', '300.30'],
    ]);
    expect(b.groupCount).toBe(4);
    expect(b.unclassified.map((g) => [g.key, g.companies, g.filers, g.metric?.sum])).toEqual([
      ['(onrc_multiple_classes)', '1', '1', '500.50'],
      // Every uncatalogued code in ONE bucket, never a named sector.
      ['(anaf_fiscal_uncatalogued)', '2', '2', HUGE_TURNOVER],
      ['(no_qualified_selection)', '1', '0', null],
    ]);
    expect(b.unknown.companies).toBe('0');
  });

  it('adds up exactly: groups + other + unknown + unclassified = totals = stats', async () => {
    const { deps } = v3Setup();
    const b = (
      await companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', topN: 2 })
    )._unsafeUnwrap();
    const stats = (await companyAnalysisStats(deps, {}))._unsafeUnwrap();
    const parts = [...b.groups, b.other, b.unknown, ...b.unclassified];
    const count = (field: 'companies' | 'filers') =>
      parts.reduce((acc, bucket) => acc + BigInt(bucket[field]), 0n).toString();
    expect(count('companies')).toBe(b.totals.companies);
    expect(count('filers')).toBe(b.totals.filers);
    expect(sumOf(parts)).toBe(sumOf([b.totals]));
    expect(b.totals.companies).toBe(stats.companies);
    expect(b.totals.filers).toBe(stats.filers);
    expect(b.totals.metric?.sum).toBe(stats.metrics[0]?.sum);
    expect(b.totals.metric?.sum).toBe('9007199254743494.57');
    expect(b.other.companies).toBe('3');
    expect(b.other.groups).toBe(2);
    expect(b.totals.groups).toBe(4 + 3 + 1);
    // The unclassified buckets are never ranked away into `other`.
    expect(b.unclassified).toHaveLength(3);
  });

  it('states the bucket basis, source, revision and quality; ANAF never carries a revision', async () => {
    const b = await breakdownOf({ topN: 100 });
    const byKey = (key: string) => [...b.groups, ...b.unclassified].find((g) => g.key === key)!;
    // Mixed single-class and numeric-match selections: no single basis.
    expect(byKey('onrc:rev2:6201').activity).toMatchObject({
      basis: null,
      source: 'ONRC',
      revision: 'rev2',
      code: '6201',
      derived: true,
    });
    expect(byKey('onrc:rev2:6201').activityQuality).toEqual({
      numericMatchSelected: '1',
      incompleteCoverage: '0',
      withUnqualifiedRows: '1',
      anafObservedFrom: '2026-09-01',
      anafObservedTo: '2026-09-28',
    });
    expect(byKey('onrc:rev3:6201').activity?.basis).toBe('ONRC_SINGLE_CLASS');
    expect(byKey('onrc:rev2:4711').activityQuality).toMatchObject({
      numericMatchSelected: '1',
      incompleteCoverage: '1',
    });
    expect(byKey('anaf:6201').activity).toMatchObject({
      basis: 'ANAF_FISCAL_CODE',
      source: 'ANAF',
      revision: null,
      code: '6201',
    });
    expect(byKey('(anaf_fiscal_uncatalogued)').activity).toEqual({
      basis: 'ANAF_FISCAL_UNCATALOGUED',
      source: 'ANAF',
      code: null,
      revision: null,
      label: null,
      descriptionStatus: null,
      descriptions: [],
      derived: true,
    });
    expect(byKey('(onrc_multiple_classes)').activity).toMatchObject({ source: null, code: null });
    expect(byKey('(no_qualified_selection)').activityQuality).toEqual({
      numericMatchSelected: '0',
      incompleteCoverage: '1',
      withUnqualifiedRows: '1',
      anafObservedFrom: null,
      anafObservedTo: null,
    });
    for (const bucket of [...b.groups, ...b.unclassified]) {
      if (bucket.activity?.source === 'ANAF') expect(bucket.activity.revision).toBeNull();
      expect(bucket.caen).toBeNull();
      expect(bucket.label === null || bucket.activity?.source !== null).toBe(true);
    }
    expect(b.totals.activityQuality).toEqual({
      numericMatchSelected: '2',
      incompleteCoverage: '2',
      withUnqualifiedRows: '2',
      anafObservedFrom: '2026-07-01',
      anafObservedTo: '2026-09-28',
    });
  });

  it('labels ONRC buckets EXACTLY by (revision, code) and ANAF buckets by candidates only', async () => {
    const b = await breakdownOf({ topN: 100 });
    const byKey = (key: string) => b.groups.find((g) => g.key === key);
    expect(byKey('onrc:rev2:6201')).toMatchObject({
      label: 'Software (rev2)',
      labelSource: 'current_db_catalog',
      activity: {
        label: 'Software (rev2)',
        descriptionStatus: 'EXACT',
        descriptions: [{ revision: 'rev2', label: 'Software (rev2)' }],
      },
    });
    expect(byKey('onrc:rev3:6201')?.activity?.label).toBe('Software (rev3)');
    // ANAF 6201: two revisions, two texts: CONFLICT, no scalar label.
    expect(byKey('anaf:6201')).toMatchObject({
      label: null,
      labelSource: null,
      activity: { label: null, descriptionStatus: 'CONFLICT' },
    });
    const { deps } = v3Setup(ACTIVITY_DATASET.companies, {
      'rev2:6201': 'Software',
      'rev3:6201': 'Software',
    });
    const consensus = (
      await companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', topN: 100 })
    )._unsafeUnwrap();
    expect(consensus.groups.find((g) => g.key === 'anaf:6201')?.activity).toMatchObject({
      label: 'Software',
      descriptionStatus: 'CONSENSUS',
      revision: null,
    });
  });

  it('ranks only classified buckets, even when an unclassified one is the largest', async () => {
    const b = await breakdownOf({ topN: 1, rankBy: 'COMPANIES' });
    expect(b.groups.map((g) => g.key)).toEqual(['onrc:rev2:4711']);
    expect(b.unclassified.map((g) => g.key)).toEqual([
      '(onrc_multiple_classes)',
      '(anaf_fiscal_uncatalogued)',
      '(no_qualified_selection)',
    ]);
  });

  it('refuses an ANAF bucket that carries a revision as a release invariant', async () => {
    const broken = ACTIVITY_DATASET.companies.map((c) =>
      c.cui === '1004'
        ? { ...c, activity: activity({ basis: 'anaf_fiscal_code', rev: 'rev2' }) }
        : c
    );
    const { deps } = v3Setup(broken);
    const error = (
      await companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY' })
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'Database' });
    expect(error.message).toContain('ANAF activity group carries a revision');
  });

  it('refuses an activity basis outside the release vocabulary', async () => {
    const broken = ACTIVITY_DATASET.companies.map((c) =>
      c.cui === '1005' ? { ...c, activity: activity({ basis: 'principal', rev: null }) } : c
    );
    const { deps } = v3Setup(broken);
    expect(
      (await companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY' }))._unsafeUnwrapErr()
    ).toMatchObject({ type: 'Database' });
  });
});

describe('the activity filters', () => {
  const companiesOf = async (scope: Record<string, unknown>) => {
    const { deps } = v3Setup();
    return (await companyAnalysisRecords(deps, { scope, sort: 'CUI', first: 100 }))
      ._unsafeUnwrap()
      .edges.map((e) => e.node.cui);
  };

  it('an ONRC selector matches only ONRC selections of that exact revision and code', async () => {
    expect(
      await companiesOf({ activity: [{ source: 'ONRC', code: '6201', revision: 'rev2' }] })
    ).toEqual(['1001', '1002']);
    expect(
      await companiesOf({ activity: [{ source: 'ONRC', code: '6201', revision: 'rev3' }] })
    ).toEqual(['1003']);
  });

  it('an ANAF selector matches only ANAF_FISCAL_CODE companies, never an ONRC one', async () => {
    expect(await companiesOf({ activity: [{ source: 'ANAF', code: '6201' }] })).toEqual(['1004']);
    // An uncatalogued code is not an ANAF_FISCAL_CODE selection.
    expect(await companiesOf({ activity: [{ source: 'ANAF', code: '1234' }] })).toEqual([]);
  });

  it('filters by basis, and the drilled bucket equals the breakdown bucket', async () => {
    expect(await companiesOf({ activityBasis: ['ANAF_FISCAL_UNCATALOGUED'] })).toEqual([
      '1006',
      '1007',
    ]);
    const { deps } = v3Setup();
    const drilled = (
      await companyAnalysisStats(deps, {
        scope: { activity: [{ source: 'ONRC', code: '4711', revision: 'rev2' }] },
      })
    )._unsafeUnwrap();
    expect([drilled.companies, drilled.filers, drilled.metrics[0]?.sum]).toEqual([
      '2',
      '2',
      '1000.00',
    ]);
  });

  it.each([
    [{ activity: [{ source: 'ONRC', code: '6201' }] }, 'ONRC selectors need revision'],
    [{ activity: [{ source: 'ANAF', code: '6201', revision: 'rev2' }] }, 'take no revision'],
    [{ activity: [{ source: 'ONRC', code: '62', revision: 'rev2' }] }, '4-digit'],
    [{ activity: [{ source: 'ONRC', code: '6201', revision: 'rev9' }] }, 'rev0..rev3'],
    [{ activity: [{ source: 'INS', code: '6201' }] }, 'source must be one of'],
    [{ activityBasis: ['PRINCIPAL'] }, 'activityBasis values must be one of'],
    [{ activity: [] }, 'must not be empty'],
  ])('refuses the malformed scope %j', (scope, message) => {
    const error = parseScopeShape(scope)._unsafeUnwrapErr();
    expect(error.type).toBe('InvalidInput');
    expect(error.message).toContain(message);
  });

  it('echoes the activity filters canonically (sorted, de-duplicated, no ANAF revision)', async () => {
    const { deps } = v3Setup();
    const stats = (
      await companyAnalysisStats(deps, {
        scope: {
          activityBasis: ['ANAF_FISCAL_CODE', 'ONRC_SINGLE_CLASS'],
          activity: [
            { source: 'ONRC', code: '6201', revision: 'rev2' },
            { source: 'ANAF', code: '6201' },
            { source: 'ONRC', code: '6201', revision: 'rev2' },
          ],
        },
      })
    )._unsafeUnwrap();
    expect(stats.scope).toEqual({
      fiscalYear: 2024,
      activity: [
        { source: 'ANAF', code: '6201' },
        { source: 'ONRC', code: '6201', revision: 'rev2' },
      ],
      activityBasis: ['ONRC_SINGLE_CLASS', 'ANAF_FISCAL_CODE'],
    });
  });
});

describe('the v3 record fields', () => {
  const nodes = async (companies: readonly FakeCompany[] = ACTIVITY_DATASET.companies) => {
    const { deps } = v3Setup(companies);
    return new Map(
      (await companyAnalysisRecords(deps, { sort: 'CUI', first: 100 }))
        ._unsafeUnwrap()
        .edges.map((e) => [e.node.cui, e.node])
    );
  };

  it('carries the derived activity with its evidence, labelled per source', async () => {
    const byCui = await nodes();
    expect(byCui.get('1002')).toMatchObject({
      activity: {
        basis: 'ONRC_CLASS_ANAF_NUMERIC_MATCH',
        source: 'ONRC',
        code: '6201',
        revision: 'rev2',
        label: 'Software (rev2)',
        descriptionStatus: 'EXACT',
        derived: true,
      },
      onrcClassKeyCount: 2,
      onrcUnqualifiedRowCount: 1,
      anafCaenForm: 'four_digit',
      anafOnrcAgreement: 'match_one_key',
      anafStatusDate: '2026-09-28',
    });
    expect(byCui.get('1004')?.activity).toMatchObject({
      basis: 'ANAF_FISCAL_CODE',
      source: 'ANAF',
      revision: null,
      label: null,
      descriptionStatus: 'CONFLICT',
    });
    expect(byCui.get('1006')?.activity).toEqual({
      basis: 'ANAF_FISCAL_UNCATALOGUED',
      source: 'ANAF',
      code: '1234',
      revision: null,
      label: null,
      descriptionStatus: null,
      descriptions: [],
      derived: true,
    });
    expect(byCui.get('1008')).toMatchObject({
      activity: { basis: 'NO_QUALIFIED_SELECTION', source: null, code: null },
      anafCaenForm: 'short',
      anafOnrcAgreement: 'anaf_not_usable',
      anafStatusDate: null,
    });
  });

  it('serves a three_digit ANAF form exactly as the release wrote it', async () => {
    const companies = ACTIVITY_DATASET.companies.map((c) =>
      c.cui === '1008'
        ? {
            ...c,
            activity: activity({
              basis: 'no_qualified_selection',
              rev: null,
              code: null,
              form: 'three_digit',
            }),
          }
        : c
    );
    expect((await nodes(companies)).get('1008')?.anafCaenForm).toBe('three_digit');
  });

  it('refuses a record whose revision disagrees with its basis', async () => {
    const companies = [
      company('2001', { activity: activity({ basis: 'onrc_single_class', rev: null }) }),
    ];
    const engine = makeInMemoryEngine(
      companies,
      [statement(2024, '2001', { TURNOVER: reported('1.00') })],
      [9]
    );
    const deps = analyticsDeps(
      engine,
      fakeReleases(
        v3ReleaseRow(9, companies, [statement(2024, '2001', { TURNOVER: reported('1.00') })])
      )
    );
    expect((await companyAnalysisRecords(deps, { first: 10 }))._unsafeUnwrapErr()).toMatchObject({
      type: 'Database',
    });
  });
});
