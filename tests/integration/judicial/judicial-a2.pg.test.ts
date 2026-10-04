/**
 * Judicial A2 — real-DDL proof of truthful metadata: county abbreviations (with
 * the deprecated, misnamed SIRUTA aliases), the per-source `sourceOpenedAtBasis`,
 * and the SOURCE-SCOPED as-of maximum.
 *
 * TARGET GUARD. This suite touches ONLY an explicitly provided throwaway
 * database: `JUDICIAL_A2_TEST_PG_URL` + `JUDICIAL_A2_TEST_DB_NAME`, where the name
 * is `server_justice_a2_<run-id>`, the URL is a loopback endpoint whose database
 * path equals that name and which carries NO query parameters or fragment,
 * `current_database()` matches after connecting, and the database holds no user
 * schema or relation before setup. The guard is a pure function, exercised
 * without any connection by the always-run block below. It reads no
 * application/production variable and no `.env`, and never starts a container.
 * Without the two inputs it SKIPS; with `TEST_E2E_REQUIRED=1` it FAILS instead.
 *
 * SCHEMA. The four original scrapper prod migrations, hash-pinned, imported from
 * `SCRAPPER_REPO_ROOT` and executed (`up`) — no hand-written DDL.
 *
 * CONNECTIONS. A setup connection seeds synthetic rows and evaluates independent
 * PostgreSQL witnesses. Every module read goes through `createProdDb` readers
 * whose STARTUP options set `default_transaction_read_only=on` plus a TimeZone
 * and DateStyle, verified on every pooled connection: UTC/ISO and
 * Asia/Kathmandu with SQL,DMY.
 *
 * EXPECTATIONS are written independently: literal ids, county values, dates,
 * bases and as-of strings. The fixture gives each source a different stored
 * maximum (Portal, an unknown third source above it, exceptional infinity and
 * expanded-year sources) and gives ICCJ only null modification times, so a
 * global maximum can never pass for any source. The old-field-only as-of
 * selections fail against the pre-A2 code on that leak (not merely on an
 * absent field).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql, type GraphQLSchema } from 'graphql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeJudicialModule, type JudicialModule } from '@/modules/judicial/index.js';
import {
  createContributorRegistry,
  kernelToolInputSchema,
  type McpToolOutput,
} from '@/modules/shared/index.js';
import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import type { Kysely } from 'kysely';

// ── target guard ───────────────────────────────────────────────────────────────

const REQUIRED = process.env['TEST_E2E_REQUIRED'] === '1';
const TARGET_URL = process.env['JUDICIAL_A2_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['JUDICIAL_A2_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const DB_NAME_RE = /^server_justice_a2_[a-z0-9_]{1,40}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validate an explicit target WITHOUT connecting and without ever echoing the URL
 * (it may carry credentials). Pure: the always-run guard block below calls it
 * with synthetic inputs; the suite's setup calls it before any connection.
 */
const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (targetUrl === '' || targetDb === '') {
    throw new Error(
      'A2 PG proof is REQUIRED (TEST_E2E_REQUIRED=1) but JUDICIAL_A2_TEST_PG_URL / JUDICIAL_A2_TEST_DB_NAME are unset'
    );
  }
  if (!DB_NAME_RE.test(targetDb)) {
    throw new Error('JUDICIAL_A2_TEST_DB_NAME must be server_justice_a2_<run-id>');
  }
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error('JUDICIAL_A2_TEST_PG_URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('JUDICIAL_A2_TEST_PG_URL must be a postgres URL');
  }
  // pg's connection-string parser lets query parameters (host, port, options,
  // ...) override the authority and startup behaviour, so NONE are accepted;
  // the readers add their own controlled `options` only after this guard.
  if (url.search !== '' || url.hash !== '') {
    throw new Error('JUDICIAL_A2_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('JUDICIAL_A2_TEST_PG_URL must be a loopback endpoint');
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error('JUDICIAL_A2_TEST_PG_URL database does not equal JUDICIAL_A2_TEST_DB_NAME');
  }
};

// ── target guard: always runs, never connects ───────────────────────────────────

describe('judicial A2 target guard (pure; no connection, no env)', () => {
  const NAME = 'server_justice_a2_guard';
  const AT = `postgres://a2@127.0.0.1:5432/${NAME}`;

  it.each([
    ['a host override', `${AT}?host=remote.example`, 'host', 'remote.example'],
    ['a port override', `${AT}?port=6543`, 'port', 6543],
  ] as const)('rejects %s that pg itself would honour', (_label, url, field, overridden) => {
    const parsed = new pg.Client({ connectionString: url });
    expect(parsed[field]).toBe(overridden);
    expect(() => {
      assertThrowawayTarget(url, NAME);
    }).toThrow(/no query parameters or fragment/u);
  });

  it.each([
    ['startup options', `${AT}?options=-c%20search_path%3Dx`],
    ['an unrelated parameter', `${AT}?sslmode=disable`],
    ['a fragment', `${AT}#x`],
    ['a host override on an empty authority', `postgres:///${NAME}?host=127.0.0.1`],
  ])('rejects %s', (_label, url) => {
    expect(() => {
      assertThrowawayTarget(url, NAME);
    }).toThrow(/no query parameters or fragment/u);
  });

  it.each([
    ['unset inputs', '', '', /are unset/u],
    [
      'a non-throwaway name',
      `postgres://a2@127.0.0.1/transparenta_prod`,
      'transparenta_prod',
      /server_justice_a2_<run-id>/u,
    ],
    [
      'the A1 throwaway name',
      `postgres://a2@127.0.0.1/server_justice_a1_x`,
      'server_justice_a1_x',
      /server_justice_a2_<run-id>/u,
    ],
    ['a non-postgres URL', `mysql://a2@127.0.0.1/${NAME}`, NAME, /postgres URL/u],
    ['a non-loopback host', `postgres://a2@db.example:5432/${NAME}`, NAME, /loopback/u],
    [
      'a database-name mismatch',
      `postgres://a2@127.0.0.1/server_justice_a2_other`,
      NAME,
      /does not equal/u,
    ],
  ] as const)('rejects %s', (_label, url, name, message) => {
    expect(() => {
      assertThrowawayTarget(url, name);
    }).toThrow(message);
  });

  it.each([AT, `postgresql://a2@localhost/${NAME}`, `postgres://a2@[::1]:5432/${NAME}`])(
    'accepts the clean loopback target %s',
    (url) => {
      expect(() => {
        assertThrowawayTarget(url, NAME);
      }).not.toThrow();
    }
  );
});

// ── pinned original migrations ─────────────────────────────────────────────────

const MIGRATION_SHA256: Readonly<Record<string, string>> = {
  '20260614T120000__justice_domain.ts':
    '6492bd70d06c7e6bd142be0e0a716e1389d9d2acb8a7e4ccf9292de83205dc52',
  '20260614T120100__justice_links.ts':
    '5fded953b09af4a52a8675afb75eb6471ce4cdaaa18c6f839f3c7ff4f48a490e',
  '20260629T130000__justice_case_legal_ref_hearing_anchor.ts':
    '1628173cdcecab0bbd1d72f73e93faf4448f2eb13aa8dedf0c1dbd1ec24d791d',
  '20260629T131000__justice_iccj_court.ts':
    '4bfcea271e16e43ba78e77fdfe0f61f6d5229f4a0574a8b80906ee496137f60a',
};

const applyPinnedMigrations = async (db: Kysely<unknown>): Promise<void> => {
  const root = process.env['SCRAPPER_REPO_ROOT'] ?? '';
  if (root === '') throw new Error('SCRAPPER_REPO_ROOT is required for the pinned migrations');
  const dir = path.join(root, 'src', 'db', 'prod-migrations');
  for (const [file, expected] of Object.entries(MIGRATION_SHA256)) {
    const full = path.join(dir, file);
    const actual = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (actual !== expected) throw new Error(`migration drift: ${file} sha256 ${actual}`);
    const mod = (await import(pathToFileURL(full).href)) as {
      up: (db: Kysely<unknown>) => Promise<void>;
    };
    await mod.up(db);
  }
};

// ── fixture: independently specified rows and expectations ─────────────────────

/** The ICCJ court row inserted by the pinned migration (county_code NULL there). */
const ICCJ_COURT = 'InaltaCurtedeCasatiesiJustitie';
const LOCALITY = 'A2TEST';

const COURTS: readonly { code: string; ordinal: number; county: string | null }[] = [
  { code: 'TEST_A2_B1', ordinal: 9101, county: 'B' },
  { code: 'TEST_A2_B2', ordinal: 9102, county: 'B' },
  { code: 'TEST_A2_TM', ordinal: 9103, county: 'TM' },
  { code: 'TEST_A2_NULL', ordinal: 9104, county: null },
];

interface CaseSeed {
  readonly id: string;
  readonly slug: string;
  readonly court: string;
  readonly number: string;
  readonly opened: string | null;
  readonly modified: string | null;
}

/**
 * Each source has its own maximum. The unknown third source (2027) and the
 * exceptional sources (infinity, expanded year) are ABOVE Portal; ICCJ stores
 * none. A global maximum would therefore be `infinity` for every case.
 */
const CASES: readonly CaseSeed[] = [
  {
    id: '4001',
    slug: 'portal_just',
    court: 'TEST_A2_B1',
    number: '4001/3/2025',
    opened: '2025-02-03 12:00:00+00',
    modified: '2026-03-01 10:00:00.250+00',
  },
  {
    id: '4002',
    slug: 'portal_just',
    court: 'TEST_A2_TM',
    number: '4002/3/2025',
    opened: null,
    modified: '2026-02-01 00:00:00+00',
  },
  {
    id: '4003',
    slug: 'portal_just',
    court: 'TEST_A2_B2',
    number: '4003/3/2025',
    opened: '2024-07-01 12:00:00+00',
    modified: null,
  },
  {
    id: '4101',
    slug: 'iccj',
    court: ICCJ_COURT,
    number: '100/2020',
    opened: '2020-05-06 12:00:00+00',
    modified: null,
  },
  {
    id: '4102',
    slug: 'iccj',
    court: ICCJ_COURT,
    number: '101/2021',
    opened: null,
    modified: null,
  },
  {
    id: '4201',
    slug: 'ecris_test',
    court: 'TEST_A2_NULL',
    number: '4201/1/2023',
    opened: '2023-01-02 12:00:00+00',
    modified: '2027-01-01 00:00:00+00',
  },
  {
    id: '4301',
    slug: 'a2_exceptional',
    court: 'TEST_A2_NULL',
    number: '4301/1/2000',
    opened: '2000-01-01 12:00:00+00',
    modified: 'infinity',
  },
  {
    id: '4302',
    slug: 'a2_expanded',
    court: 'TEST_A2_NULL',
    number: '4302/1/2000',
    opened: null,
    modified: '10000-01-01 00:00:00+00',
  },
];

/** The as-of each SOURCE must report (A1 display rules), written out by hand. */
const AS_OF: Readonly<Record<string, string | null>> = {
  portal_just: '2026-03-01T10:00:00.250Z',
  iccj: null,
  ecris_test: '2027-01-01T00:00:00.000Z',
  a2_exceptional: 'infinity',
  a2_expanded: '10000-01-01T00:00:00.000000+00 AD',
  a2_absent: null,
};

const BASIS: Readonly<Record<string, string>> = {
  portal_just: 'portal_header_data',
  iccj: 'iccj_archive_case_date',
  ecris_test: 'unknown',
  a2_exceptional: 'unknown',
  a2_expanded: 'unknown',
};

/** Session-date display of sourceOpenedAt (noon UTC: the same day in both sessions). */
const OPENED: Readonly<Record<string, string | null>> = {
  '4001': '2025-02-03',
  '4002': null,
  '4003': '2024-07-01',
  '4101': '2020-05-06',
  '4102': null,
  '4201': '2023-01-02',
  '4301': '2000-01-01',
  '4302': null,
};

const seedAll = async (client: pg.Client): Promise<void> => {
  for (const c of COURTS) {
    await client.query(
      `insert into justice.courts (institution_code, ordinal, court_level, locality, county_code)
       values ($1, $2, 'tribunal', $3, $4)`,
      [c.code, c.ordinal, LOCALITY, c.county]
    );
  }
  for (const c of CASES) {
    await client.query(
      `insert into justice.cases (case_id, source_slug, institution_code, case_number,
         source_opened_at, latest_source_modified_at)
       values ($1::bigint, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [c.id, c.slug, c.court, c.number, c.opened, c.modified]
    );
  }
};

// ── readers and the real module ─────────────────────────────────────────────────

interface Session {
  readonly name: string;
  readonly timeZone: string;
  readonly dateStyle: string;
  readonly expectedDateStyle: string;
}

const SESSIONS: readonly Session[] = [
  { name: 'UTC/ISO', timeZone: 'UTC', dateStyle: 'ISO,MDY', expectedDateStyle: 'ISO, MDY' },
  {
    name: 'Asia/Kathmandu SQL,DMY',
    timeZone: 'Asia/Kathmandu',
    dateStyle: 'SQL,DMY',
    expectedDateStyle: 'SQL, DMY',
  },
];

const READER_POOL_MAX = 2;

interface Reader {
  readonly session: Session;
  readonly prod: ProdDb;
  readonly module: JudicialModule;
  readonly schema: GraphQLSchema;
}

const readerUrl = (session: Session): string => {
  const url = new URL(TARGET_URL);
  url.searchParams.set(
    'options',
    `-c default_transaction_read_only=on -c TimeZone=${session.timeZone} -c DateStyle=${session.dateStyle}`
  );
  return url.toString();
};

const GLUE_TYPEDEFS =
  `${scalarTypeDefs}\n` +
  'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
  'type LegalAct { actId: BigInt }\n' +
  'type Query { ping: String }\n';

const openReader = (session: Session): Reader => {
  const prod = createProdDb({ connectionString: readerUrl(session), max: READER_POOL_MAX, min: 0 });
  const module = makeJudicialModule({
    db: prod.db,
    registry: createContributorRegistry(),
    legalActLoader: () => undefined,
  });
  const schema = makeExecutableSchema({
    typeDefs: GLUE_TYPEDEFS + module.graphqlSlice.typeDefs,
    resolvers: {
      ...scalarResolvers,
      ...(module.graphqlResolvers as Record<string, never>),
    },
  });
  return { session, prod, module, schema };
};

/** Every connection of the reader pool must carry the startup settings. */
const verifyReader = async (reader: Reader): Promise<void> => {
  const clients = await Promise.all(
    Array.from({ length: READER_POOL_MAX }, () => reader.prod.pool.connect())
  );
  try {
    for (const client of clients) {
      const r = await client.query<{
        db: string;
        dro: string;
        tro: string;
        tz: string;
        ds: string;
      }>(`select current_database() as db,
                 current_setting('default_transaction_read_only') as dro,
                 current_setting('transaction_read_only') as tro,
                 current_setting('TimeZone') as tz,
                 current_setting('DateStyle') as ds`);
      expect(r.rows[0]).toEqual({
        db: TARGET_DB,
        dro: 'on',
        tro: 'on',
        tz: reader.session.timeZone,
        ds: reader.session.expectedDateStyle,
      });
      await expect(
        client.query(
          `insert into justice.courts (institution_code, ordinal, court_level) values ('X', 1, 'tribunal')`
        )
      ).rejects.toMatchObject({ code: '25006' });
    }
  } finally {
    for (const client of clients) client.release();
  }
};

const gql = async (reader: Reader, source: string, variableValues?: Record<string, unknown>) => {
  const result = await graphql({
    schema: reader.schema,
    source,
    ...(variableValues !== undefined && { variableValues }),
  });
  return {
    data: result.data ?? null,
    errors: result.errors?.map((e) => ({ message: e.message, code: e.extensions['code'] })),
  };
};

const mcp = async (
  reader: Reader,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolOutput> => {
  const tool = reader.module.mcpTools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name}`);
  const parsed = kernelToolInputSchema(tool).safeParse(args);
  if (!parsed.success) throw new Error(`mcp input rejected: ${name}`);
  return tool.handler(parsed.data);
};

const caseSeed = (id: string): CaseSeed => {
  const c = CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`case ${id}`);
  return c;
};

const asOfView = (slug: string) => ({
  asOf: AS_OF[slug] ?? null,
  estimated: true,
  sourceSlug: slug,
  basis: 'max_stored_source_modified_at',
  captureFreshnessAt: null,
  loadFreshnessAt: null,
});

const DETAIL_BY_ID = `query ($id: BigInt) { judicialCase(caseId: $id) {
  case { caseId sourceSlug institutionCode caseNumber sourceOpenedAt sourceOpenedAtBasis }
  asOf { asOf estimated sourceSlug basis captureFreshnessAt loadFreshnessAt } } }`;

const DETAIL_BY_KEY = `query ($i: String, $n: String) { judicialCase(institutionCode: $i, caseNumber: $n) {
  case { caseId sourceSlug institutionCode caseNumber sourceOpenedAt sourceOpenedAtBasis }
  asOf { asOf estimated sourceSlug basis captureFreshnessAt loadFreshnessAt } } }`;

/** Only fields that predate A2: the old global maximum fails these on the values. */
const OLD_FIELDS = `query ($id: BigInt) { judicialCase(caseId: $id) {
  case { caseId sourceOpenedAt } asOf { asOf estimated } } }`;

const COURTS_QUERY = `query ($filter: JudicialCourtsFilter) {
  judicialCourts(filter: $filter) { institutionCode countyCode countySirutaCode } }`;

// ── the suite ─────────────────────────────────────────────────────────────────

const describeA2 = CONFIGURED || REQUIRED ? describe : describe.skip;

describeA2('judicial A2 — actual DDL, explicit throwaway database', () => {
  let setup: pg.Client | undefined;
  let setupDb: ProdDb | undefined;
  const readers: Reader[] = [];

  const witness = async (text: string, params: readonly unknown[]): Promise<unknown> => {
    if (setup === undefined) throw new Error('setup not ready');
    const r = await setup.query<{ v: unknown }>(text, [...params]);
    return r.rows[0]?.v;
  };

  beforeAll(async () => {
    assertThrowawayTarget(TARGET_URL, TARGET_DB);
    setup = new pg.Client({ connectionString: TARGET_URL });
    await setup.connect();
    const identity = await setup.query<{ db: string; schemas: number; relations: number }>(`
      select current_database() as db,
        (select count(*)::int from pg_namespace n
          where n.nspname not in ('pg_catalog', 'information_schema', 'public', 'pg_toast')
            and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%') as schemas,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
            and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%'
            and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')) as relations`);
    expect(identity.rows[0]).toEqual({ db: TARGET_DB, schemas: 0, relations: 0 });

    setupDb = createProdDb({ connectionString: TARGET_URL, max: 1, min: 0 });
    await applyPinnedMigrations(setupDb.db as unknown as Kysely<unknown>);
    await seedAll(setup);

    for (const session of SESSIONS) {
      const reader = openReader(session);
      readers.push(reader);
      await verifyReader(reader);
    }
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([
      ...readers.map((r) => r.prod.db.destroy()),
      setupDb?.db.destroy(),
      setup?.end(),
    ]);
  });

  // ── fixture self-checks (independent PostgreSQL evidence) ──────────────────────

  it('each hand-written source as-of denotes that source own stored maximum (PostgreSQL witness)', async () => {
    const maxima = await setup!.query<{ slug: string; has_max: boolean }>(
      `select source_slug as slug, max(latest_source_modified_at) is not null as has_max
         from justice.cases group by source_slug order by source_slug`
    );
    expect(maxima.rows).toEqual([
      { slug: 'a2_exceptional', has_max: true },
      { slug: 'a2_expanded', has_max: true },
      { slug: 'ecris_test', has_max: true },
      { slug: 'iccj', has_max: false },
      { slug: 'portal_just', has_max: true },
    ]);
    for (const [slug, display] of Object.entries(AS_OF)) {
      if (display === null) continue;
      const ordinary = display.endsWith('Z');
      expect(
        await witness(
          ordinary
            ? `select ($1::timestamptz is not distinct from date_trunc('milliseconds', max(latest_source_modified_at))) as v from justice.cases where source_slug = $2`
            : `select ($1::timestamptz is not distinct from max(latest_source_modified_at)) as v from justice.cases where source_slug = $2`,
          [display, slug]
        ),
        slug
      ).toBe(true);
    }
    // The global maximum every source would have shown before A2.
    expect(
      await witness(`select max(latest_source_modified_at)::text as v from justice.cases`, [])
    ).toBe('infinity');
  });

  it('the stored county values are the literal fixture abbreviations; the ICCJ court has none', async () => {
    const r = await setup!.query<{ code: string; county: string | null }>(
      `select institution_code as code, county_code as county from justice.courts
        where locality = $1 or institution_code = $2 order by ordinal`,
      [LOCALITY, ICCJ_COURT]
    );
    expect(r.rows).toEqual([
      { code: ICCJ_COURT, county: null },
      { code: 'TEST_A2_B1', county: 'B' },
      { code: 'TEST_A2_B2', county: 'B' },
      { code: 'TEST_A2_TM', county: 'TM' },
      { code: 'TEST_A2_NULL', county: null },
    ]);
  });

  // ── county output + filters ────────────────────────────────────────────────────

  const scoped = (extra: Record<string, unknown>) => ({
    q: { contains: LOCALITY },
    ...extra,
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: countyCode and the deprecated countySirutaCode carry the same stored abbreviation (or null)',
    async (_name, readerIndex) => {
      const reader = readers[readerIndex]!;
      const res = await gql(reader, COURTS_QUERY, { filter: scoped({}) });
      expect(res.errors).toBeUndefined();
      expect(res.data).toEqual({
        judicialCourts: [
          { institutionCode: 'TEST_A2_B1', countyCode: 'B', countySirutaCode: 'B' },
          { institutionCode: 'TEST_A2_B2', countyCode: 'B', countySirutaCode: 'B' },
          { institutionCode: 'TEST_A2_TM', countyCode: 'TM', countySirutaCode: 'TM' },
          { institutionCode: 'TEST_A2_NULL', countyCode: null, countySirutaCode: null },
        ],
      });
      const iccj = (await reader.module.repos.courts.getByCode(ICCJ_COURT))._unsafeUnwrap();
      expect(iccj).toMatchObject({ countyCode: null, countySirutaCode: null });
    }
  );

  it.each([
    ['countyCode B', { countyCode: { in: ['B'] } }, ['TEST_A2_B1', 'TEST_A2_B2']],
    ['the countySiruta alias B', { countySiruta: { in: ['B'] } }, ['TEST_A2_B1', 'TEST_A2_B2']],
    ['countyCode TM', { countyCode: { in: ['TM'] } }, ['TEST_A2_TM']],
    [
      'both aliases agreeing',
      { countyCode: { in: ['B', 'TM'] }, countySiruta: { in: ['B'] } },
      ['TEST_A2_B1', 'TEST_A2_B2'],
    ],
    ['both aliases contradicting', { countyCode: { in: ['B'] }, countySiruta: { in: ['TM'] } }, []],
  ] as const)(
    '%s filters the stored county abbreviation (AND across aliases)',
    async (_l, f, ids) => {
      for (const reader of readers) {
        const res = await gql(reader, COURTS_QUERY, { filter: scoped(f) });
        expect(res.errors).toBeUndefined();
        expect(
          (res.data?.['judicialCourts'] as { institutionCode: string }[]).map(
            (c) => c.institutionCode
          )
        ).toEqual([...ids]);
      }
    }
  );

  // ── per-source date basis + source-scoped as-of ───────────────────────────────

  it.each(
    SESSIONS.flatMap((s, i) =>
      CASES.map((c) => [`${s.name} case ${c.id} (${c.slug})`, i, c.id] as const)
    )
  )('%s: detail by id and natural key, GraphQL and MCP', async (_label, readerIndex, id) => {
    const reader = readers[readerIndex]!;
    const c = caseSeed(id);
    const expectedCase = {
      caseId: c.id,
      sourceSlug: c.slug,
      institutionCode: c.court,
      caseNumber: c.number,
      sourceOpenedAt: OPENED[c.id] ?? null,
      sourceOpenedAtBasis: BASIS[c.slug],
    };
    const expected = { judicialCase: { case: expectedCase, asOf: asOfView(c.slug) } };

    const byId = await gql(reader, DETAIL_BY_ID, { id: c.id });
    expect(byId.errors).toBeUndefined();
    expect(byId.data).toEqual(expected);
    const byKey = await gql(reader, DETAIL_BY_KEY, { i: c.court, n: c.number });
    expect(byKey.errors).toBeUndefined();
    expect(byKey.data).toEqual(expected);

    for (const args of [{ caseId: c.id }, { institutionCode: c.court, caseNumber: c.number }]) {
      const out = await mcp(reader, 'get_judicial_case', args);
      expect(out.ok).toBe(true);
      const item = out.item as { case: Record<string, unknown>; asOf: unknown };
      expect(item.case).toMatchObject(expectedCase);
      expect(item.asOf).toEqual(asOfView(c.slug));
    }
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: old-field selections show each source own maximum (null for ICCJ), never the global infinity',
    async (_name, readerIndex) => {
      const reader = readers[readerIndex]!;
      for (const [id, asOf] of [
        ['4001', '2026-03-01T10:00:00.250Z'],
        ['4101', null],
        ['4102', null],
        ['4201', '2027-01-01T00:00:00.000Z'],
        ['4301', 'infinity'],
        ['4302', '10000-01-01T00:00:00.000000+00 AD'],
      ] as const) {
        const res = await gql(reader, OLD_FIELDS, { id });
        expect(res.errors).toBeUndefined();
        expect(res.data, `case ${id}`).toEqual({
          judicialCase: {
            case: { caseId: id, sourceOpenedAt: OPENED[id] ?? null },
            asOf: { asOf, estimated: true },
          },
        });
      }
    }
  );

  it('the repo reads one source maximum; a source without rows (or with only nulls) is null', async () => {
    const repo = readers[0]!.module.repos.cases;
    for (const slug of Object.keys(AS_OF)) {
      expect((await repo.getAsOf(slug))._unsafeUnwrap(), slug).toEqual(asOfView(slug));
    }
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: case-list nodes carry the per-source basis with unchanged dates',
    async (_name, readerIndex) => {
      const reader = readers[readerIndex]!;
      const res = await gql(
        reader,
        `query ($filter: JudicialCasesFilter) {
          judicialCases(filter: $filter, sort: openedAt, dir: ASC, first: 10) {
            edges { node { caseId sourceSlug sourceOpenedAt sourceOpenedAtBasis } } } }`,
        { filter: { institutionCode: { in: ['TEST_A2_NULL', ICCJ_COURT] } } }
      );
      expect(res.errors).toBeUndefined();
      const nodes = (res.data?.['judicialCases'] as { edges: { node: unknown }[] }).edges.map(
        (e) => e.node
      );
      expect(nodes).toEqual([
        {
          caseId: '4301',
          sourceSlug: 'a2_exceptional',
          sourceOpenedAt: '2000-01-01',
          sourceOpenedAtBasis: 'unknown',
        },
        {
          caseId: '4101',
          sourceSlug: 'iccj',
          sourceOpenedAt: '2020-05-06',
          sourceOpenedAtBasis: 'iccj_archive_case_date',
        },
        {
          caseId: '4201',
          sourceSlug: 'ecris_test',
          sourceOpenedAt: '2023-01-02',
          sourceOpenedAtBasis: 'unknown',
        },
        {
          caseId: '4102',
          sourceSlug: 'iccj',
          sourceOpenedAt: null,
          sourceOpenedAtBasis: 'iccj_archive_case_date',
        },
        {
          caseId: '4302',
          sourceSlug: 'a2_expanded',
          sourceOpenedAt: null,
          sourceOpenedAtBasis: 'unknown',
        },
      ]);
    }
  );
});
