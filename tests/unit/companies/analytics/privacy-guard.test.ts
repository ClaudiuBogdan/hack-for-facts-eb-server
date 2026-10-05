/**
 * The privacy-epoch guard on every companies analytics answer: one fresh
 * reading before any engine work and one just before the answer leaves; a
 * withdrawal (epoch bump), an unreadable state, a replica or a fixed snapshot
 * answers a controlled error with no figures — never filtered rows, never
 * another release, and never bypassed by cached release/engine/label results.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisRelease,
  companyAnalysisSeries,
  companyAnalysisStats,
  confirmServedAnalysis,
  type CompanyAnalysisContext,
} from '@/modules/companies/core/analytics-usecases.js';
import { makeClickhouseAnalyticsEngine } from '@/modules/companies/shell/analytics/clickhouse-engine.js';
import { makeClickhouseReader } from '@/modules/companies/shell/analytics/clickhouse-reader.js';

import {
  DATASET,
  analyticsDeps,
  currentPublication,
  fakeLabels,
  fakePrivacy,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow,
  type FakePrivacy,
} from './analytics-fixtures.js';

import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

const ACTIVE = releaseRow(7, DATASET.companies, DATASET.statements);
const HISTORICAL = releaseRow(6, DATASET.companies, DATASET.statements);

const setup = (privacy: FakePrivacy = fakePrivacy(), active = ACTIVE, retained = [7, 6]) => {
  const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, retained);
  const releases = fakeReleases(active, [HISTORICAL], privacy);
  const labels = fakeLabels({ '100': 'ALFA SRL' });
  return { engine, releases, labels, privacy, deps: analyticsDeps(engine, releases, labels) };
};

type Answer = (
  ctx: CompanyAnalysisContext,
  extra: Record<string, unknown>
) => Promise<Result<unknown, ApiError>>;

const ANSWERS: readonly (readonly [string, Answer])[] = [
  ['companyAnalysisRelease', (ctx, extra) => companyAnalysisRelease(ctx, extra)],
  ['companyAnalysisStats', (ctx, extra) => companyAnalysisStats(ctx, extra)],
  [
    'companyAnalysisBreakdown',
    (ctx, extra) => companyAnalysisBreakdown(ctx, { dimension: 'COUNTY', ...extra }),
  ],
  ['companyAnalysisSeries', (ctx, extra) => companyAnalysisSeries(ctx, extra)],
  ['companyAnalysisRecords', (ctx, extra) => companyAnalysisRecords(ctx, extra)],
];

describe('privacy epoch guard on every answer', () => {
  it.each(ANSWERS)(
    '%s checks the current epoch before any engine call and again after every read',
    async (_name, answer) => {
      const s = setup();
      const seen: { engine: number; labels: number }[] = [];
      s.privacy.beforeRead = () => {
        seen.push({ engine: s.engine.calls.length, labels: s.labels.calls.length });
      };
      const result = await answer(s.deps, {});
      expect(result.isOk()).toBe(true);
      expect(s.privacy.reads).toBe(2);
      // First reading: nothing has touched the engine (not even the table probe).
      expect(seen[0]).toEqual({ engine: 0, labels: 0 });
      // Last reading: after every engine and label read of the answer.
      expect(seen[1]).toEqual({ engine: s.engine.calls.length, labels: s.labels.calls.length });
    }
  );

  it.each(ANSWERS)(
    '%s: a withdrawal makes the active release unavailable, with no engine work',
    async (_name, answer) => {
      const s = setup(fakePrivacy({ epoch: '1' }));
      const error = (await answer(s.deps, {}))._unsafeUnwrapErr();
      expect(error).toEqual({
        type: 'ServiceUnavailable',
        message:
          'the active companies analytics release was withdrawn after a privacy change; retry once a refreshed release is published',
      });
      expect(s.engine.calls).toEqual([]);
      expect(s.labels.calls).toEqual([]);
    }
  );

  it.each(ANSWERS)(
    '%s: a pinned release withdrawn after a privacy change is a release error',
    async (_name, answer) => {
      for (const pin of ['7', '6']) {
        const s = setup(fakePrivacy({ epoch: '3' }));
        const error = (await answer(s.deps, { release: pin }))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: 'InvalidInput', field: 'release' });
        expect(error.message).toContain(`release ${pin} was withdrawn after a privacy change`);
        expect(s.engine.calls).toEqual([]);
      }
    }
  );

  it.each(ANSWERS)(
    '%s: a withdrawal while the answer is computed returns no figures',
    async (_name, answer) => {
      const s = setup();
      s.privacy.beforeRead = (index) => {
        if (index === 1) s.privacy.epoch = '1';
      };
      const result = await answer(s.deps, {});
      expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      // The work did run; its result was discarded at the linearization point.
      expect(s.engine.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('9007199254741973.32');
    }
  );

  it.each([
    ['a replica', { inRecovery: true }],
    ['a REPEATABLE READ snapshot', { isolation: 'repeatable read' }],
    ['a SERIALIZABLE snapshot', { isolation: 'serializable' }],
    ['an unreadable state', { fail: true }],
    ['a negative epoch', { epoch: '-1' }],
    ['a non-canonical epoch', { epoch: '01' }],
    ['an empty epoch', { epoch: '' }],
  ])('refuses to answer from %s, without driver detail', async (_label, over) => {
    for (const [, answer] of ANSWERS) {
      const s = setup(fakePrivacy(over));
      const error = (await answer(s.deps, {}))._unsafeUnwrapErr();
      expect(error).toEqual({
        type: 'ServiceUnavailable',
        message: 'companies analytics cannot confirm the current privacy state; retry later',
      });
      expect(JSON.stringify(error)).not.toContain('ECONNREFUSED');
      expect(s.engine.calls).toEqual([]);
    }
  });

  it('serves the refreshed release while old pins stay withdrawn', async () => {
    const refreshed = releaseRow(8, DATASET.companies, DATASET.statements, { privacyEpoch: '1' });
    const s = setup(fakePrivacy({ epoch: '1' }), refreshed, [8, 7, 6]);
    expect((await companyAnalysisStats(s.deps, {}))._unsafeUnwrap().release.releaseId).toBe('8');
    const oldPin = await companyAnalysisStats(s.deps, { release: '6' });
    expect(oldPin._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'release' });
  });

  it('never serves a release that carries no privacy epoch', async () => {
    const unguarded = releaseRow(7, DATASET.companies, DATASET.statements, { privacyEpoch: null });
    const active = setup(fakePrivacy(), unguarded);
    expect((await companyAnalysisStats(active.deps, {}))._unsafeUnwrapErr()).toMatchObject({
      type: 'ServiceUnavailable',
    });
    const pinned = await companyAnalysisStats(active.deps, { release: '7' });
    expect(pinned._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'release' });
    expect(active.privacy.reads).toBe(0);
  });

  it('keeps the epoch internal: no answer carries it', async () => {
    const s = setup(fakePrivacy({ epoch: '0' }));
    const info = (await companyAnalysisRelease(s.deps, {}))._unsafeUnwrap();
    expect(JSON.stringify(info)).not.toContain('privacyEpoch');
    const stats = (await companyAnalysisStats(s.deps, {}))._unsafeUnwrap();
    expect(JSON.stringify(stats)).not.toContain('privacyEpoch');
  });
});

describe('the current ONRC source guard (same epoch, moved source)', () => {
  it.each(ANSWERS)(
    '%s: the active release whose pinned edition is no longer the published source is unavailable, with no engine work',
    async (_name, answer) => {
      const s = setup(fakePrivacy({ onrc: currentPublication({ editionId: '43' }) }));
      expect((await answer(s.deps, {}))._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message:
          'the active companies analytics release was exported from an ONRC edition that is no longer the published source; retry once a refreshed release is published',
      });
      expect(s.engine.calls).toEqual([]);
      expect(s.labels.calls).toEqual([]);
    }
  );

  it.each(ANSWERS)('%s: a pinned release is a release error', async (_name, answer) => {
    const s = setup(fakePrivacy({ onrc: currentPublication({ publicationEpoch: '4' }) }));
    const error = (await answer(s.deps, { release: '7' }))._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'InvalidInput', field: 'release' });
    expect(error.message).toBe(
      'companies analytics release 7 was exported from an ONRC edition that is no longer the published source; re-read companyAnalysisRelease and repeat the request'
    );
    expect(s.engine.calls).toEqual([]);
  });

  it.each([
    ['unpublished', { publicationState: 'unpublished', editionId: null, listed: false }],
    ['access withdrawn', { publicationState: 'unavailable' }],
    ['not listed', { listed: false }],
    ['another publication epoch (a rollback and back)', { publicationEpoch: '5' }],
    ['another snapshot', { sourceSnapshotId: 'onrc:2026-08-05' }],
    ['another source date', { sourcePublishedAt: '2026-07-09' }],
    ['an out-of-domain source date', { sourcePublishedAt: 'out-of-range' }],
    ['another interpretation', { interpretationVersion: 'onrc-edition-v2' }],
    ['another dimension policy', { dimensionPolicyVersion: 'onrc-dimensions-v2' }],
    ['another privacy policy', { privacyPolicyVersion: 'onrc-privacy-v2' }],
  ] as const)('refuses a current source that is %s', async (_label, over) => {
    const s = setup(fakePrivacy({ onrc: currentPublication(over) }));
    expect((await companyAnalysisStats(s.deps, {}))._unsafeUnwrapErr().message).toContain(
      'no longer the published source'
    );
    expect(s.engine.calls).toEqual([]);
  });

  it.each(ANSWERS)(
    '%s: a source event after the engine and labels returns no figures',
    async (_name, answer) => {
      const s = setup();
      s.privacy.beforeRead = (index) => {
        if (index === 1) s.privacy.onrc = currentPublication({ editionId: '43' });
      };
      const result = await answer(s.deps, {});
      expect(result._unsafeUnwrapErr().message).toContain('no longer the published source');
      expect(s.engine.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('9007199254741973.32');
    }
  );
});

describe('confirmServedAnalysis (the GraphQL operation’s final decision)', () => {
  it('holds while the release is published and current; reads no engine or label', async () => {
    const s = setup();
    expect((await confirmServedAnalysis(s.deps, '7')).isOk()).toBe(true);
    expect((await confirmServedAnalysis(s.deps, '6')).isOk()).toBe(true);
    expect(s.engine.calls).toEqual([]);
    expect(s.labels.calls).toEqual([]);
    expect(s.privacy.reads).toBe(2);
  });

  it.each([
    ['a privacy change', { epoch: '1' }, 'withdrawn after a privacy change'],
    [
      'a source event',
      { onrc: currentPublication({ editionId: '43' }) },
      'no longer the published source',
    ],
  ] as const)('types %s as a release error, for the active release too', async (_l, over, text) => {
    const s = setup(fakePrivacy(over));
    const error = (await confirmServedAnalysis(s.deps, '7'))._unsafeUnwrapErr();
    expect(error).toMatchObject({ type: 'InvalidInput', field: 'release' });
    expect(error.message).toContain(text);
  });

  it('types a release no longer published as a release error, and an unreadable state as unavailable', async () => {
    const s = setup();
    expect((await confirmServedAnalysis(s.deps, '99'))._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'release',
    });
    const down = setup(fakePrivacy({ fail: true }));
    expect((await confirmServedAnalysis(down.deps, '7'))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'companies analytics cannot confirm the current privacy state; retry later',
    });
    expect((await confirmServedAnalysis(null, '7'))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
  });
});

describe('cached results never bypass the guard (real reader and engine)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const compact = (names: readonly string[], rows: readonly (readonly unknown[])[]) =>
    Response.json({ meta: names.map((name) => ({ name, type: 'String' })), data: rows });

  const STATUS_COLUMNS = [
    'reported',
    'missing',
    'not_admitted',
    'held_profile',
    'held_observation',
    'held_quality',
    'held_component',
  ].map((s) => `m0_${s}`);

  it('re-checks the epoch on a cache hit and refuses it after a withdrawal', async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : '';
      if (body.includes('system.tables'))
        return Promise.resolve(compact(['name'], [['company_r7'], ['company_year_r7']]));
      if (body.includes('AS companies')) return Promise.resolve(compact(['companies'], [['6']]));
      return Promise.resolve(
        compact(
          ['filers', 'm0_sum', ...STATUS_COLUMNS],
          [['5', '9007199254741973.32', '4', '0', '0', '0', '1', '0', '0']]
        )
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const reader = makeClickhouseReader({
      url: 'https://clickhouse.internal:8443',
      database: 'companies_analytics',
      user: 'companies_reader',
      password: 'pw',
    });
    const privacy = fakePrivacy();
    const deps = analyticsDeps(
      makeClickhouseAnalyticsEngine(reader, 'companies_analytics'),
      fakeReleases(ACTIVE, [], privacy),
      fakeLabels()
    );

    const first = (await companyAnalysisStats(deps, {}))._unsafeUnwrap();
    expect(first.metrics[0]?.sum).toBe('9007199254741973.32');
    const queries = fetchSpy.mock.calls.length;
    expect(queries).toBe(3);

    // Same question again: every ClickHouse read is a cache hit…
    expect((await companyAnalysisStats(deps, {})).isOk()).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(queries);
    expect(privacy.reads).toBe(4);

    // …and after a withdrawal the cached figures still never leave.
    privacy.epoch = '1';
    const withdrawn = await companyAnalysisStats(deps, {});
    expect(withdrawn._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(JSON.stringify(withdrawn)).not.toContain('9007199254741973.32');
    expect(fetchSpy.mock.calls.length).toBe(queries);
    expect(privacy.reads).toBe(5);
    reader.close();
  });
});
