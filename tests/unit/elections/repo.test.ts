/**
 * The Elections repository's compiled SQL, over a capturing driver: disabled
 * reads run no query; each read is one read-only, repeatable-read transaction
 * with a statement timeout; every generation read is bound to the active
 * publication; no read names attrs, decision ids, source pointers or the
 * candidate tables; and driver faults map to typed errors. The real-DDL proof
 * is tests/e2e/elections-results.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { makeElectionsRepo } from '@/modules/elections/shell/repo/elections-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

const OCCURRENCE = 'ro:local:2024:2024-06-09';
const CONTEST = `${OCCURRENCE}:mayor:uat:1017`;
const PAGE = { page: 2, pageSize: 10 };

/** Rows that let every read run to its end: one active occurrence/contest, zero counts. */
const respond = (text: string): readonly unknown[] => {
  if (text.includes('count(*)::text as total')) return [{ total: '0' }];
  if (text.includes('from elections.active_serving_occurrences o') && text.includes('limit 2'))
    return [{ publication_id: '7', event_key: 'ro:local:2024' }];
  if (text.includes('select a.publication_id::text as publication_id'))
    return [{ publication_id: '7' }];
  if (text.includes('from elections.active_serving_contests c'))
    return [
      {
        publication_id: '7',
        contest_key: CONTEST,
        occurrence_key: OCCURRENCE,
        event_key: 'ro:local:2024',
        office: 'mayor',
        status: 'held',
        replaced_by: null,
        jurisdiction_key: 'uat:1017',
        place_name: 'MUNICIPIUL ALBA IULIA',
        place_county_code: 'AB',
        place_county_name: 'ALBA',
      },
    ];
  if (text.includes('from unnest(')) return [{ place_key: 'uat:1017', place_name: null }];
  return [];
};

const run = async (read: (repo: ReturnType<typeof makeElectionsRepo>) => Promise<unknown>) => {
  const captured: CapturedQuery[] = [];
  const isolation: unknown[] = [];
  const db = makeCapturingDb(captured, {
    respond,
    onBeginTransaction: (settings) => isolation.push(settings.isolationLevel),
  });
  const result = await read(makeElectionsRepo(db, true));
  return { captured, isolation, result };
};

const READS: [string, (repo: ReturnType<typeof makeElectionsRepo>) => Promise<unknown>][] = [
  ['listEvents', (repo) => repo.listEvents(PAGE)],
  ['eventByKey', (repo) => repo.eventByKey('ro:local:2024')],
  [
    'listContests',
    (repo) =>
      repo.listContests({
        occurrenceKey: OCCURRENCE,
        filter: {
          offices: { in: ['mayor'] },
          statuses: { in: ['held'] },
          jurisdictionTypes: { in: ['uat'] },
          countyCodes: { in: ['AB'] },
        },
        ...PAGE,
      }),
  ],
  ['contestByKey', (repo) => repo.contestByKey(CONTEST)],
  [
    'result',
    (repo) =>
      repo.result({
        occurrenceKey: OCCURRENCE,
        office: 'mayor',
        scopeKey: 'uat:1017',
        contestKey: CONTEST,
      }),
  ],
  [
    'result (aggregate)',
    (repo) =>
      repo.result({
        occurrenceKey: OCCURRENCE,
        office: 'mayor',
        scopeKey: 'county:AB',
        contestKey: null,
      }),
  ],
  [
    'listResultScopes',
    (repo) =>
      repo.listResultScopes({
        occurrenceKey: OCCURRENCE,
        office: 'mayor',
        scopeType: 'uat',
        contestKey: CONTEST,
        ...PAGE,
      }),
  ],
  [
    'listCompetitors',
    (repo) =>
      repo.listCompetitors({
        eventKey: 'ro:local:2024',
        filter: { kinds: { in: ['party'] } },
        ...PAGE,
      }),
  ],
];

describe('elections repository SQL', () => {
  it.each(READS)('%s refuses without a query while disabled', async (_name, read) => {
    const captured: CapturedQuery[] = [];
    const result = (await read(makeElectionsRepo(makeCapturingDb(captured)))) as {
      isErr: () => boolean;
      _unsafeUnwrapErr: () => unknown;
    };
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    expect(captured).toEqual([]);
  });

  it.each(READS)('%s reads in one read-only, repeatable-read transaction', async (_name, read) => {
    const { captured, isolation, result } = await run(read);
    expect((result as { isOk: () => boolean }).isOk()).toBe(true);
    expect(isolation).toEqual(['repeatable read']);
    expect(captured[0]?.sql).toBe('set transaction read only');
    expect(captured[1]?.sql).toBe('set local statement_timeout = 5000');
  });

  it.each(READS)(
    '%s names no attrs, decisions, source pointers or candidates',
    async (_name, read) => {
      const { captured } = await run(read);
      for (const query of captured) {
        expect(query.sql).not.toMatch(
          /attrs|decision_ids|source_pointer|candida|raw_rows|manifest/u
        );
        // Generation tables are read only for the resolved publication.
        if (
          /elections\.(result_tallies|turnout_figures|figure_coverage|serving_competitors|serving_source_selections)\b/u.test(
            query.sql
          )
        )
          expect(query.sql).toMatch(
            /publication_id = (\$\d+::bigint|any\(\$\d+::bigint\[\]\))|on k\.publication_id = t\.publication_id/u
          );
      }
    }
  );

  it('binds every filter value as a parameter, never into the text', async () => {
    const { captured } = await run(READS[2]?.[1] ?? (() => Promise.resolve()));
    const listing = captured.find((query) =>
      query.sql.includes('order by c.contest_key collate "C"')
    );
    expect(listing?.sql).toContain('c.office = any($');
    expect(listing?.sql).toContain('c.status = any($');
    expect(listing?.sql).toContain("split_part(c.jurisdiction_key, ':', 1) = any($");
    expect(listing?.sql).toContain('p.place_county_code = any($');
    expect(listing?.parameters).toEqual(
      expect.arrayContaining([['mayor'], ['held'], ['uat'], ['AB'], 10, 10])
    );
    expect(listing?.sql).not.toContain('AB');
  });

  it('reads the office aggregate by a null contest, and a contest by its key', async () => {
    const aggregate = await run(READS[5]?.[1] ?? (() => Promise.resolve()));
    expect(
      aggregate.captured.some((query) => query.sql.includes('"t"."contest_key" is null'))
    ).toBe(true);
    const contest = await run(READS[4]?.[1] ?? (() => Promise.resolve()));
    expect(
      contest.captured.some(
        (query) => query.sql.includes('"t"."contest_key" = $') && query.parameters.includes(CONTEST)
      )
    ).toBe(true);
  });

  it('answers an inactive occurrence or event with null after the anchor read', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeElectionsRepo(makeCapturingDb(captured), true);
    expect(
      (await repo.listContests({ occurrenceKey: 'x', filter: {}, ...PAGE }))._unsafeUnwrap()
    ).toBeNull();
    expect(
      (await repo.listCompetitors({ eventKey: 'x', filter: {}, ...PAGE }))._unsafeUnwrap()
    ).toBeNull();
    expect((await repo.eventByKey('x'))._unsafeUnwrap()).toBeNull();
  });

  it.each([
    ['42P01', 'ServiceUnavailable'],
    ['42703', 'ServiceUnavailable'],
    ['57014', 'Timeout'],
    ['XX000', 'Database'],
  ])('maps driver code %s to %s', async (code, type) => {
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('serving_active')) throw Object.assign(new Error('boom'), { code });
        return [];
      },
    });
    const result = await makeElectionsRepo(db, true).listEvents(PAGE);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type });
  });

  it('refuses an occurrence active in two publications', async () => {
    const db = makeCapturingDb([], {
      respond: (text) =>
        text.includes('from elections.active_serving_occurrences o')
          ? [
              { publication_id: '7', event_key: 'a' },
              { publication_id: '8', event_key: 'b' },
            ]
          : [],
    });
    const result = await makeElectionsRepo(db, true).listContests({
      occurrenceKey: OCCURRENCE,
      filter: {},
      ...PAGE,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Database' });
  });

  it('refuses an occurrence active in two event listings', async () => {
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('count(*)::text as total')) return [{ total: '2' }];
        if (text.includes('from elections.serving_active a'))
          return [
            { event_key: 'ro:local:2024', publication_id: '7', activated_at: 'x' },
            { event_key: 'ro:local:2024:2024-06-09', publication_id: '8', activated_at: 'x' },
          ];
        if (text.includes('group by o.occurrence_key having count(*) > 1'))
          return [{ occurrence_key: OCCURRENCE }];
        return [];
      },
    });
    const result = await makeElectionsRepo(db, true).listEvents(PAGE);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'Database' });
  });

  it('counts contests per publication and occurrence, never across publications', async () => {
    const db = makeCapturingDb([], {
      respond: (text) => {
        if (text.includes('count(*)::text as total')) return [{ total: '2' }];
        if (text.includes('from elections.serving_active a'))
          return [
            { event_key: 'ro:a:2024', publication_id: '7', activated_at: 'x' },
            { event_key: 'ro:b:2024', publication_id: '8', activated_at: 'x' },
          ];
        if (text.includes('from elections.serving_occurrences o'))
          return [
            {
              publication_id: '7',
              occurrence_key: 'occ',
              event_key: 'ro:a:2024',
              ballot_date: '2024-06-09',
              round_label: 'r1',
              occurrence_kind: 'general',
              status: 'held',
            },
            {
              publication_id: '8',
              occurrence_key: 'occ',
              event_key: 'ro:b:2024',
              ballot_date: '2024-06-09',
              round_label: 'r1',
              occurrence_kind: 'general',
              status: 'held',
            },
          ];
        if (text.includes('group by c.publication_id, c.occurrence_key, c.office'))
          return [
            { publication_id: '7', occurrence_key: 'occ', office: 'mayor', contests: '3' },
            { publication_id: '8', occurrence_key: 'occ', office: 'mayor', contests: '5' },
          ];
        return [];
      },
    });
    const events = (await makeElectionsRepo(db, true).listEvents(PAGE))._unsafeUnwrap();
    expect(events.items.map((event) => event.occurrences[0]?.offices)).toEqual([
      [{ office: 'mayor', contests: 3 }],
      [{ office: 'mayor', contests: 5 }],
    ]);
  });
});
