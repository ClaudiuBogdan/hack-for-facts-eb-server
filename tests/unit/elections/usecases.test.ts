import { describe, expect, it } from 'vitest';

import {
  getElectionContest,
  getElectionEdition,
  listElectionContests,
  listElectionEditions,
} from '@/modules/elections/core/usecases.js';
import { offsetFor, type FilterInput } from '@/modules/shared/index.js';

import { makeFakeElectionsRepo, RESTRICTED_SENTINEL } from '../../fixtures/elections/catalog.js';

import type { ElectionPage } from '@/modules/elections/core/types.js';

const deps = (options: Parameters<typeof makeFakeElectionsRepo>[0] = {}) => ({
  repo: makeFakeElectionsRepo(options),
});

const catalog = async (filter: FilterInput = {}, page = 1, pageSize = 20) => {
  const result = await listElectionEditions(deps(), { filter, page, pageSize });
  return result._unsafeUnwrap();
};

const keys = (page: ElectionPage<{ readonly electionKey: string }>) =>
  page.items.map((item) => item.electionKey);

describe('election catalog: source editions', () => {
  it('lists public source editions in electionKey order with an exact edition total', async () => {
    const page = await catalog();
    expect(keys(page)).toEqual([
      'aep-local-2014-t1',
      'bec-european-2009',
      'bec-local-2024',
      'bec-local-2024-hidden-event',
      'bec-referendum-undated',
      'roaep-election-databases-local-2024',
    ]);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 6, hasMore: false });
  });

  it('keeps two editions of one event distinct: same eventKey, separate editions, no merged row', async () => {
    const page = await catalog({ eventKeys: { in: ['ro:local:2024'] } });
    expect(keys(page)).toEqual(['bec-local-2024', 'roaep-election-databases-local-2024']);
    expect(page.total).toBe(2);
    // The stored authority label is one composite string; it does not tell editions apart.
    expect(page.items.map((item) => item.reportedAuthority)).toEqual([
      'BEC/AEP/ROAEP',
      'BEC/AEP/ROAEP',
    ]);
    for (const item of page.items) {
      expect(item.eventKey).toBe('ro:local:2024');
      expect(item.readiness.sourceSelection).toBe('HELD');
      expect(item.readiness.issues).toContain('SOURCE_SELECTION_UNVERIFIED');
    }
  });

  it('filters by reported year and family (AND across fields, OR within a field)', async () => {
    expect(keys(await catalog({ reportedYears: { in: [2024] } }))).toEqual([
      'bec-local-2024',
      'bec-local-2024-hidden-event',
      'roaep-election-databases-local-2024',
    ]);
    expect(
      keys(
        await catalog({
          reportedYears: { in: [2009, 2014] },
          reportedFamilies: { in: ['parliamentary'] },
        })
      )
    ).toEqual(['bec-european-2009']);
    const none = await catalog({ reportedFamilies: { in: [] } });
    expect(none).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  it('matches the stored family label exactly: a mislabelled edition is never corrected', async () => {
    const european = await catalog({ reportedFamilies: { in: ['european'] } });
    expect(european).toMatchObject({ items: [], total: 0 });
    const byEvent = await catalog({ eventKeys: { in: ['ro:european:2009'] } });
    expect(byEvent.items.map((item) => [item.electionKey, item.reportedFamily])).toEqual([
      ['bec-european-2009', 'parliamentary'],
    ]);
    expect(byEvent.items[0]?.verifiedFamily).toBeNull();
  });

  it('pages stably: pages concatenate to the full order without gaps or repeats', async () => {
    const full = keys(await catalog());
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await catalog({}, page, 2);
      expect(result.total).toBe(6);
      expect(result.hasMore).toBe(page < 3);
      seen.push(...keys(result));
    }
    expect(seen).toEqual(full);
    const past = await catalog({}, 4, 2);
    expect(past).toMatchObject({ items: [], total: 6, hasMore: false });
  });

  it('serves reported labels as reported and keeps verified fields null and identity HELD', async () => {
    const page = await catalog({ reportedYears: { in: [2014] } });
    const [mislabelled] = page.items;
    expect(mislabelled).toMatchObject({
      electionKey: 'aep-local-2014-t1',
      reportedYear: 2014,
      verifiedYear: null,
      reportedFamily: 'local',
      verifiedFamily: null,
      reportedRound: 'tur1',
      reportedDate: null,
      readiness: {
        identity: 'HELD',
        sourceSelection: 'HELD',
        sourceOpening: 'HELD',
        results: 'UNAVAILABLE',
        mandates: 'UNAVAILABLE',
      },
    });
    expect(mislabelled?.readiness.issues).toEqual([
      'EDITION_IDENTITY_UNVERIFIED',
      'SOURCE_SELECTION_UNVERIFIED',
      'SOURCE_ARTIFACT_ACCESS_HELD',
      'RESULT_STATUS_UNQUALIFIED',
      'RESULTS_UNAVAILABLE',
      'MANDATES_UNAVAILABLE',
      'REPORTED_DATE_MISSING',
      'EVENT_LINK_UNVERIFIED',
    ]);
  });

  it('keeps unknowns explicit: missing year, missing event, present date', async () => {
    const undated = (await getElectionEdition(deps(), 'bec-referendum-undated'))._unsafeUnwrap();
    expect(undated?.reportedYear).toBeNull();
    expect(undated?.eventKey).toBeNull();
    expect(undated?.readiness.issues).toEqual(
      expect.arrayContaining(['REPORTED_YEAR_MISSING', 'EVENT_LINK_UNAVAILABLE'])
    );
    const european = (await getElectionEdition(deps(), 'bec-european-2009'))._unsafeUnwrap();
    expect(european?.reportedDate).toBe('2009-06-07');
    expect(european?.readiness.issues).not.toContain('REPORTED_DATE_MISSING');
    expect(european?.readiness.issues).toContain('EVENT_LINK_UNVERIFIED');
    expect(undated?.readiness.issues).not.toContain('EVENT_LINK_UNVERIFIED');
  });

  it('serves no result, finality or winner field: result status stays held, not reported', async () => {
    const page = await catalog({}, 1, 100);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'electionKey',
          'eventKey',
          'readiness',
          'reportedAuthority',
          'reportedDate',
          'reportedFamily',
          'reportedName',
          'reportedRound',
          'reportedYear',
          'verifiedFamily',
          'verifiedYear',
        ].sort()
      );
      expect(item.readiness.issues).toContain('RESULT_STATUS_UNQUALIFIED');
      expect(item.readiness.results).toBe('UNAVAILABLE');
    }
  });
});

describe('election privacy: default deny', () => {
  it('denies a restricted edition on every read, indistinguishable from absence', async () => {
    const all = await catalog({}, 1, 100);
    expect(JSON.stringify(all)).not.toContain(RESTRICTED_SENTINEL);
    const key = `restricted-${RESTRICTED_SENTINEL}`;
    expect((await getElectionEdition(deps(), key))._unsafeUnwrap()).toBeNull();
    expect((await getElectionEdition(deps(), 'no-such-edition'))._unsafeUnwrap()).toBeNull();
    const restricted = await listElectionContests(deps(), {
      electionKey: key,
      filter: {},
      page: 1,
      pageSize: 20,
    });
    const absent = await listElectionContests(deps(), {
      electionKey: 'no-such-edition',
      filter: {},
      page: 1,
      pageSize: 20,
    });
    expect(restricted._unsafeUnwrapErr()).toEqual(absent._unsafeUnwrapErr());
    expect(restricted._unsafeUnwrapErr().type).toBe('NotFound');
  });

  it('withholds a restricted event link and never matches it by eventKey', async () => {
    const item = (await getElectionEdition(deps(), 'bec-local-2024-hidden-event'))._unsafeUnwrap();
    expect(item?.eventKey).toBeNull();
    expect(item?.readiness.issues).toContain('EVENT_LINK_UNAVAILABLE');
    const byEvent = await catalog({ eventKeys: { in: [`ro:${RESTRICTED_SENTINEL}:event`] } });
    expect(byEvent.total).toBe(0);
  });

  it('denies a restricted contest and contests of a restricted edition', async () => {
    const page = (
      await listElectionContests(deps(), {
        electionKey: 'bec-local-2024',
        filter: {},
        page: 1,
        pageSize: 100,
      })
    )._unsafeUnwrap();
    expect(JSON.stringify(page)).not.toContain(RESTRICTED_SENTINEL);
    expect(page.total).toBe(6);
    const restrictedContest = `contest:bec-local-2024:mayor:siruta:${RESTRICTED_SENTINEL}`;
    expect((await getElectionContest(deps(), restrictedContest))._unsafeUnwrap()).toBeNull();
    const underRestricted = `contest:restricted-${RESTRICTED_SENTINEL}:mayor:siruta:1017`;
    expect((await getElectionContest(deps(), underRestricted))._unsafeUnwrap()).toBeNull();
  });

  it('fails closed when a non-public row reaches the usecase (broken repository predicate)', async () => {
    const leaky = deps({ leak: true });
    const list = await listElectionEditions(leaky, { filter: {}, page: 1, pageSize: 100 });
    expect(list._unsafeUnwrapErr().type).toBe('Database');
    expect(JSON.stringify(list)).not.toContain(`"electionKey"`);
    const contests = await listElectionContests(leaky, {
      electionKey: 'bec-local-2024',
      filter: {},
      page: 1,
      pageSize: 100,
    });
    expect(contests._unsafeUnwrapErr().type).toBe('Database');
    const underRestricted = await getElectionContest(
      leaky,
      `contest:restricted-${RESTRICTED_SENTINEL}:mayor:siruta:1017`
    );
    expect(underRestricted._unsafeUnwrapErr().type).toBe('Database');
  });

  it('fails closed on an event link that is not public', async () => {
    const repo = makeFakeElectionsRepo();
    const leakyEvent = {
      ...repo,
      editionByKey: async (key: string) =>
        (await repo.editionByKey(key)).map((record) =>
          record === null ? null : { ...record, eventKey: 'ro:x', eventPrivacyClass: 'restricted' }
        ),
    };
    const result = await getElectionEdition({ repo: leakyEvent }, 'bec-local-2024');
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('election contests: metadata only', () => {
  const contests = async (filter: FilterInput = {}, page = 1, pageSize = 20) =>
    (
      await listElectionContests(deps(), { electionKey: 'bec-local-2024', filter, page, pageSize })
    )._unsafeUnwrap();

  it('lists contests in contestKey order and filters by office, scope type and round', async () => {
    const all = await contests();
    const ordered = all.items.map((item) => item.contestKey);
    expect(ordered).toEqual([...ordered].sort());
    const mayors = await contests({ reportedOffices: { in: ['mayor'] } });
    expect(mayors.total).toBe(3);
    const county = await contests({ scopeTypes: { in: ['county'] } });
    expect(county.items.map((item) => item.reportedOffice)).toEqual([
      'consiliu-judetean',
      'county_council',
    ]);
    const runoff = await contests({ reportedRounds: { in: ['tur2'] } });
    expect(runoff.items.map((item) => [item.contestKey, item.sourceScopeKey])).toEqual([
      ['contest:bec-local-2024:mayor:siruta:1017:tur2', '1017'],
    ]);
  });

  it('pages contests stably with an exact total independent of the page', async () => {
    const full = (await contests()).items.map((item) => item.contestKey);
    const seen: string[] = [];
    for (let page = 1; page <= 2; page++) {
      const result = await contests({}, page, 4);
      expect(result.total).toBe(6);
      expect(result.hasMore).toBe(page === 1);
      seen.push(...result.items.map((item) => item.contestKey));
    }
    expect(seen).toEqual(full);
  });

  it('serves the source scope as reported with identity and scope held and results unavailable', async () => {
    const item = (
      await getElectionContest(deps(), 'contest:aep-local-2014-t1:mayor:siruta:179141')
    )._unsafeUnwrap();
    expect(item).toMatchObject({
      electionKey: 'aep-local-2014-t1',
      eventKey: 'ro:local:2014',
      reportedOffice: 'mayor',
      verifiedOffice: null,
      scopeType: 'siruta',
      sourceScopeKey: '179141',
      readiness: { identity: 'HELD', results: 'UNAVAILABLE', mandates: 'UNAVAILABLE' },
    });
    expect(item?.readiness.issues).toEqual([
      'CONTEST_IDENTITY_UNVERIFIED',
      'CONTEST_SCOPE_UNVERIFIED',
      'SOURCE_SELECTION_UNVERIFIED',
      'SOURCE_ARTIFACT_ACCESS_HELD',
      'RESULTS_UNAVAILABLE',
      'MANDATES_UNAVAILABLE',
      'EVENT_LINK_UNVERIFIED',
    ]);
    // Exactly the governed metadata fields: no votes, winners, attrs or artifact URLs.
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'chamber',
        'constituencyCode',
        'constituencyName',
        'contestKey',
        'electionKey',
        'eventKey',
        'readiness',
        'reportedOffice',
        'reportedRound',
        'scopeLabel',
        'scopeType',
        'sourceScopeKey',
        'verifiedOffice',
      ].sort()
    );
  });

  it('marks results and mandates unavailable on every edition and contest', async () => {
    const editions = (await catalog({}, 1, 100)).items;
    const contestItems = (await contests({}, 1, 100)).items;
    for (const item of [...editions, ...contestItems]) {
      expect(item.readiness.results).toBe('UNAVAILABLE');
      expect(item.readiness.mandates).toBe('UNAVAILABLE');
      expect(item.readiness.sourceOpening).toBe('HELD');
    }
  });

  it('refuses an unexpected stored scope type', async () => {
    const repo = makeFakeElectionsRepo({
      contests: [
        {
          contestKey: 'contest:bec-local-2024:mayor:polling_station:1',
          privacyClass: 'public',
          electionKey: 'bec-local-2024',
          office: 'mayor',
          chamber: null,
          roundLabel: null,
          scopeType: 'polling_station',
          scopeKey: '1',
          scopeLabel: null,
          constituencyCode: null,
          constituencyName: null,
          event: null,
        },
      ],
    });
    const result = await getElectionContest(
      { repo },
      'contest:bec-local-2024:mayor:polling_station:1'
    );
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('election input validation (fail fast, no repository call)', () => {
  const cases: readonly [string, FilterInput, number, number][] = [
    ['page 0', {}, 0, 20],
    ['pageSize over the kernel maximum', {}, 1, 101],
    ['fractional page', {}, 1.5, 20],
    ['unknown filter field', { verifiedYears: { in: [2024] } }, 1, 20],
    ['unsupported operator', { reportedYears: { eq: 2024 } }, 1, 20],
    ['year out of range', { reportedYears: { in: [24] } }, 1, 20],
    ['non-array in', { reportedFamilies: { in: 'local' as unknown as string[] } }, 1, 20],
    ['too many values', { reportedYears: { in: Array.from({ length: 101 }, () => 2024) } }, 1, 20],
    ['control character', { eventKeys: { in: ['ro:local\u0000'] } }, 1, 20],
    ['exclude is not supported', { exclude: { reportedYears: { in: [2024] } } }, 1, 20],
  ];

  it.each(cases)('rejects %s', async (_label, filter, page, pageSize) => {
    const repo = makeFakeElectionsRepo();
    const result = await listElectionEditions({ repo }, { filter, page, pageSize });
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(repo.calls).toEqual([]);
  });

  // The SQL OFFSET is bound from offsetFor = (page - 1) * pageSize, so it must stay a safe integer.
  const PAGE_SIZE = 100;
  const LAST_SAFE_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1;

  it('pins the safe-offset boundary the guard enforces', () => {
    expect(Number.isSafeInteger(offsetFor({ page: LAST_SAFE_PAGE, pageSize: PAGE_SIZE }))).toBe(
      true
    );
    expect(Number.isSafeInteger(offsetFor({ page: LAST_SAFE_PAGE + 1, pageSize: PAGE_SIZE }))).toBe(
      false
    );
    expect(
      Number.isSafeInteger(offsetFor({ page: Number.MAX_SAFE_INTEGER, pageSize: PAGE_SIZE }))
    ).toBe(false);
  });

  it.each([
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['the first page past the safe offset', LAST_SAFE_PAGE + 1],
  ])('rejects page %s on both list usecases before any repository call', async (_label, page) => {
    const repo = makeFakeElectionsRepo();
    const editions = await listElectionEditions(
      { repo },
      { filter: {}, page, pageSize: PAGE_SIZE }
    );
    const contests = await listElectionContests(
      { repo },
      { electionKey: 'bec-local-2024', filter: {}, page, pageSize: PAGE_SIZE }
    );
    for (const result of [editions, contests])
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'page' });
    expect(repo.calls).toEqual([]);
  });

  it('still serves the last page whose offset is a safe integer, as an exact empty page', async () => {
    const repo = makeFakeElectionsRepo();
    const editions = await listElectionEditions(
      { repo },
      { filter: {}, page: LAST_SAFE_PAGE, pageSize: PAGE_SIZE }
    );
    const contests = await listElectionContests(
      { repo },
      { electionKey: 'bec-local-2024', filter: {}, page: LAST_SAFE_PAGE, pageSize: PAGE_SIZE }
    );
    for (const result of [editions, contests])
      expect(result._unsafeUnwrap()).toMatchObject({
        items: [],
        page: LAST_SAFE_PAGE,
        pageSize: PAGE_SIZE,
        total: 6,
        hasMore: false,
      });
    expect(repo.calls).toEqual(['listEditions', 'listContests']);
  });

  it('rejects invalid keys and contest filters before reading', async () => {
    const repo = makeFakeElectionsRepo();
    expect((await getElectionEdition({ repo }, ''))._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect((await getElectionContest({ repo }, 'x'.repeat(513)))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    const badScope = await listElectionContests(
      { repo },
      {
        electionKey: 'bec-local-2024',
        filter: { scopeTypes: { in: ['polling_station'] } },
        page: 1,
        pageSize: 20,
      }
    );
    expect(badScope._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(repo.calls).toEqual([]);
  });
});
