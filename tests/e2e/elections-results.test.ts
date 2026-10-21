/**
 * Elections results against a REAL PostgreSQL: the scrapper's actual elections
 * DDL (two digest-pinned prod migrations, read from the sibling checkout or
 * `SCRAPPER_REPO_ROOT`: the domain schema and the serving generations with
 * their triggers and active views) under the real redesign app, driven over
 * REST, GraphQL and the `/api/v1/mcp` JSON-RPC path. It proves what the
 * SQL-text tests cannot: only the ACTIVE generation is read (an older sealed
 * generation of the same event, and a sealed but never activated event, hold
 * values that must never appear), counts agree with pages, keys sort in
 * `collate "C"` order, territory names join by SIRUTA and county code (a
 * retired SIRUTA has none), and the three surfaces answer alike. Values are
 * illustrative. `core.territories` is a stand-in with the columns the reader
 * uses; it belongs to the kernel, not to the elections DDL under proof.
 *
 * TARGET. Only an EXTERNAL fixture the primary created and owns; this suite
 * starts no container and never drops or stops anything. Run it with
 * `vitest.elections-e2e.config.ts` (no shared e2e setup). It needs
 * `TEST_DATABASE_URL` + `ELECTIONS_TEST_FIXTURE_ID`: the URL must be exactly
 * `postgres://elections_api_test:<password>@127.0.0.1:<port>/elections_api_<fixtureId>`
 * with no query or fragment. Before any DDL the suite checks the pins, then
 * `current_database()` / `current_user`, a `fixture_control.ownership` table
 * holding exactly one row whose `fixture_id` is the fixture id, and that no
 * `elections` or `core` namespace exists yet. Any failed check fails the run.
 * Without a fixture id it SKIPS, unless `TEST_E2E_REQUIRED=1`, which makes it
 * fail. Teardown closes the app and the setup pool and fails on either error.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '../../src/app/build-redesign-app.js';

import type { FastifyInstance } from 'fastify';

const SIBLING_SCRAPPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../hack-for-facts-eb-scrapper'
);
const scrapper =
  process.env['SCRAPPER_REPO_ROOT'] ??
  (existsSync(path.join(SIBLING_SCRAPPER, 'node_modules/kysely')) ? SIBLING_SCRAPPER : undefined);
const required = process.env['TEST_E2E_REQUIRED'] === '1';
const FIXTURE_ID = process.env['ELECTIONS_TEST_FIXTURE_ID'] ?? '';
const TARGET_URL = process.env['TEST_DATABASE_URL'] ?? '';

const FIXTURE_ID_RE = /^[a-z0-9][a-z0-9_]{0,39}$/u;
const FIXTURE_LOGIN = 'elections_api_test';
const FIXTURE_HOST = '127.0.0.1';

/** Validate the external fixture target without connecting and without echoing the URL. */
const fixtureTarget = (url: string, fixtureId: string): { readonly database: string } => {
  if (!FIXTURE_ID_RE.test(fixtureId))
    throw new Error('ELECTIONS_TEST_FIXTURE_ID must match ^[a-z0-9][a-z0-9_]{0,39}$');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    throw new Error('TEST_DATABASE_URL must be a postgres URL');
  if (parsed.search !== '' || parsed.hash !== '')
    throw new Error('TEST_DATABASE_URL must carry no query options or fragment');
  if (parsed.hostname !== FIXTURE_HOST || parsed.port === '')
    throw new Error('TEST_DATABASE_URL must name 127.0.0.1 with an explicit port');
  if (decodeURIComponent(parsed.username) !== FIXTURE_LOGIN)
    throw new Error(`TEST_DATABASE_URL must log in as ${FIXTURE_LOGIN}`);
  const database = `elections_api_${fixtureId}`;
  if (decodeURIComponent(parsed.pathname.slice(1)) !== database)
    throw new Error('TEST_DATABASE_URL must name the elections_api_<fixtureId> database');
  return { database };
};

/** The connection is the declared fixture, owned by this fixture id, with no elections or core schema yet. */
const assertFixture = async (
  db: Kysely<unknown>,
  database: string,
  fixtureId: string
): Promise<void> => {
  const identity = await sql<{
    database: string;
    login: string;
    marker: string | null;
    elections: string | null;
    core: string | null;
  }>`select current_database() as database, current_user as login,
            to_regclass('fixture_control.ownership')::text as marker,
            to_regnamespace('elections')::text as elections,
            to_regnamespace('core')::text as core`.execute(db);
  const row = identity.rows[0];
  if (row?.database !== database || row.login !== FIXTURE_LOGIN)
    throw new Error('the connection is not the declared Elections fixture database and login');
  if (row.marker === null) throw new Error('fixture_control.ownership is missing');
  const marker = await sql<{ total: string; matching: string }>`
    select count(*)::text as total,
           count(*) filter (where fixture_id = ${fixtureId})::text as matching
    from fixture_control.ownership`.execute(db);
  if (marker.rows[0]?.total !== '1' || marker.rows[0].matching !== '1')
    throw new Error('fixture_control.ownership must hold exactly this fixture id');
  if (row.elections !== null || row.core !== null)
    throw new Error(
      'the elections or core namespace already exists; the proof needs a fresh fixture'
    );
};

const MIGRATIONS = [
  [
    '20260617T200000__elections_domain',
    '755d59984aaae9b1fd9f4d8e6f714461b9bf6c23725917e06ea8ae4a1b9b7900',
  ],
  [
    '20261020T140000__elections_serving_generations',
    'f026f522f59d59a991c5fbaa6452c013491ec6763a0fce836f9de1448fae0d69',
  ],
] as const;

// ── Seed ──

const LOCAL = 'ro:local:2024';
const JUNE = 'ro:local:2024:2024-06-09';
const RUNOFF = 'ro:local:2024:2024-06-23';
const PARL = 'ro:parliamentary:2020';
const DEC = 'ro:parliamentary:2020:2020-12-06';
const UNPUBLISHED = 'ro:local:2016';
const ALBA = `${JUNE}:mayor:uat:1017`;
const CLUJ = `${JUNE}:mayor:uat:54975`;
const RETIRED = `${JUNE}:mayor:uat:63171`;
const ANNULLED = `${JUNE}:mayor:uat:1026`;
const REPEAT = `${RUNOFF}:mayor:uat:1026`;
const COUNCIL = `${JUNE}:county_council:county:AB`;
const CAPITAL = `${JUNE}:general_mayor:uat:179132`;
const MIXED = `${RUNOFF}:mayor:uat:179141`;
const SUSPECTED = `${RUNOFF}:mayor:uat:54975`;
const CHAMBER = `${DEC}:chamber:county:CJ`;
const ABROAD = `${DEC}:chamber:diaspora`;
const IND = `${CLUJ}:ind:ion-pop`;
/** A value only the inactive or unpublished generations hold. */
const NEVER = '999999';

const GENERATION_TABLES = [
  'serving_occurrences',
  'serving_contests',
  'serving_competitors',
  'serving_candidacies',
  'serving_source_selections',
  'result_tallies',
  'candidate_tallies',
  'turnout_figures',
  'figure_coverage',
] as const;

type FigureExtra =
  { completeness?: string; diaspora?: boolean; status?: string; issues?: string[] } | undefined;
type Tally = readonly [
  occurrence: string,
  office: string,
  contest: string | null,
  scope: string,
  competitor: string,
  measure: 'votes' | 'mandates',
  phase: string,
  value: string,
  extra?: FigureExtra,
];
type Turnout = readonly [
  occurrence: string,
  office: string,
  contest: string | null,
  scope: string,
  measure: string,
  value: string,
  extra?: FigureExtra,
];

const scopeType = (key: string) => (key.includes(':') ? key.slice(0, key.indexOf(':')) : key);

const insertTallies = (publication: number, rows: readonly Tally[]) =>
  sql`
    insert into elections.result_tallies (publication_id, occurrence_key, office, contest_key,
      scope_key, scope_type, competitor_key, reported_label, measure, allocation_phase, value,
      construction, source_level, finality, counted_population, geographic_completeness,
      includes_diaspora, status, issues, decision_ids, source_pointer)
    values ${sql.join(
      rows.map(
        ([occurrence, office, contest, scope, competitor, measure, phase, value, extra]) => sql`(
          ${publication}, ${occurrence}, ${office}, ${contest}, ${scope}, ${scopeType(scope)},
          ${competitor}, ${`LABEL ${competitor}`}, ${measure}, ${phase}, ${value}::bigint,
          'summed_leaves', 'pv_lines', 'final', 'all', ${extra?.completeness ?? 'complete'},
          ${extra?.diaspora ?? null}, ${extra?.status ?? 'UNCHECKED'}, ${extra?.issues ?? []}::text[],
          '{}'::text[], '{}'::jsonb)`
      )
    )}`;

const insertTurnout = (publication: number, rows: readonly Turnout[]) =>
  sql`
    insert into elections.turnout_figures (publication_id, occurrence_key, office, contest_key,
      scope_key, scope_type, measure, value, construction, source_level, finality,
      geographic_completeness, includes_diaspora, status, issues, decision_ids, source_pointer)
    values ${sql.join(
      rows.map(
        ([occurrence, office, contest, scope, measure, value, extra]) => sql`(
          ${publication}, ${occurrence}, ${office}, ${contest}, ${scope}, ${scopeType(scope)},
          ${measure}, ${value}::bigint, 'summed_leaves', 'pv_lines', 'final',
          ${extra?.completeness ?? 'complete'}, ${extra?.diaspora ?? null},
          ${extra?.status ?? 'UNCHECKED'}, ${extra?.issues ?? []}::text[], '{}'::text[], '{}'::jsonb)`
      )
    )}`;

const turnoutOf = (
  occurrence: string,
  office: string,
  contest: string | null,
  scope: string,
  [registered, voted, valid, invalid]: readonly [string, string, string, string],
  extra?: FigureExtra
): Turnout[] => [
  [occurrence, office, contest, scope, 'registered', registered, extra],
  [occurrence, office, contest, scope, 'voted', voted, extra],
  [occurrence, office, contest, scope, 'valid', valid, extra],
  [occurrence, office, contest, scope, 'invalid', invalid, extra],
];

const publish = async (
  db: Kysely<unknown>,
  event: string,
  manifestDigit: string,
  fill: (publication: number) => Promise<void>,
  activate: boolean
): Promise<number> => {
  const created = await sql<{ id: string }>`
    insert into elections.serving_publications (event_key, manifest_sha256, plan_sha256, manifest)
    values (${event}, ${manifestDigit.repeat(64)}, ${'e'.repeat(64)}, '{}'::jsonb)
    returning publication_id::text as id`.execute(db);
  const publication = Number(created.rows[0]?.id);
  await fill(publication);
  await sql`
    insert into elections.serving_publication_seals (publication_id, row_counts)
    select ${publication}::bigint, jsonb_build_object(${sql.join(
      GENERATION_TABLES.map(
        (table) =>
          sql`${table}::text, (select count(*) from ${sql.id('elections', table)} where publication_id = ${publication})`
      )
    )})`.execute(db);
  if (activate) {
    await sql`
      insert into elections.serving_activations (event_key, publication_id)
      values (${event}, ${publication})`.execute(db);
    await sql`
      insert into elections.serving_active (event_key, publication_id, activation_id, activated_at)
      select event_key, publication_id, activation_id, timestamptz '2026-10-20 17:45:00+00'
      from elections.serving_activations where publication_id = ${publication}`.execute(db);
  }
  return publication;
};

const seed = async (db: Kysely<unknown>): Promise<void> => {
  await sql`create schema core`.execute(db);
  await sql`
    create table core.territories (
      id integer primary key, siruta_code text, name text not null,
      county_code text not null, county_name text not null
    )`.execute(db);
  await sql`
    insert into core.territories (id, siruta_code, name, county_code, county_name) values
      (1, '1017', 'MUNICIPIUL ALBA IULIA', 'AB', 'ALBA'),
      (2, '1026', 'ALBAC', 'AB', 'ALBA'),
      (3, '54975', 'MUNICIPIUL CLUJ-NAPOCA', 'CJ', 'CLUJ'),
      (4, '179132', 'MUNICIPIUL BUCUREȘTI', 'B', 'MUNICIPIUL BUCUREȘTI'),
      (5, '179141', 'SECTORUL 1', 'B', 'MUNICIPIUL BUCUREȘTI'),
      (6, null, 'Centru', 'AB', 'ALBA')`.execute(db);

  const competitors = (publication: number, rows: readonly (readonly string[])[]) =>
    sql`
      insert into elections.serving_competitors (publication_id, competitor_key, competitor_kind,
        actor_key, display_label, reported_labels, decision_ids)
      values ${sql.join(
        rows.map(
          ([key = '', kind = '', actor = '', label = '']) =>
            sql`(${publication}, ${key}, ${kind}, ${actor === '' ? null : actor}, ${label},
              array[${label}]::text[], '{}'::text[])`
        )
      )}`;
  const occurrences = (publication: number, rows: readonly (readonly string[])[]) =>
    sql`
      insert into elections.serving_occurrences (publication_id, occurrence_key, event_key,
        ballot_date, round_label, occurrence_kind, status, decision_ids)
      values ${sql.join(
        rows.map(
          ([key = '', event = '', date = '', round = '', kind = '']) =>
            sql`(${publication}, ${key}, ${event}, ${date}::date, ${round}, ${kind}, 'held', '{}'::text[])`
        )
      )}`;
  const contests = (publication: number, rows: readonly (readonly (string | null)[])[]) =>
    sql`
      insert into elections.serving_contests (publication_id, contest_key, occurrence_key, office,
        jurisdiction_key, status, replaced_by, decision_ids)
      values ${sql.join(
        rows.map(
          ([key, occurrence, office, jurisdiction, status, replaced]) =>
            sql`(${publication}, ${key}, ${occurrence}, ${office}, ${jurisdiction}, ${status},
              ${replaced ?? null}, '{}'::text[])`
        )
      )}`;

  // An older sealed generation of the local event, never active.
  await publish(
    db,
    LOCAL,
    'a',
    async (p) => {
      await occurrences(p, [[JUNE, LOCAL, '2024-06-09', 'r1', 'general']]).execute(db);
      await contests(p, [[ALBA, JUNE, 'mayor', 'uat:1017', 'held', null]]).execute(db);
      await competitors(p, [['partidul-a', 'party', 'partidul-a', 'PARTIDUL A']]).execute(db);
      await insertTallies(p, [
        [JUNE, 'mayor', ALBA, 'uat:1017', 'partidul-a', 'votes', 'none', NEVER],
      ]).execute(db);
    },
    false
  );

  // The active local generation.
  await publish(
    db,
    LOCAL,
    'b',
    async (p) => {
      await occurrences(p, [
        [JUNE, LOCAL, '2024-06-09', 'r1', 'general'],
        [RUNOFF, LOCAL, '2024-06-23', 'r2', 'runoff'],
      ]).execute(db);
      await contests(p, [
        [ALBA, JUNE, 'mayor', 'uat:1017', 'held', null],
        [CLUJ, JUNE, 'mayor', 'uat:54975', 'held', null],
        [RETIRED, JUNE, 'mayor', 'uat:63171', 'held', null],
        [ANNULLED, JUNE, 'mayor', 'uat:1026', 'annulled', REPEAT],
        [COUNCIL, JUNE, 'county_council', 'county:AB', 'held', null],
        [CAPITAL, JUNE, 'general_mayor', 'uat:179132', 'held', null],
        [REPEAT, RUNOFF, 'mayor', 'uat:1026', 'held', null],
        [MIXED, RUNOFF, 'mayor', 'uat:179141', 'held', null],
        [SUSPECTED, RUNOFF, 'mayor', 'uat:54975', 'held', null],
      ]).execute(db);
      await competitors(p, [
        ['partidul-a', 'party', 'partidul-a', 'PARTIDUL A'],
        ['partidul-b', 'party', 'partidul-b', 'PARTIDUL B'],
        ['list:ro:local:2024:alianta-x', 'list', '', 'ALIANȚA X'],
        [IND, 'independent', '', 'ION POP'],
        ['~independent', 'independents_bucket', '', 'Independenți'],
      ]).execute(db);
      await sql`
        insert into elections.serving_source_selections (publication_id, decision_id,
          source_resource_id, source_file_version_id, archive_sha256, entry_path, entry_sha256,
          raw_row_count, format, occurrence_key, office, excluded_copies)
        values
          (${p}, 'sel:stations', 'local:fixture', 28, ${'1'.repeat(64)}, 'stations.csv',
           ${'2'.repeat(64)}, 509902, 'station-long', ${JUNE}, null, '[{"resource":"x"},{"resource":"y"}]'::jsonb),
          (${p}, 'sel:runoff', 'local:fixture', 28, ${'1'.repeat(64)}, 'runoff.csv',
           ${'3'.repeat(64)}, 16, 'runoff-long', ${RUNOFF}, 'mayor', '[]'::jsonb)`.execute(db);
      await insertTallies(p, [
        [JUNE, 'mayor', ALBA, 'uat:1017', 'partidul-a', 'votes', 'none', '500'],
        [JUNE, 'mayor', ALBA, 'uat:1017', 'partidul-b', 'votes', 'none', '300'],
        [JUNE, 'mayor', ALBA, 'uat:1017', 'list:ro:local:2024:alianta-x', 'votes', 'none', '150'],
        [JUNE, 'mayor', CLUJ, 'uat:54975', 'partidul-b', 'votes', 'none', '400'],
        [JUNE, 'mayor', CLUJ, 'uat:54975', 'partidul-a', 'votes', 'none', '400'],
        [JUNE, 'mayor', CLUJ, 'uat:54975', IND, 'votes', 'none', '100'],
        [JUNE, 'mayor', RETIRED, 'uat:63171', 'partidul-a', 'votes', 'none', '10'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-a', 'votes', 'none', '2000'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-b', 'votes', 'none', '1000'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-a', 'mandates', 'man_1', '20'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-b', 'mandates', 'man_1', '10'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-a', 'mandates', 'man_2', '1'],
        [JUNE, 'county_council', COUNCIL, 'county:AB', 'partidul-b', 'mandates', 'man_2', '0'],
        [JUNE, 'county_council', COUNCIL, 'uat:1017', 'partidul-a', 'votes', 'none', '1200'],
        [JUNE, 'county_council', COUNCIL, 'uat:1017', 'partidul-b', 'votes', 'none', '600'],
        [JUNE, 'county_council', COUNCIL, 'uat:1026', 'partidul-a', 'votes', 'none', '800'],
        [JUNE, 'county_council', COUNCIL, 'uat:1026', 'partidul-b', 'votes', 'none', '400'],
        [JUNE, 'general_mayor', CAPITAL, 'uat:179132', 'partidul-a', 'votes', 'none', '70'],
        [JUNE, 'general_mayor', CAPITAL, 'uat:179141', 'partidul-a', 'votes', 'none', '70'],
        [
          JUNE,
          'mayor',
          null,
          'county:AB',
          'partidul-a',
          'votes',
          'none',
          '500',
          { status: 'VERIFIED' },
        ],
        [
          JUNE,
          'mayor',
          null,
          'county:AB',
          'partidul-b',
          'votes',
          'none',
          '300',
          { status: 'VERIFIED' },
        ],
        [
          JUNE,
          'mayor',
          null,
          'county:AB',
          '~independent',
          'votes',
          'none',
          '150',
          { status: 'VERIFIED' },
        ],
        [
          JUNE,
          'mayor',
          null,
          'national',
          'partidul-a',
          'votes',
          'none',
          '910',
          { completeness: 'partial', diaspora: false, issues: ['MISSING_SCOPE:uat:1026'] },
        ],
        [
          JUNE,
          'mayor',
          null,
          'national',
          'partidul-b',
          'votes',
          'none',
          '700',
          { completeness: 'partial', diaspora: false, issues: ['MISSING_SCOPE:uat:1026'] },
        ],
        [RUNOFF, 'mayor', REPEAT, 'uat:1026', 'partidul-a', 'votes', 'none', '60'],
        [RUNOFF, 'mayor', REPEAT, 'uat:1026', 'partidul-b', 'votes', 'none', '40'],
        [RUNOFF, 'mayor', MIXED, 'uat:179141', 'partidul-a', 'votes', 'none', '100'],
        [
          RUNOFF,
          'mayor',
          MIXED,
          'uat:179141',
          'partidul-b',
          'votes',
          'none',
          '90',
          { completeness: 'partial', issues: ['MISSING_SCOPE:uat:1017'] },
        ],
        [
          RUNOFF,
          'mayor',
          SUSPECTED,
          'uat:54975',
          'partidul-a',
          'votes',
          'none',
          '300',
          { status: 'SUSPECT' },
        ],
        [RUNOFF, 'mayor', SUSPECTED, 'uat:54975', 'partidul-b', 'votes', 'none', '200'],
      ]).execute(db);
      await insertTurnout(p, [
        ...turnoutOf(JUNE, 'mayor', ALBA, 'uat:1017', ['2000', '1000', '950', '50']),
        ...turnoutOf(JUNE, 'mayor', CLUJ, 'uat:54975', ['1500', '920', '900', '20']),
        ...turnoutOf(JUNE, 'county_council', COUNCIL, 'county:AB', ['6000', '3100', '3000', '100']),
        ...turnoutOf(JUNE, 'county_council', COUNCIL, 'uat:1017', ['4000', '1900', '1800', '100']),
        ...turnoutOf(JUNE, 'mayor', null, 'county:AB', ['3500', '1000', '950', '50'], {
          status: 'VERIFIED',
        }),
        ...turnoutOf(JUNE, 'mayor', null, 'national', ['5000', '2000', '1610', '90'], {
          completeness: 'partial',
          diaspora: false,
          issues: ['MISSING_SCOPE:uat:1026'],
        }),
      ]).execute(db);
      await sql`
        insert into elections.figure_coverage (publication_id, occurrence_key, office, measure,
          allocation_phase, scope_type, scope_key, state, issues, decision_ids)
        values
          (${p}, ${JUNE}, 'mayor', 'votes', 'none', 'uat', null, 'usable', '{}', '{}'),
          (${p}, ${JUNE}, 'mayor', 'votes', 'none', 'uat', 'uat:1026', 'absent', '{SUPERSEDED_IN_EXPORT}', '{}'),
          (${p}, ${JUNE}, 'mayor', 'mandates', 'final', 'uat', null, 'absent', '{NO_ALLOCATION_EVIDENCE}', '{}')`.execute(
        db
      );
    },
    true
  );

  // The parliamentary event, active.
  await publish(
    db,
    PARL,
    'c',
    async (p) => {
      await occurrences(p, [[DEC, PARL, '2020-12-06', 'r1', 'general']]).execute(db);
      await contests(p, [
        [CHAMBER, DEC, 'chamber', 'county:CJ', 'held', null],
        [ABROAD, DEC, 'chamber', 'diaspora', 'held', null],
      ]).execute(db);
      await competitors(p, [
        ['partidul-a', 'party', 'partidul-a', 'PARTIDUL A'],
        ['partidul-b', 'party', 'partidul-b', 'PARTIDUL B'],
      ]).execute(db);
      await insertTallies(p, [
        [DEC, 'chamber', CHAMBER, 'county:CJ', 'partidul-a', 'votes', 'none', '100'],
        [DEC, 'chamber', CHAMBER, 'county:CJ', 'partidul-b', 'votes', 'none', '50'],
        [DEC, 'chamber', ABROAD, 'diaspora', 'partidul-a', 'votes', 'none', '39'],
        [
          DEC,
          'chamber',
          null,
          'national',
          'partidul-a',
          'votes',
          'none',
          '139',
          { diaspora: true },
        ],
        [DEC, 'chamber', null, 'national', 'partidul-b', 'votes', 'none', '50', { diaspora: true }],
      ]).execute(db);
      await insertTurnout(p, [
        ...turnoutOf(DEC, 'chamber', CHAMBER, 'county:CJ', ['300', '160', '150', '8']),
        ...turnoutOf(DEC, 'chamber', ABROAD, 'diaspora', ['10', '40', '39', '1']),
        [
          DEC,
          'chamber',
          ABROAD,
          'diaspora',
          'blank',
          '0',
          {
            completeness: 'partial',
            issues: ['MEASURE_NOT_IN_INPUT:sel:ro:parliamentary:2020:chamber-postal'],
          },
        ],
      ]).execute(db);
    },
    true
  );

  // A sealed event that was never activated.
  await publish(
    db,
    UNPUBLISHED,
    'd',
    async (p) => {
      await occurrences(p, [
        ['ro:local:2016:2016-06-05', UNPUBLISHED, '2016-06-05', 'r1', 'general'],
      ]).execute(db);
      await competitors(p, [['partidul-a', 'party', 'partidul-a', NEVER]]).execute(db);
    },
    false
  );
};

// ── Surfaces ──

let setupDb: Kysely<unknown> | undefined;
let app: FastifyInstance | undefined;
let mcpCalls = 0;

const requireApp = (): FastifyInstance => {
  if (app === undefined) throw new Error('elections e2e app is not ready');
  return app;
};

interface RestBody {
  ok: boolean;
  data?: unknown;
  meta?: { page?: { page?: number; pageSize?: number; total?: number }; hasMore?: boolean };
  error?: string;
}

const rest = async (url: string) => {
  const res = await requireApp().inject({ method: 'GET', url: `/api/v1/elections${url}` });
  expect(res.body).not.toContain(NEVER);
  return { status: res.statusCode, raw: res.body, body: res.json<RestBody>() };
};

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { message: string; extensions?: Record<string, unknown> }[];
}

const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const res = await requireApp().inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  expect(res.body).not.toContain(NEVER);
  return { status: res.statusCode, raw: res.body, body: res.json<GqlBody>() };
};

const gqlData = async (root: string, query: string, variables: Record<string, unknown> = {}) => {
  const res = await gql(query, variables);
  expect(res.status, res.raw).toBe(200);
  expect(res.body.errors, res.raw).toBeUndefined();
  return res.body.data?.[root];
};

const mcp = async (name: string, args: Record<string, unknown>) => {
  mcpCalls += 1;
  const res = await requireApp().inject({
    method: 'POST',
    url: '/api/v1/mcp',
    remoteAddress: `10.0.0.${String(mcpCalls)}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: mcpCalls,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).not.toContain(NEVER);
  const content = res.json<{ result?: { structuredContent?: Record<string, unknown> } }>().result
    ?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return content;
};

const SHARE = 'percent numerator denominator basis';
const COMPETITOR = 'competitorKey kind actorKey label reportedLabels';
const PLACE = 'placeKey placeType sirutaCode countyCode name countyName';
const QUALITY =
  'value construction sourceLevel finality geographicCompleteness includesDiaspora status issues';
const TALLY = `competitor { ${COMPETITOR} } reportedLabel measure allocationPhase countedPopulation share { ${SHARE} } ${QUALITY}`;
const RACE_ENTRY = `competitor { ${COMPETITOR} } votes share { ${SHARE} }`;
const RACE = `competitorCount status geographicCompleteness finality issues leader { ${RACE_ENTRY} } runnerUp { ${RACE_ENTRY} } marginVotes marginPoints tied`;
const CONTEST = `contestKey occurrenceKey eventKey office jurisdiction { ${PLACE} } status replacedBy race { ${RACE} }`;
const FIGURES = `place { ${PLACE} } tallies { ${TALLY} } turnout { measure ${QUALITY} } participation { ${SHARE} } race { ${RACE} }`;
const RESULT = `occurrenceKey eventKey office contest { ${CONTEST} } ${FIGURES} coverage { measure allocationPhase placeSpecific state issues }`;
const OCCURRENCE =
  'occurrenceKey eventKey ballotDate round kind status offices { office contests }';
const EVENT = `eventKey family year publication { publicationId activatedAt } occurrences { ${OCCURRENCE} }`;

const ready = (skip: () => void): boolean => {
  if (app === undefined) {
    skip();
    return false;
  }
  return true;
};

describe('elections fixture target guard (pure; no connection, no env)', () => {
  const ID = 'run_1';
  const AT = `postgres://elections_api_test:pw-x@127.0.0.1:55432/elections_api_${ID}`;

  it('admits only the exact declared fixture target', () => {
    expect(fixtureTarget(AT, ID)).toEqual({ database: 'elections_api_run_1' });
  });

  it.each([
    ['a malformed fixture id', AT, 'Run-1'],
    ['connection options', `${AT}?options=-c%20search_path%3Dx`, ID],
    ['a fragment', `${AT}#x`, ID],
    ['another host', AT.replace('127.0.0.1', '10.0.0.1'), ID],
    ['an implicit port', AT.replace(':55432', ''), ID],
    ['another login', AT.replace('elections_api_test', 'postgres'), ID],
    ['another database', AT.replace(`elections_api_${ID}`, 'transparenta_prod'), ID],
    ['an unparseable URL', 'not a url', ID],
  ])('rejects %s without echoing the URL', (_label, url, id) => {
    let message = '';
    try {
      fixtureTarget(url, id);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('pw-x');
    expect(message).not.toContain('55432');
  });
});

describe('elections results — real DDL, real app, external fixture', () => {
  beforeAll(async () => {
    if (FIXTURE_ID === '' && !required) {
      console.warn(
        'Elections SQL proof skipped: ELECTIONS_TEST_FIXTURE_ID is unset (TEST_E2E_REQUIRED=1 fails instead)'
      );
      return;
    }
    if (FIXTURE_ID === '' || TARGET_URL === '')
      throw new Error(
        'Elections SQL proof requires TEST_DATABASE_URL and ELECTIONS_TEST_FIXTURE_ID'
      );
    const { database } = fixtureTarget(TARGET_URL, FIXTURE_ID);
    if (scrapper === undefined)
      throw new Error('Elections SQL proof requires SCRAPPER_REPO_ROOT or the sibling checkout');
    const files: string[] = [];
    for (const [name, digest] of MIGRATIONS) {
      const file = path.join(scrapper, 'src/db/prod-migrations', `${name}.ts`);
      const actual = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
      if (actual !== digest) throw new Error(`${name} does not match its pinned digest`);
      files.push(file);
    }
    setupDb = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: TARGET_URL,
          max: 1,
          connectionTimeoutMillis: 10_000,
          idleTimeoutMillis: 10_000,
          statement_timeout: 15_000,
          query_timeout: 20_000,
        }),
      }),
    });
    await assertFixture(setupDb, database, FIXTURE_ID);
    for (const file of files) {
      const migration = (await import(pathToFileURL(file).href)) as {
        up: (db: Kysely<unknown>) => Promise<void>;
      };
      await migration.up(setupDb);
    }
    await seed(setupDb);
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules: ['elections'],
      electionsEnabled: true,
      procurementWarmCache: false,
      kernelConfig: {
        prodDatabaseUrl: TARGET_URL,
        poolMax: 1,
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
    });
    app = built.app;
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => app?.close(), () => setupDb?.destroy()]) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Elections proof teardown failed');
  });

  it('lists only events with an active generation, alike on every surface', async ({ skip }) => {
    if (!ready(skip)) return;
    const restPage = await rest('/events?pageSize=1');
    expect(restPage.status, restPage.raw).toBe(200);
    expect(restPage.body.meta).toEqual({
      page: { page: 1, pageSize: 1, total: 2 },
      hasMore: true,
      totalCounts: 'events',
    });
    const all = await rest('/events');
    const events = all.body.data as { eventKey: string }[];
    expect(events.map((event) => event.eventKey)).toEqual([LOCAL, PARL]);
    const graph = (await gqlData(
      'electionEvents',
      `{ electionEvents { items { ${EVENT} } total hasMore } }`
    )) as { items: unknown[]; total: number };
    expect(graph.items).toEqual(all.body.data);
    expect(graph.total).toBe(2);
    const tool = await mcp('list_election_events', {});
    expect(tool['items']).toEqual(all.body.data);
    expect(events[0]).toMatchObject({
      eventKey: LOCAL,
      family: 'local',
      year: 2024,
      publication: { activatedAt: '2026-10-20T17:45:00.000Z' },
      occurrences: [
        {
          occurrenceKey: JUNE,
          ballotDate: '2024-06-09',
          round: 'r1',
          kind: 'general',
          status: 'held',
          offices: [
            { office: 'county_council', contests: 1 },
            { office: 'general_mayor', contests: 1 },
            { office: 'mayor', contests: 4 },
          ],
        },
        {
          occurrenceKey: RUNOFF,
          round: 'r2',
          kind: 'runoff',
          offices: [{ office: 'mayor', contests: 3 }],
        },
      ],
    });
    expect((await rest(`/events/lookup?eventKey=${UNPUBLISHED}`)).status).toBe(404);
  });

  it('looks an event up as listed, without internal source identifiers', async ({ skip }) => {
    if (!ready(skip)) return;
    const res = await rest(`/events/lookup?eventKey=${encodeURIComponent(LOCAL)}`);
    expect(res.status, res.raw).toBe(200);
    const listed = (await rest('/events')).body.data as unknown[];
    expect(res.body.data).toEqual(listed[0]);
    const graph = await gqlData(
      'electionEvent',
      `query($k: ID!) { electionEvent(eventKey: $k) { ${EVENT} } }`,
      { k: LOCAL }
    );
    expect(graph).toEqual(res.body.data);
    for (const internal of ['sel:', 'local:fixture', 'stations.csv', '1'.repeat(64)])
      expect(res.raw).not.toContain(internal);
  });

  it('pages contests in C key order with races, and filters by office, type, county and status', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const occ = encodeURIComponent(JUNE);
    const all = await rest(`/contests?occurrenceKey=${occ}&pageSize=100`);
    const keys = (all.body.data as { contestKey: string }[]).map((contest) => contest.contestKey);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(keys).toHaveLength(6);
    expect(all.body.meta?.page?.total).toBe(6);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await rest(`/contests?occurrenceKey=${occ}&pageSize=2&page=${String(page)}`);
      seen.push(
        ...(res.body.data as { contestKey: string }[]).map((contest) => contest.contestKey)
      );
    }
    expect(seen).toEqual(keys);
    const filtered = async (query: string) =>
      (
        (await rest(`/contests?occurrenceKey=${occ}&${query}`)).body.data as {
          contestKey: string;
        }[]
      ).map((contest) => contest.contestKey);
    expect(await filtered('offices=county_council')).toEqual([COUNCIL]);
    expect(await filtered('jurisdictionTypes=county')).toEqual([COUNCIL]);
    expect((await filtered('countyCodes=AB')).sort()).toEqual([ALBA, ANNULLED, COUNCIL].sort());
    expect(await filtered('countyCodes=B')).toEqual([CAPITAL]);
    expect(await filtered('statuses=annulled')).toEqual([ANNULLED]);
    expect(await filtered('offices=mayor&offices=general_mayor&countyCodes=CJ')).toEqual([CLUJ]);
    const graph = (await gqlData(
      'electionContests',
      `query($o: ID!) { electionContests(occurrenceKey: $o, pageSize: 100) { items { ${CONTEST} } total } }`,
      { o: JUNE }
    )) as { items: unknown[] };
    expect(graph.items).toEqual(all.body.data);
    const tool = await mcp('list_election_contests', {
      occurrenceKey: JUNE,
      filter: { offices: { in: ['county_council'] } },
    });
    expect(
      (tool['items'] as { contestKey: string }[]).map((contest) => contest.contestKey)
    ).toEqual([COUNCIL]);
  });

  it('computes races from the votes at the jurisdiction: margin, tie, unmapped place, annulled', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const contest = async (key: string) =>
      (await rest(`/contests/lookup?contestKey=${encodeURIComponent(key)}`)).body.data as Record<
        string,
        unknown
      >;
    expect(await contest(ALBA)).toMatchObject({
      jurisdiction: {
        placeKey: 'uat:1017',
        placeType: 'uat',
        sirutaCode: '1017',
        countyCode: 'AB',
        name: 'MUNICIPIUL ALBA IULIA',
        countyName: 'ALBA',
      },
      status: 'held',
      race: {
        competitorCount: 3,
        status: 'UNCHECKED',
        geographicCompleteness: 'complete',
        finality: 'final',
        issues: [],
        leader: {
          competitor: { competitorKey: 'partidul-a' },
          votes: '500',
          share: { percent: '52.63', numerator: '500', denominator: '950' },
        },
        runnerUp: { competitor: { competitorKey: 'partidul-b' }, votes: '300' },
        marginVotes: '200',
        marginPoints: '21.05',
        tied: false,
      },
    });
    expect(await contest(CLUJ)).toMatchObject({
      race: {
        competitorCount: 3,
        leader: { competitor: { competitorKey: 'partidul-a' }, votes: '400' },
        runnerUp: { competitor: { competitorKey: 'partidul-b' }, votes: '400' },
        marginVotes: '0',
        tied: true,
      },
    });
    expect(await contest(RETIRED)).toMatchObject({
      jurisdiction: { placeKey: 'uat:63171', sirutaCode: '63171', name: null, countyCode: null },
      race: { competitorCount: 1, runnerUp: null, marginVotes: null, leader: { share: null } },
    });
    expect(await contest(ANNULLED)).toMatchObject({
      status: 'annulled',
      replacedBy: REPEAT,
      race: null,
    });
    expect(
      (await rest(`/contests/lookup?contestKey=${encodeURIComponent(`${JUNE}:mayor:uat:9`)}`))
        .status
    ).toBe(404);
    // Votes of different coverage, or a suspect tally: no race on any surface.
    for (const key of [MIXED, SUSPECTED]) {
      expect((await contest(key))['race'], key).toBeNull();
      const graph = (await gqlData(
        'electionContest',
        `query($k: ID!) { electionContest(contestKey: $k) { race { ${RACE} } } }`,
        { k: key }
      )) as { race: unknown };
      expect(graph.race).toBeNull();
      const tool = await mcp('list_election_contests', { occurrenceKey: RUNOFF });
      const listed = (tool['items'] as { contestKey: string; race: unknown }[]).find(
        (item) => item.contestKey === key
      );
      expect(listed?.race).toBeNull();
    }
  });

  it('serves every figure of a contest place with shares, participation and coverage', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const query = `occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeKey=uat:1017&contestKey=${encodeURIComponent(ALBA)}`;
    const res = await rest(`/results/lookup?${query}`);
    expect(res.status, res.raw).toBe(200);
    const result = res.body.data as {
      tallies: { competitor: { competitorKey: string }; value: string; share: unknown }[];
      turnout: { measure: string; value: string }[];
      participation: unknown;
      coverage: unknown[];
      race: unknown;
      contest: { contestKey: string; race: unknown };
    };
    expect(result.tallies.map((tally) => [tally.competitor.competitorKey, tally.value])).toEqual([
      ['partidul-a', '500'],
      ['partidul-b', '300'],
      ['list:ro:local:2024:alianta-x', '150'],
    ]);
    expect(result.tallies[2]?.share).toEqual({
      percent: '15.79',
      numerator: '150',
      denominator: '950',
      basis: 'valid_votes_same_scope',
    });
    expect(result.turnout.map((figure) => figure.measure)).toEqual([
      'registered',
      'voted',
      'valid',
      'invalid',
    ]);
    expect(result.participation).toEqual({
      percent: '50.00',
      numerator: '1000',
      denominator: '2000',
      basis: 'registered_same_scope',
    });
    expect(result.coverage).toEqual([
      {
        measure: 'mandates',
        allocationPhase: 'final',
        placeSpecific: false,
        state: 'absent',
        issues: ['NO_ALLOCATION_EVIDENCE'],
      },
      {
        measure: 'votes',
        allocationPhase: 'none',
        placeSpecific: false,
        state: 'usable',
        issues: [],
      },
    ]);
    expect(result.contest.contestKey).toBe(ALBA);
    expect(result.contest.race).toEqual(result.race);
    const graph = await gqlData(
      'electionResult',
      `query($o: ID!, $c: ID) { electionResult(occurrenceKey: $o, office: "mayor", scopeKey: "uat:1017", contestKey: $c) { ${RESULT} } }`,
      { o: JUNE, c: ALBA }
    );
    expect(graph).toEqual(res.body.data);
    const tool = await mcp('get_election_result', {
      occurrenceKey: JUNE,
      office: 'mayor',
      scopeKey: 'uat:1017',
      contestKey: ALBA,
    });
    expect(tool['item']).toEqual(res.body.data);
  });

  it('serves office aggregates without a race, with partial shares only against matching partial valid votes', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const county = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeKey=county:AB`
    );
    expect(county.status, county.raw).toBe(200);
    expect(county.body.data).toMatchObject({
      contest: null,
      race: null,
      place: {
        placeKey: 'county:AB',
        placeType: 'county',
        countyCode: 'AB',
        name: 'ALBA',
        countyName: 'ALBA',
      },
      tallies: [
        {
          competitor: { competitorKey: 'partidul-a' },
          status: 'VERIFIED',
          share: { percent: '52.63' },
        },
        { competitor: { competitorKey: 'partidul-b' } },
        { competitor: { competitorKey: '~independent', kind: 'independents_bucket' } },
      ],
    });
    const national = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeKey=national`
    );
    const data = national.body.data as {
      tallies: { share: { percent: string } | null; includesDiaspora: boolean | null }[];
      participation: unknown;
      place: { name: string | null };
    };
    expect(data.place.name).toBeNull();
    expect(data.tallies[0]).toMatchObject({ includesDiaspora: false, share: { percent: '56.52' } });
    // Partial registered and voted: participation is not derived.
    expect(data.participation).toBeNull();
    const notThere = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeKey=uat:9999`
    );
    expect(notThere.status).toBe(404);
    // A place-specific coverage cell answers even without figures.
    const absent = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeKey=uat:1026`
    );
    expect(absent.status, absent.raw).toBe(200);
    expect(absent.body.data).toMatchObject({
      tallies: [],
      coverage: expect.arrayContaining([
        expect.objectContaining({
          placeSpecific: true,
          state: 'absent',
          issues: ['SUPERSEDED_IN_EXPORT'],
        }),
      ]) as unknown,
    });
  });

  it('pages breakdowns: a contest excludes its own jurisdiction, aggregates list their places', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const breakdown = await rest(
      `/results?occurrenceKey=${encodeURIComponent(JUNE)}&office=county_council&scopeType=uat&contestKey=${encodeURIComponent(COUNCIL)}`
    );
    expect(breakdown.status, breakdown.raw).toBe(200);
    const items = breakdown.body.data as {
      place: { placeKey: string };
      race: { leader: { share: { percent: string } | null } } | null;
      turnout: unknown[];
    }[];
    expect(items.map((item) => item.place.placeKey)).toEqual(['uat:1017', 'uat:1026']);
    expect(breakdown.body.meta?.page?.total).toBe(2);
    expect(items[0]?.race?.leader.share?.percent).toBe('66.67');
    // No valid votes at uat:1026: no shares, the race still ranks.
    expect(items[1]?.turnout).toEqual([]);
    expect(items[1]?.race?.leader.share).toBeNull();
    const capital = await rest(
      `/results?occurrenceKey=${encodeURIComponent(JUNE)}&office=general_mayor&scopeType=uat&contestKey=${encodeURIComponent(CAPITAL)}`
    );
    expect(
      (capital.body.data as { place: { placeKey: string; name: string } }[]).map(
        (item) => item.place
      )
    ).toEqual([
      expect.objectContaining({ placeKey: 'uat:179141', name: 'SECTORUL 1', countyCode: 'B' }),
    ]);
    const counties = await rest(
      `/results?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeType=county`
    );
    expect(
      (counties.body.data as { place: { placeKey: string }; race: unknown }[]).map((item) => [
        item.place.placeKey,
        item.race,
      ])
    ).toEqual([['county:AB', null]]);
    const graph = (await gqlData(
      'electionResultScopes',
      `query($o: ID!, $c: ID) { electionResultScopes(occurrenceKey: $o, office: "county_council", scopeType: uat, contestKey: $c) { items { ${FIGURES} } total } }`,
      { o: JUNE, c: COUNCIL }
    )) as { items: unknown[] };
    expect(graph.items).toEqual(breakdown.body.data);
    const missing = await rest(
      `/results?occurrenceKey=${encodeURIComponent(JUNE)}&office=mayor&scopeType=uat&contestKey=${encodeURIComponent(COUNCIL)}`
    );
    expect(missing.status).toBe(404);
  });

  it('never derives diaspora participation and marks national figures that include the diaspora', async ({
    skip,
  }) => {
    if (!ready(skip)) return;
    const abroad = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(DEC)}&office=chamber&scopeKey=diaspora&contestKey=${encodeURIComponent(ABROAD)}`
    );
    expect(abroad.body.data).toMatchObject({
      place: { placeKey: 'diaspora', placeType: 'diaspora', name: null },
      participation: null,
      tallies: [{ share: { percent: '100.00' } }],
    });
    const blank = (
      abroad.body.data as { turnout: { measure: string; issues: string[] }[] }
    ).turnout.find((figure) => figure.measure === 'blank');
    // The stored issue names a selection decision; only its public code is served.
    expect(blank?.issues).toEqual(['MEASURE_NOT_IN_INPUT']);
    expect(abroad.raw).not.toContain('sel:');
    const graph = await gql(
      `query($o: ID!, $c: ID) { electionResult(occurrenceKey: $o, office: "chamber", scopeKey: "diaspora", contestKey: $c) { ${RESULT} } }`,
      { o: DEC, c: ABROAD }
    );
    expect(graph.body.errors, graph.raw).toBeUndefined();
    expect(graph.body.data?.['electionResult']).toEqual(abroad.body.data);
    expect(graph.raw).not.toContain('sel:');
    const tool = await mcp('get_election_result', {
      occurrenceKey: DEC,
      office: 'chamber',
      scopeKey: 'diaspora',
      contestKey: ABROAD,
    });
    expect(tool['item']).toEqual(abroad.body.data);
    expect(JSON.stringify(tool)).not.toContain('sel:');
    const national = await rest(
      `/results/lookup?occurrenceKey=${encodeURIComponent(DEC)}&office=chamber&scopeKey=national`
    );
    expect(national.body.data).toMatchObject({
      tallies: [
        { includesDiaspora: true, share: null },
        { includesDiaspora: true, share: null },
      ],
      turnout: [],
    });
  });

  it('lists the competitors of the active generation only', async ({ skip }) => {
    if (!ready(skip)) return;
    const res = await rest(`/competitors?eventKey=${encodeURIComponent(LOCAL)}&kinds=party`);
    expect(
      (res.body.data as { competitorKey: string }[]).map((item) => item.competitorKey)
    ).toEqual(['partidul-a', 'partidul-b']);
    const all = await rest(`/competitors?eventKey=${encodeURIComponent(LOCAL)}`);
    expect(all.body.meta?.page?.total).toBe(5);
    const tool = await mcp('list_election_competitors', { eventKey: LOCAL });
    expect(tool['items']).toEqual(all.body.data);
    expect((await rest(`/competitors?eventKey=${UNPUBLISHED}`)).status).toBe(404);
  });
});
