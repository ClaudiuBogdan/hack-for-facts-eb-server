/**
 * Companies analytics — the STAGED v4 `MAIN_ACTIVITY` capability (the
 * ANAF-assumed main activity): explicit per-schema dimension lists (v2/v3
 * never advertise a dimension added later), the typed refusal on v2 AND v3
 * before any engine work (the ACTIVITY capability of a v3 release never
 * skips the MAIN_ACTIVITY check), the scope filters (exact revision-
 * qualified keys only), the v4 main pin, and a v4 release still refused as
 * staged. Legacy ACTIVITY / MAIN_CAEN / onrc behaviour is unchanged.
 */

import { describe, expect, it } from 'vitest';

import {
  parseMainCaenPin,
  parseRelease,
  requireCapabilities,
} from '@/modules/companies/core/analytics-release.js';
import { canonicalScope, parseScopeShape } from '@/modules/companies/core/analytics-scope.js';
import {
  COMPANY_ANALYSIS_DIMENSIONS_BY_SCHEMA,
  type CompanyAnalysisRelease,
  type CompanyAnalysisScope,
} from '@/modules/companies/core/analytics-types.js';
import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
} from '@/modules/companies/core/analytics-usecases.js';
import {
  MAIN_ACTIVITY_STAGED_MESSAGE,
  makeClickhouseAnalyticsEngine,
} from '@/modules/companies/shell/analytics/clickhouse-engine.js';

import {
  ACTIVITY_DATASET,
  DATASET,
  SOURCE_PIN,
  analyticsDeps,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
  v3ReleaseRow,
} from './analytics-fixtures.js';

import type { ClickhouseReader } from '@/modules/companies/shell/analytics/clickhouse-reader.js';

const DATABASE = 'companies_analytics';

const v2 = () => {
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]);
  return {
    engine,
    deps: analyticsDeps(engine, fakeReleases(releaseRow(7, DATASET.companies, DATASET.statements))),
  };
};
const v3 = () => {
  const engine = makeInMemoryEngine(ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements, [9]);
  return {
    engine,
    deps: analyticsDeps(
      engine,
      fakeReleases(v3ReleaseRow(9, ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements))
    ),
  };
};

const releaseOf = (row: ReturnType<typeof releaseRow>): CompanyAnalysisRelease =>
  parseRelease(row, DATABASE)._unsafeUnwrap();

const V2_DIMENSIONS = [
  'COUNTY',
  'UAT',
  'MAIN_CAEN',
  'LEGAL_FORM',
  'OBSERVED_STATUS',
  'VAT_PAYER',
  'FISCALLY_INACTIVE',
  'EMPLOYEE_SIZE',
];

describe('explicit per-schema capabilities', () => {
  it('v2 lists exactly its eight dimensions, v3 adds ACTIVITY only; neither lists MAIN_ACTIVITY', async () => {
    const two = (await companyAnalysisRelease(v2().deps, {}))._unsafeUnwrap();
    const three = (await companyAnalysisRelease(v3().deps, {}))._unsafeUnwrap();
    expect(two.dimensions.map((d) => d.dimension)).toEqual(V2_DIMENSIONS);
    expect(three.dimensions.map((d) => d.dimension)).toEqual([...V2_DIMENSIONS, 'ACTIVITY']);
    expect(two.mainCaen).toBeNull();
    expect(three.mainCaen).toBeNull();
    expect(three.caveats.join(' ')).not.toContain('MAIN_ACTIVITY');
  });

  it('the v4 list is the v3 list plus MAIN_ACTIVITY (prepared, not served)', () => {
    expect(COMPANY_ANALYSIS_DIMENSIONS_BY_SCHEMA['companies-analytics-ch-v4']).toEqual([
      ...V2_DIMENSIONS,
      'ACTIVITY',
      'MAIN_ACTIVITY',
    ]);
  });

  it('a v4 release is refused as staged, never served under guessed columns', () => {
    const row = releaseRow(11, DATASET.companies, DATASET.statements, {
      schemaVersion: 'companies-analytics-ch-v4',
      inputs: {
        frontier: [],
        onrc: SOURCE_PIN,
        mainCaen: {
          contentEpoch: '4',
          refreshId: '17',
          policy: 'anaf-assumed-main-caen-v1',
          editionId: SOURCE_PIN.editionId,
        },
      },
    });
    const reason = parseRelease(row, DATABASE)._unsafeUnwrapErr();
    expect(reason).toContain('staged');
    expect(reason).toContain('companies-analytics-ch-v2, companies-analytics-ch-v3');
  });
});

describe('requireCapabilities', () => {
  const scope = (over: Partial<CompanyAnalysisScope> = {}): CompanyAnalysisScope => ({
    fiscalYear: 2024,
    ...over,
  });
  const v3Release = releaseOf(
    v3ReleaseRow(9, ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements)
  );
  const v2Release = releaseOf(releaseRow(7, DATASET.companies, DATASET.statements));

  it('a v3 release (which offers ACTIVITY) still refuses MAIN_ACTIVITY and the main filters', () => {
    expect(
      requireCapabilities(v3Release, scope(), 'MAIN_ACTIVITY')._unsafeUnwrapErr()
    ).toMatchObject({
      capability: 'MAIN_ACTIVITY',
      field: 'dimension',
      schemaVersion: 'companies-analytics-ch-v3',
    });
    expect(
      requireCapabilities(
        v3Release,
        scope({ mainActivity: [{ revision: 'rev3', code: '4711' }] })
      )._unsafeUnwrapErr()
    ).toMatchObject({ capability: 'MAIN_ACTIVITY', field: 'scope.mainActivity' });
    expect(
      requireCapabilities(v3Release, scope({ mainActivityStatus: ['RESOLVED'] }))._unsafeUnwrapErr()
    ).toMatchObject({ capability: 'MAIN_ACTIVITY', field: 'scope.mainActivityStatus' });
    // ACTIVITY itself stays answered on v3.
    expect(requireCapabilities(v3Release, scope(), 'ACTIVITY').isOk()).toBe(true);
  });

  it('a v2 release refuses both capabilities by name; legacy dimensions pass', () => {
    expect(
      requireCapabilities(v2Release, scope(), 'MAIN_ACTIVITY')._unsafeUnwrapErr()
    ).toMatchObject({ capability: 'MAIN_ACTIVITY' });
    expect(requireCapabilities(v2Release, scope(), 'ACTIVITY')._unsafeUnwrapErr()).toMatchObject({
      capability: 'ACTIVITY',
    });
    expect(requireCapabilities(v2Release, scope(), 'MAIN_CAEN').isOk()).toBe(true);
  });

  it('the refusal never suggests another question as the answer', () => {
    const message = requireCapabilities(v3Release, scope(), 'MAIN_ACTIVITY')._unsafeUnwrapErr()
      .message;
    expect(message).toContain('never the ANAF-assumed main activity');
  });
});

describe('MAIN_ACTIVITY on every shape is refused before any engine work', () => {
  it.each([
    [
      'a MAIN_ACTIVITY breakdown',
      (d: ReturnType<typeof v3>['deps']) =>
        companyAnalysisBreakdown(d, { dimension: 'MAIN_ACTIVITY' }),
      'dimension',
    ],
    [
      'a mainActivity filter on stats',
      (d: ReturnType<typeof v3>['deps']) =>
        companyAnalysisStats(d, { scope: { mainActivity: [{ revision: 'rev2', code: '0610' }] } }),
      'scope.mainActivity',
    ],
    [
      'a mainActivityStatus filter on a series',
      (d: ReturnType<typeof v3>['deps']) =>
        companyAnalysisSeries(d, { scope: { mainActivityStatus: ['NO_ONRC_MATCH'] } }),
      'scope.mainActivityStatus',
    ],
    [
      'a mainActivity filter on records',
      (d: ReturnType<typeof v3>['deps']) =>
        companyAnalysisRecords(d, {
          scope: { mainActivity: [{ revision: 'rev3', code: '4711' }] },
        }),
      'scope.mainActivity',
    ],
  ] as const)('%s on a v3 release', async (_label, answer, field) => {
    const { engine, deps } = v3();
    const error = (await answer(deps))._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: 'ReleaseCapabilityUnavailable',
      capability: 'MAIN_ACTIVITY',
      field,
      releaseId: '9',
      schemaVersion: 'companies-analytics-ch-v3',
    });
    expect(engine.calls.filter((c) => c !== 'tablesAvailable:9')).toEqual([]);
  });

  it('a MAIN_ACTIVITY breakdown on a v2 release names MAIN_ACTIVITY, not ACTIVITY', async () => {
    const { engine, deps } = v2();
    const error = (
      await companyAnalysisBreakdown(deps, { dimension: 'MAIN_ACTIVITY' })
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      capability: 'MAIN_ACTIVITY',
      schemaVersion: 'companies-analytics-ch-v2',
    });
    expect(engine.calls.filter((c) => c !== 'tablesAvailable:7')).toEqual([]);
  });
});

describe('scope.mainActivity / mainActivityStatus', () => {
  it('accepts exact revision-qualified keys, de-duplicated and sorted, and echoes them', () => {
    const shape = parseScopeShape({
      mainActivity: [
        { revision: 'rev3', code: '4711' },
        { revision: 'rev2', code: '0610' },
        { revision: 'rev3', code: '4711' },
      ],
      mainActivityStatus: ['NO_ONRC_MATCH', 'RESOLVED'],
    })._unsafeUnwrap();
    expect(shape.mainActivity).toEqual([
      { revision: 'rev2', code: '0610' },
      { revision: 'rev3', code: '4711' },
    ]);
    // Vocabulary order.
    expect(shape.mainActivityStatus).toEqual(['RESOLVED', 'NO_ONRC_MATCH']);
    expect(canonicalScope({ ...shape, fiscalYear: 2024 })).toMatchObject({
      mainActivity: [
        { revision: 'rev2', code: '0610' },
        { revision: 'rev3', code: '4711' },
      ],
      mainActivityStatus: ['RESOLVED', 'NO_ONRC_MATCH'],
    });
  });

  it.each([
    ['a bare code', [{ code: '4711' }]],
    ['an ANAF-style selector', [{ source: 'ANAF', code: '4711' }]],
    ['an unknown revision', [{ revision: 'rev4', code: '4711' }]],
    ['a short code', [{ revision: 'rev2', code: '610' }]],
    ['non-ASCII digits', [{ revision: 'rev2', code: '٠٦١٠' }]],
    ['an empty list', []],
    ['a non-list', { revision: 'rev2', code: '0610' }],
  ])('refuses %s', (_label, mainActivity) => {
    const error = parseScopeShape({ mainActivity })._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'InvalidInput', field: 'scope.mainActivity' });
  });

  it('refuses an unknown status', () => {
    expect(parseScopeShape({ mainActivityStatus: ['MAIN'] })._unsafeUnwrapErr()).toMatchObject({
      field: 'scope.mainActivityStatus',
    });
  });

  it('a legacy scope keeps its exact canonical echo (saved links and cursors unchanged)', () => {
    const shape = parseScopeShape({
      activity: [{ source: 'ONRC', code: '4711', revision: 'rev2' }],
      mainCaen: [{ code: '4711' }],
    })._unsafeUnwrap();
    expect(Object.keys(canonicalScope({ ...shape, fiscalYear: 2024 }))).toEqual([
      'fiscalYear',
      'mainCaen',
      'activity',
    ]);
  });
});

describe('the v4 main pin', () => {
  const pin = {
    contentEpoch: '4',
    refreshId: '17',
    policy: 'anaf-assumed-main-caen-v1',
    editionId: '7',
  };

  it('accepts exactly the four keys bound to the source edition', () => {
    expect(parseMainCaenPin(pin, '7')._unsafeUnwrap()).toEqual(pin);
    expect(parseMainCaenPin({ ...pin, contentEpoch: '0' }, '7').isOk()).toBe(true);
  });

  it.each([
    ['a missing pin', undefined],
    ['an extra key', { ...pin, epoch: '9' }],
    ['a missing key', { contentEpoch: '4', refreshId: '17', policy: pin.policy }],
    ['a numeric id', { ...pin, refreshId: 17 }],
    ['a leading-zero epoch', { ...pin, contentEpoch: '04' }],
    ['another policy', { ...pin, policy: 'anaf-assumed-main-caen-v2' }],
    ['another edition', { ...pin, editionId: '8' }],
  ])('refuses %s', (_label, raw) => {
    expect(parseMainCaenPin(raw, '7').isErr()).toBe(true);
  });
});

describe('the engine fails closed on MAIN_ACTIVITY if ever reached', () => {
  const reader: ClickhouseReader = {
    query: () => {
      throw new Error('no query may run');
    },
    close: () => undefined,
  };
  const engine = makeClickhouseAnalyticsEngine(reader, DATABASE);

  it('refuses the dimension and every main filter without querying', async () => {
    const scope: CompanyAnalysisScope = { fiscalYear: 2024 };
    const main: CompanyAnalysisScope = { fiscalYear: 2024, mainActivityStatus: ['RESOLVED'] };
    for (const result of [
      await engine.breakdown(9, scope, 'MAIN_ACTIVITY', 'TURNOVER'),
      await engine.countPopulation(9, main),
      await engine.aggregateFilers(9, main, ['TURNOVER']),
    ]) {
      expect(result._unsafeUnwrapErr().message).toBe(MAIN_ACTIVITY_STAGED_MESSAGE);
    }
  });
});
