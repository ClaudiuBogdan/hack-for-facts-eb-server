/**
 * Companies analytics unit tests — the release-aware CAEN filter disclosure
 * (CQA-15). A v3 release's ONRC CAEN filters test qualified class observations
 * only; a v2 release exported every observed code. Either way an exclusion
 * needs complete CAEN coverage. Every answer a CAEN filter shapes says which
 * rule applied; answers without one carry neither disclosure.
 */

import { describe, expect, it } from 'vitest';

import {
  CAEN_CLASS_FILTER_CAVEAT,
  CAEN_OBSERVATION_FILTER_CAVEAT_V2,
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisSeries,
  companyAnalysisStats,
} from '@/modules/companies/core/analytics-usecases.js';

import {
  ACTIVITY_DATASET,
  DATASET,
  analyticsDeps,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
  v3ReleaseRow,
} from './analytics-fixtures.js';

const v2Deps = () =>
  analyticsDeps(
    makeInMemoryEngine(DATASET.companies, DATASET.statements, [7]),
    fakeReleases(releaseRow(7, DATASET.companies, DATASET.statements)),
    fakeLabels()
  );

const v3Deps = () =>
  analyticsDeps(
    makeInMemoryEngine(ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements, [9]),
    fakeReleases(v3ReleaseRow(9, ACTIVITY_DATASET.companies, ACTIVITY_DATASET.statements)),
    fakeLabels()
  );

const caveatsOf = async (
  deps: ReturnType<typeof v2Deps>,
  scope: Record<string, unknown>
): Promise<string[][]> =>
  [
    (await companyAnalysisStats(deps, { scope }))._unsafeUnwrap().caveats,
    (
      await companyAnalysisBreakdown(deps, {
        scope,
        dimension: 'COUNTY',
        topN: 10,
        metric: 'TURNOVER',
      })
    )._unsafeUnwrap().caveats,
    (await companyAnalysisSeries(deps, { scope }))._unsafeUnwrap().caveats,
    (await companyAnalysisRecords(deps, { scope, sort: 'CUI', first: 10 }))._unsafeUnwrap().caveats,
  ].map((caveats) => [...caveats]);

const CAEN_SCOPES = [
  ['a positive broad code', { onrc: { caenCode: ['6201'] } }],
  ['an exact key', { onrc: { onrcCaen: ['rev2:6201'] } }],
  ['a CAEN exclusion', { onrc: { exclude: { caenCode: ['0201'] } } }],
] as const;

const OTHER_SCOPES = [
  ['no scope', {}],
  ['a status-only ONRC filter', { onrc: { status: ['1048'], exclude: { status: ['1070'] } } }],
] as const;

describe('the CAEN filter disclosure on analytics answers (CQA-15)', () => {
  it.each(CAEN_SCOPES)(
    'v3, %s: every answer discloses the class-only rule once',
    async (_n, scope) => {
      for (const caveats of await caveatsOf(v3Deps(), scope)) {
        expect(caveats.filter((c) => c === CAEN_CLASS_FILTER_CAVEAT)).toHaveLength(1);
        expect(caveats).not.toContain(CAEN_OBSERVATION_FILTER_CAVEAT_V2);
      }
    }
  );

  it.each(CAEN_SCOPES)(
    'v2, %s: every answer discloses the every-observation rule once',
    async (_n, scope) => {
      for (const caveats of await caveatsOf(v2Deps(), scope)) {
        expect(caveats.filter((c) => c === CAEN_OBSERVATION_FILTER_CAVEAT_V2)).toHaveLength(1);
        expect(caveats).not.toContain(CAEN_CLASS_FILTER_CAVEAT);
      }
    }
  );

  it.each(OTHER_SCOPES)('%s: no CAEN disclosure in either release', async (_n, scope) => {
    for (const deps of [v2Deps(), v3Deps()]) {
      for (const caveats of await caveatsOf(deps, scope)) {
        expect(caveats).not.toContain(CAEN_CLASS_FILTER_CAVEAT);
        expect(caveats).not.toContain(CAEN_OBSERVATION_FILTER_CAVEAT_V2);
      }
    }
  });

  it('separates not matching a class from passing the coverage gate', () => {
    expect(CAEN_CLASS_FILTER_CAVEAT).toContain('qualified class observations only');
    expect(CAEN_CLASS_FILTER_CAVEAT).toContain(
      'unparsed or unknown-revision observation makes coverage partial'
    );
    expect(CAEN_CLASS_FILTER_CAVEAT).toContain(
      'not proof that no source observation or activity exists'
    );
    expect(CAEN_OBSERVATION_FILTER_CAVEAT_V2).toContain(
      'unknown revision and unqualified tokens included'
    );
  });
});
