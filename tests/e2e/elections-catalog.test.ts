/**
 * Elections catalog reads against a REAL PostgreSQL: the scrapper's actual
 * elections DDL (four digest-pinned prod migrations, read from the sibling
 * checkout or `SCRAPPER_REPO_ROOT`; the fourth, the held contest status, is on
 * scrapper main from 8e144361) under the real redesign app, driven over
 * REST, GraphQL and the `/api/v1/mcp` JSON-RPC path. It proves what the SQL-text
 * tests cannot: the privacy predicates filter (every stored row was public in
 * the 2026-10-02 snapshot, so live data cannot discriminate), counts agree
 * with the pages, keys sort in `collate "C"` order, dates read as YYYY-MM-DD,
 * the three surfaces answer alike, and no stored finality, correction or
 * `attrs` value reaches any of them. Held legacy contests (`identity_status =
 * 'held_legacy'`), seeded beside active contests of the same scope as the real
 * DDL allows, reach no count, page, filter, lookup or source report: a held
 * key answers exactly like an absent one.
 *
 * The county source report is proven over the same DDL under its
 * complete-source contract: each positive contest has the file's full shape
 * (12 statement cells, 234 labels with both cells; 231 synthetic zero-valued
 * labels plus three named ones). Next to it sit rows that each break exactly
 * one predicate (resource, file, file hash, package, explicit source column,
 * unit, privacy, competitor family), complete control contests whose only
 * defect is one contest-level or carrier-wide predicate (office, scope,
 * edition, restricted contest or unit, another resource), a contest missing
 * one label's pair (held), a label carried by two competitor ids beyond the
 * first page (refused), and map flips that withhold a4 or b4 (held). Only the
 * carrier's complete cells may reach REST or GraphQL. Values are illustrative.
 *
 * TARGET. Only an EXTERNAL fixture the primary created and owns; this suite
 * starts no container and never drops or stops anything. Run it with
 * `vitest.elections-e2e.config.ts` (no shared e2e setup). It needs
 * `TEST_DATABASE_URL` + `ELECTIONS_TEST_FIXTURE_ID`: the URL must be exactly
 * `postgres://elections_api_test:<password>@127.0.0.1:<port>/elections_api_<fixtureId>`
 * with no query or fragment. Before any DDL the suite checks the pins, then
 * `current_database()` / `current_user`, a `fixture_control.ownership` table
 * holding exactly one row whose `fixture_id` is the fixture id, and that no
 * `elections` namespace exists yet. Any failed check fails the run. Without
 * a fixture id it SKIPS, unless `TEST_E2E_REQUIRED=1`, which makes it fail.
 * Pools hold one connection with bounded connect and statement times; teardown
 * closes the app and the setup pool, attempts both, and fails on either error.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Kysely, PostgresDialect, sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '../../src/app/build-redesign-app.js';
import { GRAPHQL_ERROR_CODE } from '../../src/modules/shared/index.js';

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

/** The connection is the declared fixture, owned by this fixture id, with no elections schema yet. */
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
  }>`select current_database() as database, current_user as login,
            to_regclass('fixture_control.ownership')::text as marker,
            to_regnamespace('elections')::text as elections`.execute(db);
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
  if (row.elections !== null)
    throw new Error('the elections namespace already exists; the proof needs a fresh fixture');
};

const MIGRATIONS = [
  [
    '20260617T200000__elections_domain',
    '755d59984aaae9b1fd9f4d8e6f714461b9bf6c23725917e06ea8ae4a1b9b7900',
  ],
  [
    '20260627T140000__elections_canonical_events',
    'aec4caa117e2a7f8c1ed7d5d2cab7fa002ab3e319b32aa79d693db69ea562671',
  ],
  [
    '20260627T141000__elections_privacy_class',
    '366db29339cfea2ed53f2db3f4a060d84b54956bc4e9f560f54bab3f92c18fb6',
  ],
  [
    '20261017T180030__elections_contest_identity_status',
    'd7da30819264bf69f7103e80ac35f1a498a25cd0243cb11dd44598ccf5929952',
  ],
] as const;

/** Appears only in restricted rows and never-served columns; no response may contain it. */
const SENTINEL = 'SENTINEL';

const SEED = sql`
  insert into elections.electoral_events (event_key, office_family, event_year, display_name, privacy_class) values
    ('ro:local:2024', 'local', 2024, 'Alegeri locale 2024', 'public'),
    ('ro:european:2009', 'european', 2009, 'Europarlamentare 2009', 'public'),
    ('ro:hidden:2024', 'local', 2024, 'SENTINEL event', 'restricted');

  insert into elections.elections
    (election_key, election_family, election_name, election_date, election_year, election_round,
     authority, publication_status, is_final, attrs, event_id, corrected_family, result_status, privacy_class)
  values
    ('BEC-legacy-1992', 'parliamentary', 'Legacy 1992', null, 1992, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}', null, null, 'unknown', 'public'),
    ('bec-european-2009', 'parliamentary', 'Europarlamentare 2009', '2009-06-07', 2009, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}',
     (select event_id from elections.electoral_events where event_key = 'ro:european:2009'),
     'european', 'unknown', 'public'),
    ('bec-local-2024', 'local', 'Alegeri locale 2024', null, 2024, 'tur1',
     'BEC/AEP/ROAEP', 'candidate_list', true, '{"note":"SENTINEL attrs"}',
     (select event_id from elections.electoral_events where event_key = 'ro:local:2024'),
     null, 'final', 'public'),
    ('bec-local-2024-hidden-event', 'local', 'Hidden event link', null, 2024, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}',
     (select event_id from elections.electoral_events where event_key = 'ro:hidden:2024'),
     null, 'unknown', 'public'),
    ('roaep-election-databases-local-2024', 'local', 'Alegeri locale 2024 (ROAEP)', null, 2024, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}',
     (select event_id from elections.electoral_events where event_key = 'ro:local:2024'),
     null, 'unknown', 'public'),
    ('restricted-edition', 'local', 'SENTINEL edition', null, 2024, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}',
     (select event_id from elections.electoral_events where event_key = 'ro:local:2024'),
     null, 'unknown', 'restricted');

  insert into elections.contests
    (contest_key, election_id, office, round_label, scope_type, scope_key, scope_label,
     attrs, event_id, canonical_office, privacy_class)
  select v.contest_key, e.election_id, v.office, v.round_label, v.scope_type, v.scope_key, v.scope_label,
         v.attrs::jsonb, ev.event_id, v.canonical_office, v.privacy_class
  from (values
    ('bec-local-2024', 'k:mayor:1017', 'mayor', 'tur1', 'siruta', '1017', 'ALBA IULIA', '{}', 'ro:local:2024', null, 'public'),
    ('bec-local-2024', 'k:mayor:1017:tur2', 'mayor', 'tur2', 'siruta', '1017', 'ALBA IULIA', '{}', null, null, 'public'),
    ('bec-local-2024', 'k:mayor:179132', 'mayor', 'tur1', 'siruta', '179132', 'SECTOR 1', '{"note":"SENTINEL attrs"}', 'ro:local:2024', 'SENTINEL canonical', 'public'),
    ('bec-local-2024', 'k:local_council:1017', 'local_council', 'tur1', 'siruta', '1017', 'ALBA IULIA', '{}', 'ro:local:2024', null, 'public'),
    ('bec-local-2024', 'K:county_council:1', 'county_council', 'tur1', 'county', '1', 'ALBA', '{}', 'ro:hidden:2024', null, 'public'),
    ('bec-local-2024', 'k:mayor:restricted', 'mayor', 'tur1', 'siruta', '999', 'SENTINEL scope', '{}', 'ro:local:2024', null, 'restricted'),
    ('restricted-edition', 'k:under-restricted', 'mayor', 'tur1', 'siruta', '1017', 'ALBA IULIA', '{}', 'ro:local:2024', null, 'public')
  ) as v (election_key, contest_key, office, round_label, scope_type, scope_key, scope_label, attrs, event_key, canonical_office, privacy_class)
  join elections.elections e on e.election_key = v.election_key
  left join elections.electoral_events ev on ev.event_key = v.event_key;
`;

const CKAN_2020 = 'alegeri-pentru-autoritatile-administratiei-publice-locale-2020';
const COUNTY = (scopeKey: string) => `contest:aep-local-2020:mayor:county:${scopeKey}`;
const LOCAL_ELECTION = 'contest:aep-local-2020:local_election:county:1';
const SIRUTA = 'contest:aep-local-2020:mayor:siruta:1017';
const CKAN_CONTEST = 'contest:ckan-local-2020:mayor:county:1';
/** The last label in C order, carried a second time by another competitor id in county 7. */
const TWIN_LABEL = 'SINTETIC 231';

/** The qualified carrier (core/county-source.ts); `column` is the row's explicit source column. */
const CARRIER = {
  resource: 'local:a1c73906c6c3425fa483cb7c',
  file: '88',
  sha: 'aa7fa46554bee238ad70ce3f401d959c7b243f4c9a37564a2161cd201658ffea',
  pkg: 'aep-local-2020',
  privacy: 'public',
  column: null as string | null,
};
type Carrier = typeof CARRIER;

/** A held legacy contest with ALBA's scope; given a complete shape on the qualified carrier. */
const HELD_COUNTY = `${COUNTY('1')}:held-legacy`;

/**
 * Held legacy contests (the scrapper's `identity_status = 'held_legacy'`), each
 * sharing the edition, office, round and scope of an active contest. The real
 * DDL admits them only because active-scope uniqueness excludes held rows.
 */
const HELD_SEED = sql`
  insert into elections.contests
    (contest_key, election_id, office, round_label, scope_type, scope_key, scope_label,
     attrs, event_id, privacy_class, identity_status)
  select v.contest_key, e.election_id, v.office, v.round_label, v.scope_type, v.scope_key,
         v.scope_label, '{}'::jsonb, ev.event_id, 'public', 'held_legacy'
  from (values
    ('bec-local-2024', 'k:mayor:1017:held-legacy', 'mayor', 'tur1', 'siruta', '1017', 'SENTINEL held', 'ro:local:2024'),
    ('bec-local-2024', 'k:local_council:1017:held-legacy', 'local_council', 'tur1', 'siruta', '1017', 'SENTINEL held', null),
    ('aep-local-2020', ${sql.lit(HELD_COUNTY)}, 'mayor', null, 'county', '1', 'SENTINEL held', null)
  ) as v (election_key, contest_key, office, round_label, scope_type, scope_key, scope_label, event_key)
  join elections.elections e on e.election_key = v.election_key
  left join elections.electoral_events ev on ev.event_key = v.event_key;
`;

/** Zero-valued synthetic labels: with the three named ones, the file's 234 per county. */
const SYNTHETIC_LABELS = 231;
const STATEMENT_CODES = ['a', 'a1', 'a2', 'a3', 'a4', 'b', 'b1', 'b2', 'b3', 'b4', 'c', 'd'];

/** The dimensions and dictionary rows of the county source report proof (one multi-statement script: literals only). */
const REPORT_SEED = sql`
  insert into elections.elections
    (election_key, election_family, election_name, election_date, election_year, election_round,
     authority, publication_status, is_final, attrs, event_id, corrected_family, result_status, privacy_class)
  values
    ('aep-local-2020', 'local', 'Alegeri locale 2020', null, 2020, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}', null, null, 'unknown', 'public'),
    (${sql.lit(CKAN_2020)}, 'local', 'Alegeri locale 2020 (CKAN)', null, 2020, null,
     'BEC/AEP/ROAEP', 'unknown', false, '{}', null, null, 'unknown', 'public');

  insert into elections.contests
    (contest_key, election_id, office, round_label, scope_type, scope_key, scope_label, attrs, privacy_class)
  select v.contest_key, e.election_id, v.office, null, v.scope_type, v.scope_key, v.scope_label, '{}'::jsonb, v.privacy_class
  from (values
    ('aep-local-2020', ${sql.lit(COUNTY('1'))}, 'mayor', 'county', '1', 'ALBA', 'public'),
    ('aep-local-2020', ${sql.lit(COUNTY('2'))}, 'mayor', 'county', '2', 'ARAD', 'public'),
    ('aep-local-2020', ${sql.lit(COUNTY('3'))}, 'mayor', 'county', '3', 'SENTINEL scope', 'restricted'),
    ('aep-local-2020', ${sql.lit(COUNTY('4'))}, 'mayor', 'county', '4', 'BACĂU', 'public'),
    ('aep-local-2020', ${sql.lit(COUNTY('5'))}, 'mayor', 'county', '5', 'BIHOR', 'public'),
    ('aep-local-2020', ${sql.lit(COUNTY('7'))}, 'mayor', 'county', '7', 'BRAŞOV', 'public'),
    ('aep-local-2020', ${sql.lit(COUNTY('42'))}, 'mayor', 'county', '42', 'MUNICIPIUL BUCUREŞTI', 'public'),
    ('aep-local-2020', ${sql.lit(LOCAL_ELECTION)}, 'local_election', 'county', '1', 'ALBA', 'public'),
    ('aep-local-2020', ${sql.lit(SIRUTA)}, 'mayor', 'siruta', '1017', 'ALBA IULIA', 'public'),
    (${sql.lit(CKAN_2020)}, ${sql.lit(CKAN_CONTEST)}, 'mayor', 'county', '1', 'ALBA', 'public')
  ) as v (election_key, contest_key, office, scope_type, scope_key, scope_label, privacy_class)
  join elections.elections e on e.election_key = v.election_key;

  insert into elections.reporting_units
    (reporting_unit_key, scope_type, scope_key, name, county_code, county_name, privacy_class)
  values
    ('county:1', 'county', '1', 'ALBA', '1', 'ALBA', 'public'),
    ('county:2', 'county', '2', 'ARAD', '2', 'ARAD', 'public'),
    ('county:3', 'county', '3', 'ARGEŞ', '3', 'ARGEŞ', 'public'),
    ('county:4', 'county', '4', 'SENTINEL unit', '4', 'SENTINEL unit', 'restricted'),
    ('county:5', 'county', '5', 'BIHOR', '5', 'BIHOR', 'public'),
    ('county:7', 'county', '7', 'BRAŞOV', '7', 'BRAŞOV', 'public'),
    ('county:42', 'county', '42', 'MUNICIPIUL BUCUREŞTI', '42', 'MUNICIPIUL BUCUREŞTI', 'public'),
    ('siruta:1017', 'siruta', '1017', 'ALBA IULIA', null, null, 'public');

  -- dup-twin is a second public competitor id of the package carrying an existing source label.
  insert into elections.electoral_competitors
    (competitor_key, source_family, source_label, competitor_type, privacy_class)
  values
    ('competitor:pnl', 'aep-local-2020', 'PARTIDUL NAȚIONAL LIBERAL', 'source_published', 'public'),
    ('competitor:alliance', 'aep-local-2020', '"ALIANȚA ELECTORALĂ X"', 'source_published', 'public'),
    ('competitor:independent', 'aep-local-2020', 'Candidat Independent', 'source_published', 'public'),
    ('competitor:restricted', 'aep-local-2020', 'SENTINEL restricted competitor', 'source_published', 'restricted'),
    ('competitor:other-carrier', 'aep-local-2020', 'SENTINEL other carrier', 'source_published', 'public'),
    ('competitor:other-family', 'bec-local-2020', 'SENTINEL other family', 'source_published', 'public'),
    ('competitor:dup-twin', 'aep-local-2020', ${sql.lit(TWIN_LABEL)}, 'source_published', 'public');
  insert into elections.electoral_competitors
    (competitor_key, source_family, source_label, competitor_type, privacy_class)
  select 'competitor:synthetic-' || lpad(i::text, 3, '0'), 'aep-local-2020',
         'SINTETIC ' || lpad(i::text, 3, '0'), 'source_published', 'public'
  from generate_series(1, ${sql.lit(SYNTHETIC_LABELS)}) as i;

  insert into elections.metric_definitions (metric_code, metric_label)
  select code, code from unnest(array['a','a1','a2','a3','a4','b','b1','b2','b3','b4','c','d','e','f',
                                      'voturi','mandate','county_nce']) as code;

  -- Every admitted code is accepted and public (the a4/b4 holds flip these rows in a test);
  -- f (accepted) and county_nce (accepted, and mis-mapped to voturi) prove the explicit list.
  insert into elections.source_metric_map
    (source_family, source_metric_code, metric_code, mapping_status, privacy_class)
  select 'aep-local-2020', code, code, 'human_accepted', 'public'
  from unnest(array['a','a1','a2','a3','a4','b','b1','b2','b3','b4','c','d','f',
                    'voturi','mandate','county_nce']) as code
  union all values
    ('aep-local-2020', 'e', 'e', 'needs_review', 'public'),
    ('aep-local-2020', 'county_nce', 'voturi', 'human_accepted', 'public');
`;

/**
 * One contest's complete shape on one carrier: the 12 statement cells (zeros
 * unless overridden) and the 231 synthetic labels' zero pairs. The named
 * labels' pairs are added as REPORT_CELLS.
 */
interface Shape {
  readonly contest: string;
  readonly unit: string;
  readonly carrier: Carrier;
  readonly statement?: Readonly<Record<string, string>>;
}

const shape = (
  contest: string,
  unit: string,
  breaks: Partial<Carrier> = {},
  statement: Readonly<Record<string, string>> = {}
): Shape => ({ contest, unit, carrier: { ...CARRIER, ...breaks }, statement });

const insertShape = ({ contest, unit, carrier, statement = {} }: Shape) => {
  const overrides = Object.entries(statement);
  return sql`
  insert into elections.result_rows
    (contest_id, reporting_unit_id, metric_code, electoral_competitor_id, raw_value, numeric_value,
     attrs, source_resource_id, source_file_id, source_row_number, source_row_hash, privacy_class)
  select c.contest_id, ru.reporting_unit_id, x.metric, x.competitor_id, x.value, x.value::numeric,
         jsonb_build_object('packageName', ${sql.lit(carrier.pkg)},
                            'sourceFileSha256', ${sql.lit(carrier.sha)},
                            'sourceMetricColumn', ${carrier.column === null ? sql`null::text` : sql.lit(carrier.column)},
                            'note', 'SENTINEL attrs'),
         ${sql.lit(carrier.resource)}, ${sql.lit(carrier.file)}::bigint, 2, repeat('0', 64), ${sql.lit(carrier.privacy)}
  from elections.contests c
  join elections.reporting_units ru on ru.reporting_unit_key = ${sql.lit(unit)}
  cross join (
    select m.metric, ec.electoral_competitor_id as competitor_id, '0'::text as value
    from elections.electoral_competitors ec
    cross join (values ('voturi'), ('mandate')) as m (metric)
    where ec.competitor_key like 'competitor:synthetic-%'
    union all
    select s.code, null::bigint, coalesce(o.value, '0')
    from unnest(array[${sql.join(STATEMENT_CODES.map((code) => sql.lit(code)))}]::text[]) as s (code)
    left join (values ${
      overrides.length === 0
        ? sql`(null::text, null::text)`
        : sql.join(overrides.map(([code, value]) => sql`(${sql.lit(code)}, ${sql.lit(value)})`))
    }) as o (code, value) on o.code = s.code
  ) as x
  where c.contest_key = ${sql.lit(contest)}`;
};

const ALBA = COUNTY('1');
const OTHER = 'competitor:other-carrier';
const NAMED = ['competitor:pnl', 'competitor:alliance', 'competitor:independent'] as const;

/**
 * Positive contests (ALBA, Bucharest), the two holds/faults of the complete-source contract
 * (5: one label's pair entirely missing; 7: a label carried twice), and one complete control
 * contest per contest-level or carrier-wide predicate (each would be served if its predicate broke).
 */
const REPORT_SHAPES: readonly Shape[] = [
  shape(
    ALBA,
    'county:1',
    {},
    { a: '9007199254740993', a3: '5', a4: '7', b: '100', b1: '50', b4: '3', c: '60' }
  ),
  shape(COUNTY('42'), 'county:42', {}, { c: '657159' }),
  shape(COUNTY('5'), 'county:5'),
  shape(COUNTY('7'), 'county:7'),
  shape(COUNTY('2'), 'county:2', { resource: 'local:another-resource' }),
  shape(COUNTY('3'), 'county:3'),
  shape(COUNTY('4'), 'county:4'),
  shape(LOCAL_ELECTION, 'county:1'),
  shape(SIRUTA, 'siruta:1017'),
  shape(CKAN_CONTEST, 'county:1'),
  shape(HELD_COUNTY, 'county:1'),
];

interface ReportCell {
  readonly contest: string;
  readonly unit: string;
  readonly metric: string;
  readonly competitor: string | null;
  readonly value: string;
  readonly row: number;
  readonly carrier: Carrier;
}

const cell = (
  contest: string,
  unit: string,
  metric: string,
  competitor: string | null,
  value: string,
  row: number,
  breaks: Partial<Carrier> = {}
): ReportCell => ({
  contest,
  unit,
  metric,
  competitor,
  value,
  row,
  carrier: { ...CARRIER, ...breaks },
});

/** The named labels' pairs of one shape, on the shape's own carrier. */
const namedPairs = (
  { contest, unit, carrier }: Shape,
  values: Readonly<Record<string, readonly [string, string]>> = {},
  labels: readonly string[] = NAMED
): ReportCell[] =>
  labels.flatMap((competitor) => {
    const [voturi, mandate] = values[competitor] ?? ['0', '0'];
    return [
      cell(contest, unit, 'voturi', competitor, voturi, 2, carrier),
      cell(contest, unit, 'mandate', competitor, mandate, 2, carrier),
    ];
  });

const shapeOf = (contest: string): Shape => {
  const found = REPORT_SHAPES.find((s) => s.contest === contest);
  if (found === undefined) throw new Error(`no shape for ${contest}`);
  return found;
};

const REPORT_CELLS: readonly ReportCell[] = [
  // ALBA: the named pairs, then cells the source view must never serve.
  ...namedPairs(shapeOf(ALBA), {
    'competitor:pnl': ['40', '2'],
    'competitor:independent': ['20', '0'],
  }),
  cell(ALBA, 'county:1', 'e', null, '999', 2),
  cell(ALBA, 'county:1', 'f', null, '998', 2),
  cell(ALBA, 'county:1', 'county_nce', null, '1', 2),
  cell(ALBA, 'county:1', 'voturi', 'competitor:restricted', '5', 2),
  cell(ALBA, 'county:1', 'voturi', 'competitor:other-family', '9', 2),
  // One broken predicate each (a leak duplicates a cell, refusing the report, or shows a SENTINEL).
  cell(ALBA, 'county:1', 'voturi', 'competitor:pnl', '41', 90, { privacy: 'restricted' }),
  cell(ALBA, 'county:1', 'c', null, '61', 91, { privacy: 'restricted' }),
  cell(ALBA, 'county:1', 'voturi', OTHER, '7', 92, { resource: 'local:another-resource' }),
  cell(ALBA, 'county:1', 'voturi', OTHER, '7', 93, { file: '205' }),
  cell(ALBA, 'county:1', 'voturi', OTHER, '7', 94, { sha: 'b'.repeat(64) }),
  cell(ALBA, 'county:1', 'voturi', OTHER, '7', 95, { pkg: CKAN_2020 }),
  cell(ALBA, 'county:1', 'c', null, '62', 96, { file: '205' }),
  cell(ALBA, 'county:2', 'voturi', OTHER, '7', 97),
  // Same carrier in every field, canonical metric voturi, but an explicit source column county_nce.
  cell(ALBA, 'county:1', 'voturi', 'competitor:pnl', '41', 98, { column: 'county_nce' }),
  ...namedPairs(shapeOf(COUNTY('42')), { 'competitor:pnl': ['1', '1'] }),
  // County 5: the PNL pair is missing entirely (233 labels).
  ...namedPairs(shapeOf(COUNTY('5')), {}, ['competitor:alliance', 'competitor:independent']),
  // County 7: complete, plus a second competitor id carrying the last label's voturi cell.
  ...namedPairs(shapeOf(COUNTY('7'))),
  cell(COUNTY('7'), 'county:7', 'voturi', 'competitor:dup-twin', '0', 2),
  // The complete control contests' named pairs, on each control's carrier.
  ...[
    COUNTY('2'),
    COUNTY('3'),
    COUNTY('4'),
    LOCAL_ELECTION,
    SIRUTA,
    CKAN_CONTEST,
    HELD_COUNTY,
  ].flatMap((key) => namedPairs(shapeOf(key))),
];

const insertReportCells = (cells: readonly ReportCell[]) => sql`
  insert into elections.result_rows
    (contest_id, reporting_unit_id, metric_code, electoral_competitor_id, raw_value, numeric_value,
     attrs, source_resource_id, source_file_id, source_row_number, source_row_hash, privacy_class)
  select c.contest_id, ru.reporting_unit_id, v.v_metric, ec.electoral_competitor_id, v.v_value,
         v.v_value::numeric,
         jsonb_build_object('packageName', v.v_pkg, 'sourceFileSha256', v.v_sha,
                            'sourceMetricColumn', v.v_column, 'note', 'SENTINEL attrs'),
         v.v_resource, v.v_file::bigint, v.v_row::bigint, repeat('0', 64), v.v_privacy
  from (values ${sql.join(
    cells.map(
      (c) =>
        sql`(${c.contest}, ${c.unit}, ${c.metric}, ${c.competitor}, ${c.value}, ${c.carrier.resource},
             ${c.carrier.file}, ${c.carrier.sha}, ${c.carrier.pkg}, ${String(c.row)}, ${c.carrier.privacy},
             ${c.carrier.column})`
    )
  )})
    as v (v_contest, v_unit, v_metric, v_competitor, v_value, v_resource, v_file, v_sha, v_pkg, v_row,
          v_privacy, v_column)
  join elections.contests c on c.contest_key = v.v_contest
  join elections.reporting_units ru on ru.reporting_unit_key = v.v_unit
  left join elections.electoral_competitors ec on ec.competitor_key = v.v_competitor`;

const ALBA_STATEMENT = [
  ['a', '9007199254740993'],
  ['a1', '0'],
  ['a2', '0'],
  ['a3', '5'],
  ['a4', '7'],
  ['b', '100'],
  ['b1', '50'],
  ['b2', '0'],
  ['b3', '0'],
  ['b4', '3'],
  ['c', '60'],
  ['d', '0'],
];
const synthetic = (n: number) => `SINTETIC ${String(n).padStart(3, '0')}`;
/** ALBA's first page of 20 labels in C order: the named three, then SINTETIC 001…017. */
const ALBA_FIRST_PAGE = [
  { sourceLabel: '"ALIANȚA ELECTORALĂ X"', voturi: '0', mandate: '0' },
  { sourceLabel: 'Candidat Independent', voturi: '20', mandate: '0' },
  { sourceLabel: 'PARTIDUL NAȚIONAL LIBERAL', voturi: '40', mandate: '2' },
  ...Array.from({ length: 17 }, (_unused, i) => ({
    sourceLabel: synthetic(i + 1),
    voturi: '0',
    mandate: '0',
  })),
];

const REPORT_FIELDS = `contestKey electionKey reportedOffice scopeType sourceScopeKey scopeLabel notice
  scopeNote source { title url reportedElectionDate sourceFileVerifiedOn valuesComparedOn }
  statement { sourceCode sourceLabel value }
  competitors { items { sourceLabel voturi mandate } page pageSize total hasMore }`;

const EDITIONS = [
  'BEC-legacy-1992',
  'aep-local-2020',
  CKAN_2020,
  'bec-european-2009',
  'bec-local-2024',
  'bec-local-2024-hidden-event',
  'roaep-election-databases-local-2024',
];
const CONTESTS = [
  'K:county_council:1',
  'k:local_council:1017',
  'k:mayor:1017',
  'k:mayor:1017:tur2',
  'k:mayor:179132',
];

const READINESS = 'readiness { identity sourceSelection sourceOpening results mandates issues }';
const EDITION = `electionKey eventKey reportedName reportedYear verifiedYear reportedFamily
  verifiedFamily reportedRound reportedDate reportedAuthority ${READINESS}`;
const CONTEST = `contestKey electionKey eventKey reportedOffice verifiedOffice chamber reportedRound
  scopeType sourceScopeKey scopeLabel constituencyCode constituencyName ${READINESS}`;

let setupDb: Kysely<unknown> | undefined;
let app: FastifyInstance | undefined;
let mcpCalls = 0;

const requireApp = (): FastifyInstance => {
  if (app === undefined) throw new Error('elections e2e app is not ready');
  return app;
};

const rest = async (url: string) => {
  const res = await requireApp().inject({ method: 'GET', url: `/api/v1/elections${url}` });
  return {
    status: res.statusCode,
    raw: res.body,
    body: res.json<{
      ok: boolean;
      data?: unknown;
      meta?: { page?: { total?: number }; hasMore?: boolean };
      requestId?: string;
    }>(),
  };
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
  return { status: res.statusCode, raw: res.body, body: res.json<GqlBody>() };
};

/** A successful GraphQL read: HTTP 200, no `errors`, the named root. */
const gqlData = async (root: string, query: string, variables: Record<string, unknown> = {}) => {
  const res = await gql(query, variables);
  expect(res.status, res.raw).toBe(200);
  expect(res.body.errors, res.raw).toBeUndefined();
  expect(res.raw).not.toContain(SENTINEL);
  return res.body.data?.[root];
};

const mcp = async (name: string, args: Record<string, unknown>) => {
  mcpCalls += 1;
  const res = await requireApp().inject({
    method: 'POST',
    url: '/api/v1/mcp',
    // One synthetic address per call: the per-IP bucket is a route property, not data.
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
  const content = res.json<{ result?: { structuredContent?: Record<string, unknown> } }>().result
    ?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return { raw: res.body, content };
};

const keysOf = (items: unknown, key: string): string[] =>
  (items as Record<string, string>[]).map((item) => item[key] ?? '');

describe('elections fixture target guard (pure; no connection, no env)', () => {
  const ID = 'run_1';
  const AT = `postgres://elections_api_test:pw-x@127.0.0.1:55432/elections_api_${ID}`;

  it('admits only the exact declared fixture target', () => {
    expect(fixtureTarget(AT, ID)).toEqual({ database: 'elections_api_run_1' });
    expect(fixtureTarget(AT.replace('postgres:', 'postgresql:'), ID).database).toBe(
      'elections_api_run_1'
    );
  });

  it.each([
    ['a malformed fixture id', AT, 'Run-1'],
    ['an empty fixture id', AT, ''],
    ['connection options', `${AT}?options=-c%20search_path%3Dx`, ID],
    ['a host override', `${AT}?host=10.0.0.1`, ID],
    ['an sslmode option', `${AT}?sslmode=disable`, ID],
    ['a fragment', `${AT}#x`, ID],
    ['another host', AT.replace('127.0.0.1', '10.0.0.1'), ID],
    ['localhost instead of 127.0.0.1', AT.replace('127.0.0.1', 'localhost'), ID],
    ['an implicit port', AT.replace(':55432', ''), ID],
    ['another login', AT.replace('elections_api_test', 'postgres'), ID],
    ['another database', AT.replace(`elections_api_${ID}`, 'transparenta_prod'), ID],
    ['the database of another fixture', AT, 'run_2'],
    ['another scheme', AT.replace('postgres:', 'http:'), ID],
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

describe('elections catalog — real DDL, real app, external fixture', () => {
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
    // The pins are checked before any connection or DDL.
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
    await SEED.execute(setupDb);
    await REPORT_SEED.execute(setupDb);
    await HELD_SEED.execute(setupDb);
    for (const reportShape of REPORT_SHAPES) await insertShape(reportShape).execute(setupDb);
    await insertReportCells(REPORT_CELLS).execute(setupDb);
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
    // The fixture itself belongs to the primary's lifecycle: close, never drop.
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

  it('pages public editions in C key order with the same items and totals on every surface', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const seen: string[] = [];
    const total = EDITIONS.length;
    const pages = Math.ceil(total / 2);
    for (let page = 1; page <= pages; page += 1) {
      const res = await rest(`/editions?pageSize=2&page=${String(page)}`);
      expect(res.body.meta).toMatchObject({ page: { total }, hasMore: page < pages });
      seen.push(...keysOf(res.body.data, 'electionKey'));
    }
    expect(seen).toEqual(EDITIONS);
    const all = await rest('/editions?pageSize=100');
    expect(all.raw).not.toContain(SENTINEL);
    expect(keysOf(all.body.data, 'electionKey')).toEqual(EDITIONS);
    const graph = await gqlData(
      'electionCatalog',
      `{ electionCatalog(pageSize: 100) { items { ${EDITION} } page pageSize total hasMore } }`
    );
    expect(graph).toEqual({
      items: all.body.data,
      page: 1,
      pageSize: 100,
      total,
      hasMore: false,
    });
    const tool = await mcp('list_election_editions', { pageSize: 100 });
    expect(tool.raw).not.toContain(SENTINEL);
    expect(tool.content).toMatchObject({
      ok: true,
      items: all.body.data,
      meta: { page: 1, pageSize: 100, total, hasMore: false, totalCounts: 'source_editions' },
    });
  });

  it('pages public contests of one edition in C key order, alike on every surface', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const all = await rest('/contests?electionKey=bec-local-2024&pageSize=100');
    expect(all.raw).not.toContain(SENTINEL);
    expect(keysOf(all.body.data, 'contestKey')).toEqual(CONTESTS);
    expect(all.body.meta).toMatchObject({ page: { total: 5 }, hasMore: false });
    const graph = await gqlData(
      'electionContests',
      `query($key: ID!) {
        electionContests(electionKey: $key, pageSize: 100) { items { ${CONTEST} } total hasMore }
      }`,
      { key: 'bec-local-2024' }
    );
    expect(graph).toEqual({ items: all.body.data, total: 5, hasMore: false });
    const tool = await mcp('list_election_contests', {
      electionKey: 'bec-local-2024',
      pageSize: 100,
    });
    expect(tool.raw).not.toContain(SENTINEL);
    expect(tool.content).toMatchObject({
      ok: true,
      items: all.body.data,
      meta: { total: 5, hasMore: false, totalCounts: 'source_contests' },
    });
    const mayors = await rest('/contests?electionKey=bec-local-2024&reportedOffices=mayor');
    expect(mayors.body.meta).toMatchObject({ page: { total: 3 } });
    const runoff = await rest('/contests?electionKey=bec-local-2024&reportedRounds=tur2');
    expect(keysOf(runoff.body.data, 'contestKey')).toEqual(['k:mayor:1017:tur2']);
    const county = await rest('/contests?electionKey=bec-local-2024&scopeTypes=county');
    expect(county.body.data).toMatchObject([{ contestKey: 'K:county_council:1', eventKey: null }]);
  });

  it('answers edition and contest details alike on every surface', async ({ skip }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const edition = await rest('/editions/lookup?electionKey=bec-european-2009');
    expect(edition.status).toBe(200);
    const contest = await rest('/contests/lookup?contestKey=k%3Amayor%3A179132');
    expect(contest.status).toBe(200);
    expect(edition.raw + contest.raw).not.toContain(SENTINEL);
    const graph = await gql(
      `query($e: ID!, $c: ID!) {
        electionEdition(electionKey: $e) { ${EDITION} }
        electionContest(contestKey: $c) { ${CONTEST} }
      }`,
      { e: 'bec-european-2009', c: 'k:mayor:179132' }
    );
    expect(graph.status).toBe(200);
    expect(graph.body.errors).toBeUndefined();
    expect(graph.raw).not.toContain(SENTINEL);
    expect(graph.body.data).toEqual({
      electionEdition: edition.body.data,
      electionContest: contest.body.data,
    });
    const toolEdition = await mcp('get_election_edition', { electionKey: 'bec-european-2009' });
    const toolContest = await mcp('get_election_contest', { contestKey: 'k:mayor:179132' });
    expect(toolEdition.content).toMatchObject({ ok: true, item: edition.body.data });
    expect(toolContest.content).toMatchObject({ ok: true, item: contest.body.data });
    expect(toolEdition.raw + toolContest.raw).not.toContain(SENTINEL);
  });

  it('withholds every restricted row, parent and event link, indistinguishable from absence', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    // REST: one 404 body for restricted and absent keys.
    for (const [restricted, absent] of [
      ['/editions/lookup?electionKey=restricted-edition', '/editions/lookup?electionKey=absent'],
      ['/contests?electionKey=restricted-edition', '/contests?electionKey=absent'],
      ['/contests/lookup?contestKey=k%3Aunder-restricted', '/contests/lookup?contestKey=absent'],
      ['/contests/lookup?contestKey=k%3Amayor%3Arestricted', '/contests/lookup?contestKey=absent'],
    ] as const) {
      const hidden = await rest(restricted);
      const missing = await rest(absent);
      expect(hidden.status, restricted).toBe(404);
      expect({ ...hidden.body, requestId: '' }).toEqual({ ...missing.body, requestId: '' });
      expect(hidden.raw).not.toContain(SENTINEL);
    }
    // GraphQL: details are null without errors; the contest list of a hidden edition is NOT_FOUND.
    const details = await gql(
      `query($r: ID!, $a: ID!, $u: ID!, $rc: ID!, $ac: ID!) {
        restricted: electionEdition(electionKey: $r) { electionKey }
        absent: electionEdition(electionKey: $a) { electionKey }
        underRestricted: electionContest(contestKey: $u) { contestKey }
        restrictedContest: electionContest(contestKey: $rc) { contestKey }
        absentContest: electionContest(contestKey: $ac) { contestKey }
      }`,
      {
        r: 'restricted-edition',
        a: 'absent',
        u: 'k:under-restricted',
        rc: 'k:mayor:restricted',
        ac: 'absent',
      }
    );
    expect(details.body.errors).toBeUndefined();
    expect(details.body.data).toEqual({
      restricted: null,
      absent: null,
      underRestricted: null,
      restrictedContest: null,
      absentContest: null,
    });
    const listOf = async (key: string) =>
      gql(`query($k: ID!) { electionContests(electionKey: $k) { total } }`, { k: key });
    const hiddenList = await listOf('restricted-edition');
    const absentList = await listOf('absent');
    expect(hiddenList.body.data ?? null).toBeNull();
    expect(hiddenList.body.errors?.[0]?.extensions?.['code']).toBe('NOT_FOUND');
    expect(hiddenList.body.errors?.map((e) => [e.message, e.extensions?.['code']])).toEqual(
      absentList.body.errors?.map((e) => [e.message, e.extensions?.['code']])
    );
    // MCP: null items for details, one NotFound failure for the list.
    for (const [name, args] of [
      ['get_election_edition', [{ electionKey: 'restricted-edition' }, { electionKey: 'absent' }]],
      ['get_election_contest', [{ contestKey: 'k:under-restricted' }, { contestKey: 'absent' }]],
      ['get_election_contest', [{ contestKey: 'k:mayor:restricted' }, { contestKey: 'absent' }]],
    ] as const) {
      const [hidden, missing] = [await mcp(name, args[0]), await mcp(name, args[1])];
      expect(hidden.content).toMatchObject({ ok: true, item: null });
      expect(missing.content).toMatchObject({ ok: true, item: null });
      expect(hidden.raw).not.toContain(SENTINEL);
    }
    const hiddenTool = await mcp('list_election_contests', { electionKey: 'restricted-edition' });
    const absentTool = await mcp('list_election_contests', { electionKey: 'absent' });
    expect(hiddenTool.content).toMatchObject({ ok: false, errorType: 'NotFound' });
    expect(hiddenTool.content).toEqual(absentTool.content);
    // A public row linked to a restricted event: the link is null on every surface and never matches.
    const linked = await rest('/editions/lookup?electionKey=bec-local-2024-hidden-event');
    expect(linked.body.data).toMatchObject({ eventKey: null });
    const graphLinked = await gqlData(
      'electionEdition',
      `{ electionEdition(electionKey: "bec-local-2024-hidden-event") { eventKey } }`
    );
    expect(graphLinked).toEqual({ eventKey: null });
    const toolLinked = await mcp('get_election_contest', { contestKey: 'K:county_council:1' });
    expect(toolLinked.content).toMatchObject({ ok: true, item: { eventKey: null } });
    const byHiddenEvent = await rest('/editions?eventKeys=ro%3Ahidden%3A2024');
    expect(byHiddenEvent.body.meta).toMatchObject({ page: { total: 0 } });
  });

  it('serves reported labels only: no stored finality, correction, attrs or canonical office', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const local = await rest('/editions/lookup?electionKey=bec-local-2024');
    expect(local.raw).not.toContain('final"');
    expect(local.raw).not.toContain('candidate_list');
    expect(local.body.data).toMatchObject({
      reportedRound: 'tur1',
      readiness: { identity: 'HELD', results: 'UNAVAILABLE', mandates: 'UNAVAILABLE' },
    });
    const european = await rest('/editions/lookup?electionKey=bec-european-2009');
    expect(european.body.data).toMatchObject({
      reportedFamily: 'parliamentary',
      verifiedFamily: null,
      reportedDate: '2009-06-07',
      eventKey: 'ro:european:2009',
    });
    expect((await rest('/editions?reportedFamilies=european')).body.meta).toMatchObject({
      page: { total: 0 },
    });
    const contest = await rest('/contests/lookup?contestKey=k%3Amayor%3A179132');
    expect(contest.status).toBe(200);
    expect(contest.raw).not.toContain(SENTINEL);
    expect(contest.body.data).toMatchObject({ verifiedOffice: null, reportedOffice: 'mayor' });
  });

  const reportUrl = (contestKey: string, page: number, pageSize: number) =>
    `/county-source-reports/lookup?contestKey=${encodeURIComponent(contestKey)}&page=${String(page)}&pageSize=${String(pageSize)}`;

  const REPORT_QUERY = `query($key: ID!, $page: Int, $pageSize: Int) {
    electionCountySourceReport(contestKey: $key, page: $page, pageSize: $pageSize) { ${REPORT_FIELDS} }
  }`;

  /** One report on REST and GraphQL; asserts they agree and returns the REST answer. */
  const sourceReport = async (contestKey: string, page = 1, pageSize = 20) => {
    const res = await rest(reportUrl(contestKey, page, pageSize));
    expect(res.raw).not.toContain(SENTINEL);
    const graph = await gqlData('electionCountySourceReport', REPORT_QUERY, {
      key: contestKey,
      page,
      pageSize,
    });
    expect(res.status === 200 ? res.body.data : null).toEqual(graph);
    return res;
  };

  /** A report both surfaces refuse as the fixed fault, whatever the page. */
  const refusedReport = async (contestKey: string, page: number, pageSize: number) => {
    const res = await rest(reportUrl(contestKey, page, pageSize));
    expect(res.status, `page ${String(page)}`).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'Database' });
    expect(res.raw).not.toContain(SENTINEL);
    const graph = await gql(REPORT_QUERY, { key: contestKey, page, pageSize });
    expect(graph.body.data?.['electionCountySourceReport'] ?? null).toBeNull();
    expect(graph.body.errors?.[0]?.extensions?.['code']).toBe(GRAPHQL_ERROR_CODE.Database);
    expect(graph.raw).not.toContain(SENTINEL);
  };

  /** The contests of the qualified source, resolved through the catalog (never parsed). */
  const reportContestKeys = async () => {
    const listed = await rest(
      '/contests?electionKey=aep-local-2020&reportedOffices=mayor&scopeTypes=county&pageSize=100'
    );
    return keysOf(listed.body.data, 'contestKey');
  };

  const requireSetup = (): Kysely<unknown> => {
    if (setupDb === undefined) throw new Error('elections e2e setup pool is not ready');
    return setupDb;
  };

  /** One fixture count, to prove a control row was seeded as described. */
  const seededCount = async (query: RawBuilder<{ n: string }>) =>
    (await query.execute(requireSetup())).rows[0]?.n;

  it('serves only the qualified carrier cells of the complete source, alike on REST and GraphQL', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    expect(await reportContestKeys()).toEqual([
      COUNTY('1'),
      COUNTY('2'),
      COUNTY('4'),
      COUNTY('42'),
      COUNTY('5'),
      COUNTY('7'),
    ]);
    const alba = await sourceReport(ALBA);
    expect(alba.status).toBe(200);
    const data = alba.body.data as {
      statement: { sourceCode: string; value: string | null }[];
      competitors: unknown;
    };
    expect(data).toMatchObject({
      contestKey: ALBA,
      electionKey: 'aep-local-2020',
      reportedOffice: 'mayor',
      scopeType: 'county',
      sourceScopeKey: '1',
      scopeLabel: 'ALBA',
      scopeNote: null,
      source: { reportedElectionDate: '2020-09-27', valuesComparedOn: '2026-10-14' },
    });
    // All 12 cells, zero and precision kept; no e, f or county_nce.
    expect(data.statement.map((c) => [c.sourceCode, c.value])).toEqual(ALBA_STATEMENT);
    // 234 source labels; no restricted, other-carrier, other-unit, other-family or
    // explicit-source-column cell (any of them would show or duplicate a cell).
    expect(data.competitors).toEqual({
      items: ALBA_FIRST_PAGE,
      page: 1,
      pageSize: 20,
      total: 234,
      hasMore: true,
    });
    // Quoted: the citation URL itself contains the digits 999.
    expect(alba.raw).not.toMatch(/"(?:e|f|county_nce|998|999|41|61|62)"/u);
    // The explicit-source-column control is really there, with every other carrier field valid.
    expect(
      await seededCount(sql<{ n: string }>`
        select count(*)::text as n from elections.result_rows rr
        join elections.contests c on c.contest_id = rr.contest_id
        where c.contest_key = ${ALBA} and rr.metric_code = 'voturi'
          and rr.attrs ->> 'sourceMetricColumn' = 'county_nce'
          and rr.source_resource_id = ${CARRIER.resource} and rr.source_file_id = 88
          and rr.attrs ->> 'sourceFileSha256' = ${CARRIER.sha}
          and rr.attrs ->> 'packageName' = ${CARRIER.pkg} and rr.privacy_class = 'public'`)
    ).toBe('1');
    const bucharest = await sourceReport(COUNTY('42'));
    expect(bucharest.body.data).toMatchObject({
      scopeLabel: 'MUNICIPIUL BUCUREŞTI',
      scopeNote: expect.stringContaining(
        'General-mayor results are published separately'
      ) as unknown,
      statement: expect.arrayContaining([
        { sourceCode: 'c', sourceLabel: expect.any(String) as unknown, value: '657159' },
      ]) as unknown,
      competitors: { total: 234 },
    });
  });

  it('pages source labels in C order with an exact total', async ({ skip }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const labelsOf = async (page: number) => {
      const res = await sourceReport(ALBA, page, 2);
      const competitors = (
        res.body.data as {
          competitors: { items: { sourceLabel: string }[]; total: number; hasMore: boolean };
        }
      ).competitors;
      return {
        labels: competitors.items.map((item) => item.sourceLabel),
        total: competitors.total,
        hasMore: competitors.hasMore,
      };
    };
    expect(await labelsOf(1)).toEqual({
      labels: ['"ALIANȚA ELECTORALĂ X"', 'Candidat Independent'],
      total: 234,
      hasMore: true,
    });
    expect(await labelsOf(2)).toEqual({
      labels: ['PARTIDUL NAȚIONAL LIBERAL', synthetic(1)],
      total: 234,
      hasMore: true,
    });
    expect(await labelsOf(117)).toEqual({
      labels: [synthetic(230), synthetic(231)],
      total: 234,
      hasMore: false,
    });
    expect(await labelsOf(118)).toEqual({ labels: [], total: 234, hasMore: false });
  });

  it('holds the whole report when a competitor pair or an admitted cell cannot be served', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const absent = await sourceReport('contest:absent');
    expect(absent.status).toBe(404);
    const held = async (key: string) => {
      const res = await sourceReport(key);
      expect(res.status, key).toBe(404);
      expect({ ...res.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
    };
    // County 5: a label's pair entirely missing must not pass as a smaller source.
    expect(
      await seededCount(sql<{ n: string }>`
        select count(distinct ec.source_label)::text as n from elections.result_rows rr
        join elections.contests c on c.contest_id = rr.contest_id
        join elections.electoral_competitors ec on ec.electoral_competitor_id = rr.electoral_competitor_id
        where c.contest_key = ${COUNTY('5')}`)
    ).toBe('233');
    await held(COUNTY('5'));
    // a4 unreviewed, then b4 private: the stored cells exist, yet the whole report is withheld.
    const flips = [
      [
        sql`update elections.source_metric_map set mapping_status = 'needs_review'
            where source_family = 'aep-local-2020' and source_metric_code = 'a4' and metric_code = 'a4'`,
        sql`update elections.source_metric_map set mapping_status = 'human_accepted'
            where source_family = 'aep-local-2020' and source_metric_code = 'a4' and metric_code = 'a4'`,
      ],
      [
        sql`update elections.source_metric_map set privacy_class = 'restricted'
            where source_family = 'aep-local-2020' and source_metric_code = 'b4' and metric_code = 'b4'`,
        sql`update elections.source_metric_map set privacy_class = 'public'
            where source_family = 'aep-local-2020' and source_metric_code = 'b4' and metric_code = 'b4'`,
      ],
    ] as const;
    for (const [withhold, restore] of flips) {
      await withhold.execute(requireSetup());
      try {
        await held(ALBA);
        await held(COUNTY('42'));
      } finally {
        await restore.execute(requireSetup());
      }
      expect((await sourceReport(ALBA)).status).toBe(200);
    }
  });

  it('refuses a source label carried by two competitor ids, on every page', async ({ skip }) => {
    if (app === undefined) {
      skip();
      return;
    }
    expect(
      await seededCount(sql<{ n: string }>`
        select count(*)::text as n from elections.electoral_competitors
        where source_family = 'aep-local-2020' and privacy_class = 'public'
          and source_label = ${TWIN_LABEL}`)
    ).toBe('2');
    // The duplicated label sorts last: pages 1 of 2 and 1-2 of 100 never show it.
    for (const [page, pageSize] of [
      [1, 2],
      [1, 100],
      [2, 100],
      [3, 100],
      [118, 2],
    ] as const)
      await refusedReport(COUNTY('7'), page, pageSize);
  });

  it('keeps every other carrier, office, scope, edition and restricted row unavailable', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const otherOffice = await rest(
      '/contests?electionKey=aep-local-2020&reportedOffices=local_election&pageSize=100'
    );
    const otherScope = await rest(
      '/contests?electionKey=aep-local-2020&reportedOffices=mayor&scopeTypes=siruta&pageSize=100'
    );
    const otherEdition = await rest(`/contests?electionKey=${CKAN_2020}&pageSize=100`);
    // Each is a complete shape held by the predicate named (the siruta contest also by its unit scope).
    const unavailable = [
      COUNTY('2'), // another resource
      COUNTY('4'), // a restricted unit
      COUNTY('3'), // a restricted contest (not listed)
      ...keysOf(otherOffice.body.data, 'contestKey'),
      ...keysOf(otherScope.body.data, 'contestKey'),
      ...keysOf(otherEdition.body.data, 'contestKey'),
    ];
    expect(unavailable).toEqual([
      COUNTY('2'),
      COUNTY('4'),
      COUNTY('3'),
      LOCAL_ELECTION,
      SIRUTA,
      CKAN_CONTEST,
    ]);
    const absent = await sourceReport('contest:absent');
    expect(absent.status).toBe(404);
    for (const key of unavailable) {
      const res = await sourceReport(key);
      expect(res.status, key).toBe(404);
      expect({ ...res.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
    }
  });

  it('never serves a held legacy contest: no count, page, filter, lookup or source report', async ({
    skip,
  }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const db = requireSetup();
    // Seeded as described: three public held contests, each sharing an active contest's scope.
    const shared = await sql<{ n: string }>`
      select count(*)::text as n from elections.contests h
      join elections.contests a
        on a.election_id = h.election_id and a.office = h.office
       and a.round_label is not distinct from h.round_label
       and a.scope_type = h.scope_type and a.scope_key = h.scope_key
       and a.identity_status is null and a.privacy_class = 'public'
      where h.identity_status = 'held_legacy' and h.privacy_class = 'public'`.execute(db);
    expect(shared.rows[0]?.n).toBe('3');
    // The held 2020 contest is as complete on the qualified carrier as a served control.
    const carrierRows = async (key: string) =>
      (
        await sql<{ n: string }>`
          select count(*)::text as n from elections.result_rows rr
          join elections.contests c on c.contest_id = rr.contest_id
          where c.contest_key = ${key} and rr.source_resource_id = ${CARRIER.resource}
            and rr.source_file_id = 88 and rr.privacy_class = 'public'`.execute(db)
      ).rows[0]?.n;
    const heldRows = await carrierRows(HELD_COUNTY);
    expect(Number(heldRows)).toBeGreaterThan(0);
    expect(heldRows).toBe(await carrierRows(LOCAL_ELECTION));
    // REST: counts, pages and filters list active contests only.
    const all = await rest('/contests?electionKey=bec-local-2024&pageSize=100');
    expect(keysOf(all.body.data, 'contestKey')).toEqual(CONTESTS);
    expect(all.body.meta).toMatchObject({ page: { total: 5 } });
    expect(all.raw).not.toContain(SENTINEL);
    const councils = await rest(
      '/contests?electionKey=bec-local-2024&reportedOffices=local_council'
    );
    expect(keysOf(councils.body.data, 'contestKey')).toEqual(['k:local_council:1017']);
    expect(councils.body.meta).toMatchObject({ page: { total: 1 } });
    const firstRound = await rest(
      '/contests?electionKey=bec-local-2024&reportedOffices=mayor&reportedRounds=tur1&scopeTypes=siruta'
    );
    expect(keysOf(firstRound.body.data, 'contestKey')).toEqual(['k:mayor:1017', 'k:mayor:179132']);
    expect(await reportContestKeys()).not.toContain(HELD_COUNTY);
    // REST lookups: a held key answers exactly like an absent one.
    const absent = await rest('/contests/lookup?contestKey=absent');
    for (const key of [
      'k:mayor:1017:held-legacy',
      'k:local_council:1017:held-legacy',
      HELD_COUNTY,
    ]) {
      const held = await rest(`/contests/lookup?contestKey=${encodeURIComponent(key)}`);
      expect(held.status, key).toBe(404);
      expect({ ...held.body, requestId: '' }).toEqual({ ...absent.body, requestId: '' });
      expect(held.raw).not.toContain(SENTINEL);
    }
    const absentReport = await sourceReport('contest:absent');
    const heldReport = await sourceReport(HELD_COUNTY);
    expect(heldReport.status).toBe(404);
    expect({ ...heldReport.body, requestId: '' }).toEqual({ ...absentReport.body, requestId: '' });
    // GraphQL: a null detail without errors, and the same list and total.
    const graph = await gql(
      `query($h: ID!, $a: ID!, $e: ID!) {
        held: electionContest(contestKey: $h) { contestKey }
        absent: electionContest(contestKey: $a) { contestKey }
        list: electionContests(electionKey: $e, pageSize: 100) { items { contestKey } total }
      }`,
      { h: 'k:mayor:1017:held-legacy', a: 'absent', e: 'bec-local-2024' }
    );
    expect(graph.body.errors).toBeUndefined();
    expect(graph.raw).not.toContain(SENTINEL);
    expect(graph.body.data).toEqual({
      held: null,
      absent: null,
      list: { items: CONTESTS.map((contestKey) => ({ contestKey })), total: 5 },
    });
    // MCP: a null item for the held key, and the same list and total.
    const heldTool = await mcp('get_election_contest', { contestKey: 'k:mayor:1017:held-legacy' });
    const absentTool = await mcp('get_election_contest', { contestKey: 'absent' });
    expect(heldTool.content).toMatchObject({ ok: true, item: null });
    // Identical to the absent answer except for the echoed key.
    expect(heldTool.content).toEqual({
      ...absentTool.content,
      query: { contestKey: 'k:mayor:1017:held-legacy' },
      summary: 'No public source contest k:mayor:1017:held-legacy.',
    });
    expect(absentTool.content).toMatchObject({
      query: { contestKey: 'absent' },
      summary: 'No public source contest absent.',
    });
    const listTool = await mcp('list_election_contests', {
      electionKey: 'bec-local-2024',
      pageSize: 100,
    });
    expect(listTool.raw).not.toContain(SENTINEL);
    expect(listTool.content).toMatchObject({ ok: true, items: all.body.data, meta: { total: 5 } });
  });

  it('leaves the catalog readiness and the MCP tools as they were', async ({ skip }) => {
    if (app === undefined) {
      skip();
      return;
    }
    const contest = await rest(`/contests/lookup?contestKey=${encodeURIComponent(ALBA)}`);
    expect(contest.body.data).toMatchObject({
      verifiedOffice: null,
      readiness: { identity: 'HELD', results: 'UNAVAILABLE', mandates: 'UNAVAILABLE' },
    });
    expect(contest.raw).not.toContain('voturi');
    const listed = await requireApp().inject({
      method: 'POST',
      url: '/api/v1/mcp',
      remoteAddress: '10.0.1.1',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(listed.statusCode).toBe(200);
    const names = (
      listed.json<{ result?: { tools?: { name: string }[] } }>().result?.tools ?? []
    ).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['get_election_contest']));
    expect(names.filter((name) => /report|source/iu.test(name))).toEqual([]);
  });
});
