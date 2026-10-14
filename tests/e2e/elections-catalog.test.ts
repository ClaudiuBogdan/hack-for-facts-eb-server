/**
 * Elections catalog reads against a REAL PostgreSQL: the scrapper's actual
 * elections DDL (three digest-pinned prod migrations, read from the sibling
 * checkout or `SCRAPPER_REPO_ROOT`) under the real redesign app, driven over
 * REST, GraphQL and the `/api/v1/mcp` JSON-RPC path. It proves what the SQL-text
 * tests cannot: the privacy predicates filter (every stored row was public in
 * the 2026-10-02 snapshot, so live data cannot discriminate), counts agree
 * with the pages, keys sort in `collate "C"` order, dates read as YYYY-MM-DD,
 * the three surfaces answer alike, and no stored finality, correction or
 * `attrs` value reaches any of them.
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

const EDITIONS = [
  'BEC-legacy-1992',
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
    for (const page of [1, 2, 3]) {
      const res = await rest(`/editions?pageSize=2&page=${String(page)}`);
      expect(res.body.meta).toMatchObject({ page: { total: 5 }, hasMore: page < 3 });
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
      total: 5,
      hasMore: false,
    });
    const tool = await mcp('list_election_editions', { pageSize: 100 });
    expect(tool.raw).not.toContain(SENTINEL);
    expect(tool.content).toMatchObject({
      ok: true,
      items: all.body.data,
      meta: { page: 1, pageSize: 100, total: 5, hasMore: false, totalCounts: 'source_editions' },
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
});
