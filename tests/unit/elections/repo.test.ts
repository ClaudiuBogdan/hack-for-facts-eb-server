/**
 * The Elections repository's compiled SQL, pinned over a capturing driver (no
 * database): dimension tables only, public rows only, public event links only,
 * named columns, C-collated key order, one read-only repeatable-read snapshot.
 */
import { describe, expect, it } from 'vitest';

import { makeElectionsModule } from '@/modules/elections/index.js';
import {
  mapContestRow,
  mapEditionRow,
  makeElectionsRepo,
  type ContestSqlRow,
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
    ]);
    for (const result of results) expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(captured).toEqual([]);
    const enabled = makeElectionsModule({ db: makeCapturingDb([]), enabled: true });
    expect(enabled.mcpTools.map((tool) => tool.name)).toEqual([
      'list_election_editions',
      'get_election_edition',
      'list_election_contests',
      'get_election_contest',
    ]);
  });
});
