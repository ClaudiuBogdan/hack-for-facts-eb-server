/**
 * The Elections repository's compiled SQL, pinned over a capturing driver (no
 * database): dimension tables only for the catalog, public rows only, public
 * event links only, named columns, C-collated key order, one read-only
 * repeatable-read snapshot; and the county source report's fact reads bound to
 * the qualified carrier on every query.
 */
import { describe, expect, it } from 'vitest';

import { makeElectionsModule } from '@/modules/elections/index.js';
import {
  mapContestRow,
  mapCountySourceContestRow,
  mapEditionRow,
  makeElectionsRepo,
  type ContestSqlRow,
  type CountySourceCompetitorSqlRow,
  type CountySourceContestSqlRow,
  type CountySourceIntegritySqlRow,
  type EditionSqlRow,
} from '@/modules/elections/shell/repo/elections-repo.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { TransactionSettings } from 'kysely';

const EDITION_ROW: EditionSqlRow = {
  election_key: 'bec-local-2024',
  privacy_class: 'public',
  election_name: 'Alegeri locale 2024',
  election_family: 'local',
  election_year: 2024,
  election_round: 'tur1',
  election_date: null,
  authority: 'BEC/AEP/ROAEP',
  event_key: 'ro:local:2024',
  event_privacy_class: 'public',
};

const CONTEST_ROW: ContestSqlRow = {
  contest_key: 'contest:bec-local-2020:county_council:county:1',
  privacy_class: 'public',
  election_key: 'bec-local-2020',
  election_privacy_class: 'public',
  office: 'county_council',
  chamber: null,
  round_label: null,
  scope_type: 'county',
  scope_key: '1',
  scope_label: 'ALBA',
  constituency_code: null,
  constituency_name: null,
  event_key: null,
  event_privacy_class: null,
};

const FORBIDDEN = [
  'attrs',
  'evidence',
  'result_rows',
  'candidacies',
  'candidates',
  'source_artifacts',
  'source_record_links',
  'competitor_mandate_allocations',
  'elected_candidate_mandates',
  'event_source_coverage',
  'territory_link_evidence',
  // Finality, canonical/corrected identity and links are held, never read.
  'result_status',
  'is_final',
  'publication_status',
  'canonical_office',
  'corrected_family',
  'is_canonical_source',
  'event_match',
  'territory_id',
  'primary_source_artifact_id',
  'source_updated_at',
  'select *',
  '.*',
];

const capture = (respond?: (sql: string) => readonly unknown[]) => {
  const captured: CapturedQuery[] = [];
  const transactions: TransactionSettings[] = [];
  const db = makeCapturingDb(captured, {
    ...(respond === undefined ? {} : { respond: (sql) => respond(sql) }),
    onBeginTransaction: (settings) => transactions.push(settings),
  });
  return { repo: makeElectionsRepo(db, true), captured, transactions };
};

const dataQueries = (captured: readonly CapturedQuery[]) =>
  captured.filter((q) => !q.sql.startsWith('set '));

const expectGoverned = (captured: readonly CapturedQuery[]) => {
  expect(captured.map((q) => q.sql).slice(0, 2)).toEqual([
    'set transaction read only',
    'set local statement_timeout = 5000',
  ]);
  for (const query of dataQueries(captured)) {
    for (const forbidden of FORBIDDEN) expect(query.sql).not.toContain(forbidden);
    expect(query.sql).not.toMatch(/\b(insert|update|delete|truncate)\b/iu);
  }
};

describe('elections repository SQL', () => {
  it('lists public editions with public event links, exact count and C-collated key order', async () => {
    const { repo, captured, transactions } = capture((sql) =>
      sql.includes('count(*)') ? [{ total: '1' }] : [EDITION_ROW]
    );
    const result = await repo.listEditions({
      filter: { reportedYears: { in: [2024] }, eventKeys: { in: ['ro:local:2024'] } },
      page: 3,
      pageSize: 10,
    });
    expect(result._unsafeUnwrap()).toEqual({ items: [mapEditionRow(EDITION_ROW)], total: 1 });
    expect(transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expectGoverned(captured);
    const [count, page] = dataQueries(captured);
    for (const query of [count, page]) {
      expect(query?.sql).toContain('from "elections"."elections" as "e"');
      expect(query?.sql).toContain(
        'left join "elections"."electoral_events" as "ev" on "ev"."event_id" = "e"."event_id" and "ev"."privacy_class" = $1'
      );
      expect(query?.sql).toContain('"e"."privacy_class" = $2');
      expect(query?.parameters.slice(0, 2)).toEqual(['public', 'public']);
      expect(query?.sql).toContain('"e"."election_year"');
      expect(query?.sql).toContain('"ev"."event_key"');
    }
    expect(count?.sql).toContain('count(*)::text');
    expect(page?.sql).toContain('order by e.election_key collate "C"');
    expect(page?.sql).toMatch(/limit \$\d+ offset \$\d+$/u);
    expect(page?.parameters.slice(-2)).toEqual([10, 20]);
    expect(page?.parameters).toEqual(expect.arrayContaining([2024, 'ro:local:2024']));
  });

  it('looks up one public edition by key', async () => {
    const { repo, captured } = capture(() => []);
    expect((await repo.editionByKey('bec-local-2024'))._unsafeUnwrap()).toBeNull();
    expectGoverned(captured);
    const [query] = dataQueries(captured);
    expect(query?.sql).toContain('"e"."privacy_class" = $2');
    expect(query?.sql).toContain('"e"."election_key" = $3');
    expect(query?.parameters).toEqual(['public', 'public', 'bec-local-2024']);
  });

  it('resolves a public edition first and returns null without reading contests when absent', async () => {
    const { repo, captured } = capture(() => []);
    const result = await repo.listContests({
      electionKey: 'restricted-or-absent',
      filter: {},
      page: 1,
      pageSize: 20,
    });
    expect(result._unsafeUnwrap()).toBeNull();
    const queries = dataQueries(captured);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('"e"."privacy_class" = $2');
    expect(queries[0]?.parameters).toEqual(['restricted-or-absent', 'public']);
  });

  it('reads contests of one edition by election_id, public contest and edition, public event link', async () => {
    const { repo, captured } = capture((sql) => {
      if (sql.includes('"e"."election_id" from')) return [{ election_id: '9031' }];
      if (sql.includes('count(*)')) return [{ total: '105' }];
      return [CONTEST_ROW];
    });
    const result = await repo.listContests({
      electionKey: 'bec-local-2020',
      filter: { scopeTypes: { in: ['county'] }, reportedOffices: { in: ['county_council'] } },
      page: 2,
      pageSize: 50,
    });
    expect(result._unsafeUnwrap()).toEqual({ items: [mapContestRow(CONTEST_ROW)], total: 105 });
    expectGoverned(captured);
    const [, count, page] = dataQueries(captured);
    for (const query of [count, page]) {
      expect(query?.sql).toContain('from "elections"."contests" as "c"');
      expect(query?.sql).toContain(
        'inner join "elections"."elections" as "e" on "e"."election_id" = "c"."election_id"'
      );
      expect(query?.sql).toContain(
        'left join "elections"."electoral_events" as "ev" on "ev"."event_id" = "c"."event_id" and "ev"."privacy_class" = $1'
      );
      expect(query?.sql).toContain('"c"."privacy_class" = $2 and "e"."privacy_class" = $3');
      expect(query?.sql).toContain('"c"."election_id" = $4');
      expect(query?.parameters.slice(0, 4)).toEqual(['public', 'public', 'public', '9031']);
    }
    expect(page?.sql).toContain('order by c.contest_key collate "C"');
    expect(page?.parameters.slice(-2)).toEqual([50, 50]);
  });

  it('looks up one contest requiring both contest and edition to be public', async () => {
    const { repo, captured } = capture(() => [CONTEST_ROW]);
    const result = await repo.contestByKey(CONTEST_ROW.contest_key);
    expect(result._unsafeUnwrap()).toEqual(mapContestRow(CONTEST_ROW));
    const [query] = dataQueries(captured);
    expect(query?.sql).toContain('"c"."privacy_class" = $2 and "e"."privacy_class" = $3');
    expect(query?.sql).toContain('"c"."contest_key" = $4');
  });

  it('refuses a count that is not an exact non-negative integer', async () => {
    for (const total of ['9007199254740993', '-1', '1.5', '']) {
      const { repo } = capture((sql) => (sql.includes('count(*)') ? [{ total }] : []));
      const result = await repo.listEditions({ filter: {}, page: 1, pageSize: 20 });
      expect(result._unsafeUnwrapErr().type).toBe('Database');
    }
  });

  it('maps a missing schema to ServiceUnavailable and a cancelled statement to Timeout', async () => {
    const failing = (code: string) =>
      capture((sql) => {
        if (sql.startsWith('set ')) return [];
        throw Object.assign(new Error('pg'), { code });
      }).repo;
    const missing = await failing('42P01').listEditions({ filter: {}, page: 1, pageSize: 20 });
    expect(missing._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    const column = await failing('42703').contestByKey('k');
    expect(column._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    const slow = await failing('57014').editionByKey('k');
    expect(slow._unsafeUnwrapErr().type).toBe('Timeout');
    const other = await failing('XX000').editionByKey('k');
    expect(other._unsafeUnwrapErr().type).toBe('Database');
  });

  it('is disabled by default: every read refuses without a query and no MCP tool is registered', async () => {
    const captured: CapturedQuery[] = [];
    const module = makeElectionsModule({ db: makeCapturingDb(captured) });
    expect(module.mcpTools).toEqual([]);
    const results = await Promise.all([
      module.repo.listEditions({ filter: {}, page: 1, pageSize: 20 }),
      module.repo.editionByKey('k'),
      module.repo.listContests({ electionKey: 'k', filter: {}, page: 1, pageSize: 20 }),
      module.repo.contestByKey('k'),
      module.repo.countySourceReport({ contestKey: 'k', page: 1, pageSize: 20 }),
    ]);
    for (const result of results) expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(captured).toEqual([]);
    const enabled = makeElectionsModule({ db: makeCapturingDb([]), enabled: true });
    // The county source report has no MCP tool (deferred).
    expect(enabled.mcpTools.map((tool) => tool.name)).toEqual([
      'list_election_editions',
      'get_election_edition',
      'list_election_contests',
      'get_election_contest',
    ]);
  });
});

describe('elections county source report SQL', () => {
  const CONTEST: CountySourceContestSqlRow = {
    contest_id: '185013',
    contest_key: 'contest:aep-local-2020:mayor:county:1',
    privacy_class: 'public',
    election_key: 'aep-local-2020',
    election_privacy_class: 'public',
    office: 'mayor',
    scope_type: 'county',
    scope_key: '1',
    scope_label: 'ALBA',
  };
  const COMPETITOR: CountySourceCompetitorSqlRow = {
    source_label: 'PARTIDUL NAȚIONAL LIBERAL',
    privacy_class: 'public',
    voturi_cells: '1',
    voturi: '40',
    mandate_cells: '0',
    mandate: null,
  };

  const INTEGRITY: CountySourceIntegritySqlRow = {
    labels: '234',
    complete_labels: '233',
    duplicated_labels: '0',
    labels_with_null_cell: '0',
    labels_with_non_integer_cell: '0',
  };

  const isContest = (sql: string) => sql.includes('from "elections"."contests" as "c"');
  const isStatement = (sql: string) => sql.includes('"rr"."electoral_competitor_id" is null');
  const isIntegrity = (sql: string) => sql.includes('as "complete_labels"');

  const reportCapture = (
    competitor: CountySourceCompetitorSqlRow = COMPETITOR,
    integrity: CountySourceIntegritySqlRow = INTEGRITY
  ) =>
    capture((sql) => {
      if (isContest(sql)) return [CONTEST];
      if (isStatement(sql)) return [{ metric_code: 'c', value: '60' }];
      if (isIntegrity(sql)) return [integrity];
      return [competitor];
    });

  /** The carrier binding every fact read must carry, with its bound values. */
  const CARRIER_SQL = [
    'from "elections"."result_rows" as "rr"',
    'inner join "elections"."reporting_units" as "ru" on "ru"."reporting_unit_id" = "rr"."reporting_unit_id"',
    'inner join "elections"."source_metric_map" as "m" on "m"."source_family" = $',
    ' and "m"."source_metric_code" = "rr"."metric_code" and "m"."metric_code" = "rr"."metric_code"',
    '"rr"."contest_id" = $',
    '"rr"."source_resource_id" = $',
    '"rr"."source_file_id" = $',
    "rr.attrs ->> 'sourceFileSha256' = $",
    "rr.attrs ->> 'packageName' = $",
    // The qualified carrier's provenance shape: no explicit source column.
    "rr.attrs ->> 'sourceMetricColumn' is null",
    '"rr"."candidate_id" is null',
    '"rr"."privacy_class" = $',
    '"ru"."privacy_class" = $',
    '"ru"."scope_type" = $',
    '"ru"."scope_key" = $',
    '"m"."mapping_status" = $',
    '"m"."privacy_class" = $',
  ];
  const CARRIER_VALUES = [
    'aep-local-2020',
    '185013',
    'local:a1c73906c6c3425fa483cb7c',
    '88',
    'aa7fa46554bee238ad70ce3f401d959c7b243f4c9a37564a2161cd201658ffea',
    'public',
    'county',
    '1',
    'human_accepted',
  ];
  /** Never selected or read by the report (`attrs` only in the three carrier predicates). */
  const NEVER = [
    'raw_value',
    'evidence',
    'source_artifact',
    'grain_level',
    'is_aggregate',
    'row_kind',
    'metric_role',
    'canonical',
    'semantic_role',
    'result_status',
    'is_final',
    'publication_status',
    'competitor_mandate_allocations',
    'candidacies',
    'metric_definitions',
    'select *',
    '.*',
  ];

  it('resolves the contest only inside the qualified edition, office and scope, both public', async () => {
    const { repo, captured, transactions } = capture(() => []);
    const result = await repo.countySourceReport({
      contestKey: 'contest:absent',
      page: 1,
      pageSize: 20,
    });
    expect(result._unsafeUnwrap()).toBeNull();
    expect(transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(captured.map((q) => q.sql).slice(0, 2)).toEqual([
      'set transaction read only',
      'set local statement_timeout = 5000',
    ]);
    // An absent contest reads no fact row.
    const [contest, ...rest] = dataQueries(captured);
    expect(rest).toEqual([]);
    expect(contest?.sql).toContain(
      'inner join "elections"."elections" as "e" on "e"."election_id" = "c"."election_id"'
    );
    expect(contest?.sql).toContain(
      '"c"."contest_key" = $1 and "c"."privacy_class" = $2 and "e"."privacy_class" = $3 and "e"."election_key" = $4 and "c"."office" = $5 and "c"."scope_type" = $6'
    );
    expect(contest?.parameters).toEqual([
      'contest:absent',
      'public',
      'public',
      'aep-local-2020',
      'mayor',
      'county',
    ]);
  });

  it('binds every fact read to the qualified carrier, county unit, accepted map and public rows', async () => {
    const { repo, captured } = reportCapture();
    const result = await repo.countySourceReport({
      contestKey: CONTEST.contest_key,
      page: 3,
      pageSize: 50,
    });
    expect(result._unsafeUnwrap()).toEqual({
      contest: mapCountySourceContestRow(CONTEST),
      statement: [{ metricCode: 'c', value: '60' }],
      competitors: {
        items: [
          {
            sourceLabel: 'PARTIDUL NAȚIONAL LIBERAL',
            privacyClass: 'public',
            voturiCells: 1,
            voturi: '40',
            mandateCells: 0,
            mandate: null,
          },
        ],
        total: 234,
      },
      integrity: {
        completeLabels: 233,
        duplicatedLabels: 0,
        labelsWithNullCell: 0,
        labelsWithNonIntegerCell: 0,
      },
    });
    const [, statement, count, page] = dataQueries(captured);
    for (const query of [statement, count, page]) {
      for (const fragment of CARRIER_SQL) expect(query?.sql).toContain(fragment);
      expect(query?.parameters).toEqual(expect.arrayContaining(CARRIER_VALUES));
      expect(query?.sql.match(/attrs/gu)).toHaveLength(3);
      for (const never of NEVER) expect(query?.sql).not.toContain(never);
      expect(query?.sql).not.toMatch(/\b(insert|update|delete|truncate)\b/iu);
    }
    // Statement: the explicit admitted codes only (e and f never), stored numbers as text.
    expect(statement?.sql).toContain('rr.numeric_value::text');
    expect(statement?.parameters).toEqual(
      expect.arrayContaining(['a', 'a1', 'a2', 'a3', 'a4', 'b', 'b1', 'b2', 'b3', 'b4', 'c', 'd'])
    );
    expect(statement?.parameters).not.toContain('e');
    expect(statement?.parameters).not.toContain('f');
    expect(statement?.parameters).not.toContain('voturi');
    // Competitors: public competitors of the package, the two file columns only, grouped by
    // SOURCE LABEL (never by competitor id), with the canonical-integer pattern bound.
    for (const query of [count, page]) {
      expect(query?.sql).toContain(
        'inner join "elections"."electoral_competitors" as "ec" on "ec"."electoral_competitor_id" = "rr"."electoral_competitor_id"'
      );
      expect(query?.sql).toContain('"ec"."source_family" = $');
      expect(query?.sql).toContain('"ec"."privacy_class" = $');
      expect(query?.parameters).toEqual(expect.arrayContaining(['voturi', 'mandate']));
      expect(query?.parameters).not.toContain('e');
      expect(query?.sql).toContain('group by "ec"."source_label"');
      expect(query?.sql).not.toMatch(/group by[^)]*electoral_competitor_id/u);
      expect(query?.sql).toContain('max(ec.privacy_class)');
      expect(query?.sql).toContain('rr.numeric_value::text !~ $');
      expect(query?.parameters).toContain('^(0|[1-9][0-9]*)$');
    }
    // The integrity counts aggregate every label of the contest: no limit, before the page.
    expect(count?.sql).toMatch(/^select count\(\*\)::text as "labels"/u);
    for (const column of [
      'complete_labels',
      'duplicated_labels',
      'labels_with_null_cell',
      'labels_with_non_integer_cell',
    ])
      expect(count?.sql).toContain(`as "${column}"`);
    expect(count?.sql).not.toContain('limit');
    expect(count?.sql).not.toContain('order by');
    expect(page?.sql).toContain('order by ec.source_label collate "C" limit');
    expect(page?.sql).toMatch(/limit \$\d+ offset \$\d+$/u);
    expect(page?.parameters.slice(-2)).toEqual([50, 100]);
  });

  it('refuses a cell or integrity count that is not an exact non-negative integer', async () => {
    for (const [competitor, integrity] of [
      [{ ...COMPETITOR, voturi_cells: '1.5' }, INTEGRITY],
      [COMPETITOR, { ...INTEGRITY, duplicated_labels: '-1' }],
      [COMPETITOR, { ...INTEGRITY, labels: '' }],
    ] as const) {
      const { repo } = reportCapture(competitor, integrity);
      const result = await repo.countySourceReport({
        contestKey: CONTEST.contest_key,
        page: 1,
        pageSize: 20,
      });
      expect(result._unsafeUnwrapErr().type).toBe('Database');
    }
  });
});
