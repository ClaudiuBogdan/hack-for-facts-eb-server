/**
 * Judicial A3 — real-DDL proof of the input contract and the company query:
 * intersected year intervals over the full native timestamp-year domain (BC,
 * expanded, domain edges, session spillover), honest year aggregate keys, null
 * meaning absent, discovery/groupBy validation, the direct-ID int8 guard, the
 * repaired company case list (numeric DISTINCT key, one case per result, strict
 * cursor, truthful date) and the A3 case-cursor restart.
 *
 * TARGET GUARD. This suite touches ONLY an explicitly provided throwaway
 * database: `JUDICIAL_A3_TEST_PG_URL` + `JUDICIAL_A3_TEST_DB_NAME`, where the name
 * is `server_justice_a3_<run-id>`, the URL is a loopback endpoint whose database
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
 * PostgreSQL witnesses (including the EXACT pre-A3 company query text). Every
 * module read goes through `createProdDb` readers whose STARTUP options set
 * `default_transaction_read_only=on` plus a TimeZone and DateStyle, verified on
 * every pooled connection: UTC/ISO and Asia/Kathmandu (+05:45) with SQL,DMY.
 *
 * EXPECTATIONS are literal case ids per session, written by hand — never derived
 * from the helper under test. Rows straddling a session year boundary make the
 * two sessions disagree on purpose (2021-12-31 20:00 UTC is 2022 in Kathmandu;
 * 9999-12-31 20:00 UTC is 10000; the timestamp maximum is 294277), proving that
 * both the native January-boundary form and the native extract form keep the
 * existing SESSION calendar-year meaning.
 *
 * OLD-CODE ATTRIBUTION (behavioral, not an absent field): the pre-A3 company
 * SELECT fails with 42P10 (witnessed here verbatim on the setup connection);
 * `eq 2024 + gte 2020` returned 2020-2024 (rows); `gte 2026` admitted +infinity
 * (rows); `eq -1`, `year 0`, a null year operand, a BC company bound and an int8
 * overflow id reached PostgreSQL as errors; an infinite date failed the year
 * aggregate and the company summary; a null flat list threw; an unknown dim
 * threw; an unknown court level silently matched nothing. A new field or helper
 * name alone is never counted as defect proof.
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
import { judicialCasesSpec } from '@/modules/judicial/shell/filters/judicial.spec.js';
import {
  buildNextCursor,
  createContributorRegistry,
  decodeCursor,
  fhashFor,
  kernelToolInputSchema,
  type McpToolOutput,
} from '@/modules/shared/index.js';
import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import type { Kysely } from 'kysely';

// ── target guard ───────────────────────────────────────────────────────────────

const REQUIRED = process.env['TEST_E2E_REQUIRED'] === '1';
const TARGET_URL = process.env['JUDICIAL_A3_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['JUDICIAL_A3_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const DB_NAME_RE = /^server_justice_a3_[a-z0-9_]{1,40}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validate an explicit target WITHOUT connecting and without ever echoing the URL
 * (it may carry credentials). Pure: the always-run guard block below calls it
 * with synthetic inputs; the suite's setup calls it before any connection.
 */
const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (targetUrl === '' || targetDb === '') {
    throw new Error(
      'A3 PG proof is REQUIRED (TEST_E2E_REQUIRED=1) but JUDICIAL_A3_TEST_PG_URL / JUDICIAL_A3_TEST_DB_NAME are unset'
    );
  }
  if (!DB_NAME_RE.test(targetDb)) {
    throw new Error('JUDICIAL_A3_TEST_DB_NAME must be server_justice_a3_<run-id>');
  }
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error('JUDICIAL_A3_TEST_PG_URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('JUDICIAL_A3_TEST_PG_URL must be a postgres URL');
  }
  // pg's connection-string parser lets query parameters (host, port, options,
  // ...) override the authority and startup behaviour, so NONE are accepted;
  // the readers add their own controlled `options` only after this guard.
  if (url.search !== '' || url.hash !== '') {
    throw new Error('JUDICIAL_A3_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('JUDICIAL_A3_TEST_PG_URL must be a loopback endpoint');
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error('JUDICIAL_A3_TEST_PG_URL database does not equal JUDICIAL_A3_TEST_DB_NAME');
  }
};

describe('judicial A3 target guard (pure; no connection, no env)', () => {
  const NAME = 'server_justice_a3_guard';
  const AT = `postgres://a3@127.0.0.1:5432/${NAME}`;

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
      `postgres://a3@127.0.0.1/transparenta_prod`,
      'transparenta_prod',
      /server_justice_a3_<run-id>/u,
    ],
    [
      'the A2 throwaway name',
      `postgres://a3@127.0.0.1/server_justice_a2_x`,
      'server_justice_a2_x',
      /server_justice_a3_<run-id>/u,
    ],
    ['a non-postgres URL', `mysql://a3@127.0.0.1/${NAME}`, NAME, /postgres URL/u],
    ['a non-loopback host', `postgres://a3@db.example:5432/${NAME}`, NAME, /loopback/u],
    [
      'a database-name mismatch',
      `postgres://a3@127.0.0.1/server_justice_a3_other`,
      NAME,
      /does not equal/u,
    ],
  ] as const)('rejects %s', (_label, url, name, message) => {
    expect(() => {
      assertThrowawayTarget(url, name);
    }).toThrow(message);
  });

  it.each([AT, `postgresql://a3@localhost/${NAME}`, `postgres://a3@[::1]:5432/${NAME}`])(
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

// ── fixture: independently specified rows ──────────────────────────────────────

/** The ICCJ court row inserted by the pinned migration (court_level inalta_curte). */
const ICCJ_COURT = 'InaltaCurtedeCasatiesiJustitie';
const YEAR_COURT = 'TEST_A3_YEAR';
const AGG_COURT = 'TEST_A3_AGG';
const CO_COURT = 'TEST_A3_CO';
const LOCALITY = 'A3LOC';

const COURTS: readonly { code: string; ordinal: number; level: string }[] = [
  { code: YEAR_COURT, ordinal: 9301, level: 'tribunal' },
  { code: AGG_COURT, ordinal: 9302, level: 'tribunal' },
  { code: CO_COURT, ordinal: 9303, level: 'tribunal' },
  { code: 'TEST_A3_L_JUD', ordinal: 9304, level: 'judecatorie' },
  { code: 'TEST_A3_L_TRM', ordinal: 9305, level: 'tribunal_militar' },
  { code: 'TEST_A3_L_CA', ordinal: 9306, level: 'curte_de_apel' },
  { code: 'TEST_A3_L_CMA', ordinal: 9307, level: 'curte_militara_apel' },
];

interface CaseSeed {
  readonly id: string;
  readonly court: string;
  readonly opened: string | null;
  readonly slug?: string;
}

/** Year-domain rows (court TEST_A3_YEAR). Literal session years in the comments. */
const YEAR_CASES: readonly CaseSeed[] = [
  { id: '3020', court: YEAR_COURT, opened: '2020-06-15 12:00:00+00' }, // 2020 | 2020
  { id: '3023', court: YEAR_COURT, opened: '2023-06-15 12:00:00+00' }, // 2023 | 2023
  { id: '3024', court: YEAR_COURT, opened: '2024-06-15 12:00:00+00' }, // 2024 | 2024
  { id: '3025', court: YEAR_COURT, opened: '2025-06-15 12:00:00+00' }, // 2025 | 2025
  { id: '3101', court: YEAR_COURT, opened: '0001-06-15 12:00:00+00 BC' }, // -1 | -1
  { id: '3102', court: YEAR_COURT, opened: '4714-11-24 00:00:00+00 BC' }, // -4714 | -4714 (native minimum)
  { id: '3103', court: YEAR_COURT, opened: '10000-06-15 12:00:00+00' }, // 10000 | 10000
  { id: '3104', court: YEAR_COURT, opened: '294276-12-31 23:59:59.999999+00' }, // 294276 | 294277 (native maximum)
  { id: '3105', court: YEAR_COURT, opened: '2021-12-31 20:00:00+00' }, // 2021 | 2022
  { id: '3106', court: YEAR_COURT, opened: '9999-12-31 20:00:00+00' }, // 9999 | 10000
  { id: '3107', court: YEAR_COURT, opened: 'infinity' },
  { id: '3108', court: YEAR_COURT, opened: '-infinity' },
  { id: '3109', court: YEAR_COURT, opened: null },
];

/** Aggregate rows (court TEST_A3_AGG): finite, null and both infinities. */
const AGG_CASES: readonly CaseSeed[] = [
  { id: '3201', court: AGG_COURT, opened: '2024-03-01 12:00:00+00' },
  { id: '3202', court: AGG_COURT, opened: '2024-04-01 12:00:00+00' },
  { id: '3203', court: AGG_COURT, opened: '2023-03-01 12:00:00+00' },
  { id: '3204', court: AGG_COURT, opened: null },
  { id: '3205', court: AGG_COURT, opened: 'infinity' },
  { id: '3206', court: AGG_COURT, opened: '-infinity' },
];

/** One case per non-tribunal level (inalta_curte on the migration ICCJ row). */
const LEVEL_CASES: readonly CaseSeed[] = [
  { id: '3301', court: 'TEST_A3_L_JUD', opened: '2019-06-15 12:00:00+00' },
  { id: '3302', court: 'TEST_A3_L_TRM', opened: '2019-06-15 12:00:00+00' },
  { id: '3303', court: 'TEST_A3_L_CA', opened: '2019-06-15 12:00:00+00' },
  { id: '3304', court: 'TEST_A3_L_CMA', opened: '2019-06-15 12:00:00+00' },
  { id: '3305', court: ICCJ_COURT, opened: '2019-06-15 12:00:00+00', slug: 'iccj' },
];

const ABOVE_2_53 = '9007199254740993';

/** Company rows (court TEST_A3_CO). 4900/4901 are non-published / person controls. */
const CO_CASES: readonly CaseSeed[] = [
  { id: '9', court: CO_COURT, opened: '2024-06-15 12:00:00+00' },
  { id: '10', court: CO_COURT, opened: null },
  { id: '100', court: CO_COURT, opened: 'infinity' },
  { id: '4001', court: CO_COURT, opened: '0001-06-15 12:00:00+00 BC' },
  { id: ABOVE_2_53, court: CO_COURT, opened: '2023-06-15 12:00:00+00' },
  { id: '4900', court: CO_COURT, opened: '2024-01-01 12:00:00+00' },
  { id: '4901', court: CO_COURT, opened: '2024-01-01 12:00:00+00' },
];

const CUI = '123';
const NK_PUBLISHED_A = '7001';
const NK_PUBLISHED_B = '7002';
const NK_UNPUBLISHED = '7003';

/** [name_key_id, cui, status, resolver_version]: duplicates differ only by resolver. */
const COMPANY_CANDIDATES: readonly (readonly [string, string, string, string])[] = [
  [NK_PUBLISHED_A, CUI, 'published', 'test-a3-r1'],
  [NK_PUBLISHED_A, CUI, 'published', 'test-a3-r2'],
  [NK_PUBLISHED_B, CUI, 'published', 'test-a3-r1'],
  [NK_UNPUBLISHED, CUI, 'candidate', 'test-a3-r1'],
  [NK_UNPUBLISHED, CUI, 'auto_accepted', 'test-a3-r2'],
  [NK_UNPUBLISHED, CUI, 'needs_review', 'test-a3-r3'],
  [NK_UNPUBLISHED, CUI, 'rejected', 'test-a3-r4'],
  [NK_PUBLISHED_A, '456', 'published', 'test-a3-r1'],
];

/** [case_id, party_index, name_key_id | null, party_kind]: repeated parties in case 9. */
const COMPANY_PARTIES: readonly (readonly [string, number, string | null, string])[] = [
  ['9', 0, NK_PUBLISHED_A, 'company'],
  ['9', 1, NK_PUBLISHED_A, 'company'],
  ['9', 2, NK_PUBLISHED_B, 'company'],
  ['10', 0, NK_PUBLISHED_A, 'company'],
  ['100', 0, NK_PUBLISHED_B, 'company'],
  ['4001', 0, NK_PUBLISHED_A, 'company'],
  ['4001', 1, NK_PUBLISHED_B, 'company'],
  [ABOVE_2_53, 0, NK_PUBLISHED_A, 'company'],
  ['4900', 0, NK_UNPUBLISHED, 'company'],
  ['4901', 0, null, 'person'],
];

/** The published company cases, numeric id DESCENDING (text order would differ). */
const COMPANY_ORDER = [ABOVE_2_53, '4001', '100', '10', '9'] as const;

/** Session-date display of each company case (noon UTC: same day in both sessions). */
const COMPANY_DISPLAY: Readonly<Record<string, string | null>> = {
  [ABOVE_2_53]: '2023-06-15',
  '4001': '0001-06-15 BC',
  '100': 'infinity',
  '10': null,
  '9': '2024-06-15',
};

/**
 * [id, case, target act, span start, span end]: reverse references (act 7
 * twice, act int8-max once). The real current-row key is (case_id,
 * coalesce(hearing_index, -1), source_field, coalesce(span_start, -1),
 * coalesce(span_end, -1), resolver_version) — raw_text is not part of it. So
 * the two object citations of case 9 are two distinct occurrences in the case
 * object, each anchored by its own explicit character span (the token
 * `Legea 7/2000 ref <id>` is 21 characters long).
 */
const REFS: readonly (readonly [string, string, string, number, number])[] = [
  ['8001', '9', '7', 0, 21],
  ['8002', '9', '9223372036854775807', 30, 51],
  ['8003', ABOVE_2_53, '7', 0, 21],
];

const seedAll = async (client: pg.Client): Promise<void> => {
  for (const c of COURTS) {
    await client.query(
      `insert into justice.courts (institution_code, ordinal, court_level, locality)
       values ($1, $2, $3, $4)`,
      [c.code, c.ordinal, c.level, LOCALITY]
    );
  }
  for (const c of [...YEAR_CASES, ...AGG_CASES, ...LEVEL_CASES, ...CO_CASES]) {
    await client.query(
      `insert into justice.cases (case_id, source_slug, institution_code, case_number,
         category, source_opened_at, latest_source_modified_at)
       values ($1::bigint, $2, $3, $4, $5, $6::timestamptz, null)`,
      [c.id, c.slug ?? 'portal_just', c.court, `${c.id}/3/2024`, `A3CAT${c.id}`, c.opened]
    );
  }
  for (const [id, key] of [
    [NK_PUBLISHED_A, 'a3 test company a'],
    [NK_PUBLISHED_B, 'a3 test company b'],
    [NK_UNPUBLISHED, 'a3 test company c'],
  ] as const) {
    await client.query(
      `insert into justice.party_name_keys (name_key_id, name_key, display_name, party_kind,
         classifier_version, normalizer_version)
       overriding system value
       values ($1::bigint, $2, $3, 'company', 'party-kind-v0', 'test-a3')`,
      [id, key, `SC ${key.toUpperCase()} SRL`]
    );
  }
  for (const [caseId, index, nameKey, kind] of COMPANY_PARTIES) {
    await client.query(
      `insert into justice.case_parties (case_id, party_index, name_key_id, party_kind,
         classifier_version, classifier_rule, row_hash, latest_response_id, parser_version)
       values ($1::bigint, $2, $3::bigint, $4, 'party-kind-v0', $5, 'h', 1, 'test-a3')`,
      [caseId, index, nameKey, kind, kind === 'company' ? 'company_legal_form' : 'person_shape']
    );
  }
  for (const [nameKey, cui, status, resolver] of COMPANY_CANDIDATES) {
    await client.query(
      `insert into justice.party_company_candidates (name_key_id, candidate_cui, method,
         confidence_tier, validation_status, resolver_version)
       values ($1::bigint, $2, 'exact_normalized_name_unique', 'A', $3, $4)`,
      [nameKey, cui, status, resolver]
    );
  }
  for (const [id, caseId, target, spanStart, spanEnd] of REFS) {
    await client.query(
      `insert into justice.case_legal_references (case_legal_reference_id, case_id, source_field,
         raw_text, span_start, span_end, act_type, act_number, act_year, target_act_id,
         resolution_status, resolver_version)
       overriding system value
       values ($1::bigint, $2::bigint, 'object', $3, $4, $5, 'lege', '7', 2000, $6::bigint,
               'unique', 'test-a3')`,
      [id, caseId, `Legea 7/2000 ref ${id}`, spanStart, spanEnd, target]
    );
  }
};

/** The EXACT pre-A3 company case-list SELECT (copied verbatim, with its bind shape). */
const OLD_COMPANY_LIST_SQL = `
        select distinct c.case_id::text as case_id, c.institution_code, c.case_number,
               c.category, to_char(c.source_opened_at, 'YYYY-MM-DD') as source_opened_at
        from justice.party_company_candidates pcc
        join justice.case_parties p on p.name_key_id = pcc.name_key_id
        join justice.cases c on c.case_id = p.case_id
        left join justice.courts co on co.institution_code = c.institution_code
        where pcc.validation_status = $1
          and pcc.candidate_cui = $2
        order by c.case_id desc
        limit $3
      `;

// ── readers and the real module ─────────────────────────────────────────────────

interface Session {
  readonly name: string;
  readonly timeZone: string;
  readonly dateStyle: string;
  readonly expectedDateStyle: string;
  /** Index into the per-session literal expectations below. */
  readonly k: 0 | 1;
}

const SESSIONS: readonly Session[] = [
  { name: 'UTC/ISO', timeZone: 'UTC', dateStyle: 'ISO,MDY', expectedDateStyle: 'ISO, MDY', k: 0 },
  {
    name: 'Asia/Kathmandu SQL,DMY',
    timeZone: 'Asia/Kathmandu',
    dateStyle: 'SQL,DMY',
    expectedDateStyle: 'SQL, DMY',
    k: 1,
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

interface GqlResult {
  readonly data: Record<string, unknown> | null;
  readonly errors: { message: string; code: unknown }[] | undefined;
}

const gql = async (
  reader: Reader,
  source: string,
  variableValues?: Record<string, unknown>
): Promise<GqlResult> => {
  const result = await graphql({
    schema: reader.schema,
    source,
    ...(variableValues !== undefined && { variableValues }),
  });
  return {
    data: (result.data as Record<string, unknown> | null | undefined) ?? null,
    errors: result.errors?.map((e) => ({ message: e.message, code: e.extensions['code'] })),
  };
};

const tool = (reader: Reader, name: string) => {
  const found = reader.module.mcpTools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`tool ${name}`);
  return found;
};

/** Through the real MCP input schema, then the handler. */
const mcp = async (
  reader: Reader,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolOutput> => {
  const t = tool(reader, name);
  const parsed = kernelToolInputSchema(t).safeParse(args);
  if (!parsed.success) throw new Error(`mcp input rejected: ${name}`);
  return t.handler(parsed.data);
};

const LIST_Q = `query ($filter: JudicialCasesFilter, $first: Int, $after: String) {
  judicialCases(filter: $filter, first: $first, after: $after) {
    edges { cursor node { caseId } } pageInfo { hasNextPage endCursor } } }`;
const CASELOAD_Q = `query ($groupBy: JudicialAggregateGroupBy!, $filter: JudicialCasesFilter) {
  judicialCaseload(groupBy: $groupBy, filter: $filter) { groups { key caseCount } denominator coverage } }`;
const DETAIL_Q = `query ($id: BigInt) { judicialCase(caseId: $id) { case { caseId caseNumber } } }`;
const CITING_Q = `query ($id: BigInt!, $first: Int, $after: String) {
  judicialCasesCitingAct(targetActId: $id, first: $first, after: $after) {
    edges { cursor node { caseId } } pageInfo { hasNextPage endCursor } } }`;
const COMPANY_Q = `query ($cui: String!, $courtLevel: [JudicialCourtLevel!], $category: [String!], $yearFrom: Int, $yearTo: Int) {
  judicialCompanyLitigation(cui: $cui, courtLevel: $courtLevel, category: $category, yearFrom: $yearFrom, yearTo: $yearTo) {
    cui caseCount courtLevels { courtLevel count } years { year count } coverage caveats } }`;
const COMPANY_CASES_Q = `query ($cui: String!, $first: Int, $after: String, $courtLevel: [JudicialCourtLevel!], $category: [String!], $yearFrom: Int, $yearTo: Int) {
  judicialCompanyLitigationCases(cui: $cui, first: $first, after: $after, courtLevel: $courtLevel, category: $category, yearFrom: $yearFrom, yearTo: $yearTo) {
    edges { cursor node { caseId institutionCode caseNumber category sourceOpenedAt } }
    pageInfo { hasNextPage endCursor } } }`;
const RESOLVE_Q = `query ($dim: String!, $q: String!, $limit: Int) {
  judicialResolve(dim: $dim, q: $q, limit: $limit) { kind value } }`;

interface Conn {
  readonly edges: { cursor: string; node: Record<string, unknown> }[];
  readonly pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const conn = (res: GqlResult, field: string): Conn => {
  expect(res.errors).toBeUndefined();
  return res.data?.[field] as Conn;
};

const YEAR_BOUND = { institutionCode: { in: [YEAR_COURT] } };

const yearIds = async (reader: Reader, year: Record<string, unknown>): Promise<string[]> =>
  conn(
    await gql(reader, LIST_Q, { filter: { ...YEAR_BOUND, year }, first: 50 }),
    'judicialCases'
  ).edges.map((e) => String(e.node['caseId']));

/** Literal per-session expectations [UTC, Kathmandu], ids in the list order (id DESC). */
const YEAR_EXPECTATIONS: readonly (readonly [
  string,
  Record<string, unknown>,
  readonly string[],
  readonly string[],
])[] = [
  ['eq 2024 + gte 2020 (only 2024)', { eq: 2024, gte: 2020 }, ['3024'], ['3024']],
  ['eq 2024 + lte 2023 (contradictory)', { eq: 2024, lte: 2023 }, [], []],
  [
    'gte 2020 + lte 2024',
    { gte: 2020, lte: 2024 },
    ['3105', '3024', '3023', '3020'],
    ['3105', '3024', '3023', '3020'],
  ],
  [
    'gte 2021 + between 2020..2024',
    { gte: 2021, between: { from: 2020, to: 2024 } },
    ['3105', '3024', '3023'],
    ['3105', '3024', '3023'],
  ],
  [
    'lte 2022 + between 2020..2024',
    { lte: 2022, between: { from: 2020, to: 2024 } },
    ['3105', '3020'],
    ['3105', '3020'],
  ],
  [
    'eq 2023 + gte 2020 + lte 2024 + between 2021..2025',
    { eq: 2023, gte: 2020, lte: 2024, between: { from: 2021, to: 2025 } },
    ['3023'],
    ['3023'],
  ],
  ['between 2024..2020 (reversed)', { between: { from: 2024, to: 2020 } }, [], []],
  ['eq 2021 (late UTC evening: 2022 in Kathmandu)', { eq: 2021 }, ['3105'], []],
  ['eq 2022', { eq: 2022 }, [], ['3105']],
  ['eq -1 (1 BC)', { eq: -1 }, ['3101'], ['3101']],
  ['eq -4714 (native minimum year)', { eq: -4714 }, ['3102'], ['3102']],
  ['lte -1 (BC only, never -infinity)', { lte: -1 }, ['3102', '3101'], ['3102', '3101']],
  ['eq 10000 (expanded; Kathmandu spillover from 9999)', { eq: 10000 }, ['3103'], ['3106', '3103']],
  ['eq 9999 (last ordinary boundary)', { eq: 9999 }, ['3106'], []],
  ['gte 9999 + lte 9999 (native form)', { gte: 9999, lte: 9999 }, ['3106'], []],
  ['eq 294276 (native maximum year)', { eq: 294276 }, ['3104'], []],
  ['eq 294277 (session spillover past the maximum)', { eq: 294277 }, [], ['3104']],
  ['gte 2026 (never +infinity)', { gte: 2026 }, ['3106', '3104', '3103'], ['3106', '3104', '3103']],
  [
    'the whole Int range (every finite year, no infinity, no null)',
    { gte: -2_147_483_648, lte: 2_147_483_647 },
    ['3106', '3105', '3104', '3103', '3102', '3101', '3025', '3024', '3023', '3020'],
    ['3106', '3105', '3104', '3103', '3102', '3101', '3025', '3024', '3023', '3020'],
  ],
  ['gte 2147483647', { gte: 2_147_483_647 }, [], []],
  ['lte -2147483648', { lte: -2_147_483_648 }, [], []],
  [
    'eq null beside gte 2025 (null is absent)',
    { eq: null, gte: 2025 },
    ['3106', '3104', '3103', '3025'],
    ['3106', '3104', '3103', '3025'],
  ],
];

/** Code-unit order (never locale collation, which may reorder punctuation). */
const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/**
 * Exactly one typed INVALID_INPUT error. Errors only: a nullable root such as
 * `judicialCase` keeps `data: { judicialCase: null }` beside its error.
 */
const isInvalid = (res: GqlResult): boolean =>
  res.errors?.length === 1 && res.errors[0]?.code === 'INVALID_INPUT';

// ── the suite ─────────────────────────────────────────────────────────────────

const describeA3 = CONFIGURED || REQUIRED ? describe : describe.skip;

describeA3('judicial A3 — actual DDL, explicit throwaway database', () => {
  let setup: pg.Client | undefined;
  let setupDb: ProdDb | undefined;
  const readers: Reader[] = [];

  const witness = async (text: string, params: readonly unknown[] = []): Promise<unknown> => {
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

  it('the straddling rows have the literal session years claimed (native extract per session TimeZone)', async () => {
    // The session TimeZone is set inside a rolled-back transaction: exactly the
    // conversion the readers use (an `at time zone` timestamp would overflow for
    // the spillover year 294277, which only exists as a session calendar year).
    const years = async (id: string, tz: string): Promise<unknown> => {
      await setup!.query('begin');
      try {
        await setup!.query(`select set_config('TimeZone', $1, true)`, [tz]);
        const r = await setup!.query<{ v: number }>(
          `select extract(year from source_opened_at)::integer as v
             from justice.cases where case_id = $1::bigint`,
          [id]
        );
        return r.rows[0]?.v;
      } finally {
        await setup!.query('rollback');
      }
    };
    for (const [id, utc, ktm] of [
      ['3101', -1, -1],
      ['3102', -4714, -4714],
      ['3103', 10000, 10000],
      ['3104', 294276, 294277],
      ['3105', 2021, 2022],
      ['3106', 9999, 10000],
    ] as const) {
      expect(await years(id, 'UTC'), `${id} UTC`).toBe(utc);
      expect(await years(id, 'Asia/Kathmandu'), `${id} Kathmandu`).toBe(ktm);
    }
    expect(
      await witness(`select count(*)::int as v from justice.cases where case_id in (3107, 3108)
        and not isfinite(source_opened_at)`)
    ).toBe(2);
  });

  it('the company fixture joins with duplicates and non-published controls (PostgreSQL witness)', async () => {
    const r = await setup!.query<{ status: string; rows: number; cases: number }>(
      `select pcc.validation_status as status, count(*)::int as rows,
              count(distinct c.case_id)::int as cases
         from justice.party_company_candidates pcc
         join justice.case_parties p on p.name_key_id = pcc.name_key_id
         join justice.cases c on c.case_id = p.case_id
        where pcc.candidate_cui = $1
        group by pcc.validation_status order by pcc.validation_status`,
      [CUI]
    );
    expect(r.rows).toEqual([
      { status: 'auto_accepted', rows: 1, cases: 1 },
      { status: 'candidate', rows: 1, cases: 1 },
      { status: 'needs_review', rows: 1, cases: 1 },
      { status: 'published', rows: 13, cases: 5 },
      { status: 'rejected', rows: 1, cases: 1 },
    ]);
  });

  // ── the company query (old-query witness, repair, traversal) ───────────────────

  it('the EXACT pre-A3 company SELECT fails with 42P10 on zero rows and on duplicates', async () => {
    for (const cui of ['NO_SUCH_CUI', CUI]) {
      await expect(setup!.query(OLD_COMPANY_LIST_SQL, ['published', cui, 3])).rejects.toMatchObject(
        { code: '42P10' }
      );
    }
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: the repaired list succeeds on zero rows and returns one case per published link',
    async (_name, index) => {
      const reader = readers[index]!;
      const empty = conn(
        await gql(reader, COMPANY_CASES_Q, { cui: 'RO999', first: 3 }),
        'judicialCompanyLitigationCases'
      );
      expect(empty).toEqual({ edges: [], pageInfo: { hasNextPage: false, endCursor: null } });
      const all = conn(
        await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, first: 50 }),
        'judicialCompanyLitigationCases'
      );
      expect(all.edges.map((e) => e.node)).toEqual(
        COMPANY_ORDER.map((id) => ({
          caseId: id,
          institutionCode: CO_COURT,
          caseNumber: `${id}/3/2024`,
          category: `A3CAT${id}`,
          sourceOpenedAt: COMPANY_DISPLAY[id],
        }))
      );
      for (const edge of all.edges) {
        expect(Object.keys(edge.node).sort()).toEqual(
          ['caseId', 'caseNumber', 'category', 'institutionCode', 'sourceOpenedAt'].sort()
        );
      }
      expect(all.pageInfo).toEqual({ hasNextPage: false, endCursor: all.edges.at(-1)?.cursor });
    }
  );

  const COMPANY_FHASH = `judicial_company_cases:${CUI}:{"courtLevels":[],"categories":[],"yearFrom":null,"yearTo":null}`;

  it.each(
    SESSIONS.flatMap((s, i) =>
      [1, 2, 3].map((size) => [`${s.name} size ${String(size)}`, i, size] as const)
    )
  )(
    '%s: every edge and end cursor resumes exactly (numeric DESC, no skip, no duplicate)',
    async (_l, index, size) => {
      const reader = readers[index]!;
      const identity = { sort: 'caseId', dir: 'desc', fhash: COMPANY_FHASH } as const;
      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = conn(
          await gql(reader, COMPANY_CASES_Q, {
            cui: `RO${CUI}`,
            first: size,
            ...(after !== undefined && { after }),
          }),
          'judicialCompanyLitigationCases'
        );
        for (const [i, edge] of page.edges.entries()) {
          const id = String(edge.node['caseId']);
          seen.push(id);
          expect(decodeCursor(edge.cursor, identity)._unsafeUnwrap().keys).toEqual([id]);
          // Following THIS edge cursor resumes at the very next case.
          const next = conn(
            await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, first: 1, after: edge.cursor }),
            'judicialCompanyLitigationCases'
          );
          const position = COMPANY_ORDER.indexOf(id as (typeof COMPANY_ORDER)[number]);
          expect(next.edges.map((e) => e.node['caseId'])).toEqual(
            position + 1 < COMPANY_ORDER.length ? [COMPANY_ORDER[position + 1]] : []
          );
          if (i === page.edges.length - 1) expect(page.pageInfo.endCursor).toBe(edge.cursor);
        }
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor ?? undefined;
      }
      expect(seen).toEqual([...COMPANY_ORDER]);
    }
  );

  it('a valid pre-A3 company token keeps its identity; a numeric tuple fails before SQL', async () => {
    const reader = readers[0]!;
    const token = buildNextCursor({
      sort: 'caseId',
      dir: 'desc',
      fhash: COMPANY_FHASH,
      lastKeys: ['100'],
    });
    const resumed = conn(
      await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, first: 5, after: token }),
      'judicialCompanyLitigationCases'
    );
    expect(resumed.edges.map((e) => e.node['caseId'])).toEqual(['10', '9']);
    const numeric = Buffer.from(
      `{"v":1,"sort":"caseId","dir":"desc","keys":[${ABOVE_2_53}],"fhash":${JSON.stringify(COMPANY_FHASH)}}`,
      'utf8'
    ).toString('base64url');
    expect(
      isInvalid(await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, first: 1, after: numeric }))
    ).toBe(true);
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: the summary keeps totals/levels, omits non-calendar years with a caveat; no status is promoted',
    async (_name, index) => {
      const reader = readers[index]!;
      const res = await gql(reader, COMPANY_Q, { cui: `RO${CUI}` });
      expect(res.errors).toBeUndefined();
      expect(res.data?.['judicialCompanyLitigation']).toEqual({
        cui: CUI,
        caseCount: 5,
        courtLevels: [{ courtLevel: 'tribunal', count: 5 }],
        years: [
          { year: -1, count: 1 },
          { year: 2023, count: 1 },
          { year: 2024, count: 1 },
        ],
        coverage: 1,
        caveats: [
          '2 published case(s) with a null or infinite sourceOpenedAt are counted in caseCount and courtLevels but omitted from years',
        ],
      });
      const out = await mcp(reader, 'get_company_litigation', { cui: `RO${CUI}` });
      expect(out).toMatchObject({ ok: true, item: { caseCount: 5 } });
      expect(JSON.stringify(out)).not.toContain('case_id_sort');
      expect(
        await witness(
          `select count(*)::int as v from justice.party_company_candidates where validation_status = 'published'`
        )
      ).toBe(4);
    }
  );

  it('company narrowing: finite years (BC included), nulls absent, empty lists do not narrow', async () => {
    const reader = readers[0]!;
    const ids = async (vars: Record<string, unknown>) =>
      conn(
        await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, first: 50, ...vars }),
        'judicialCompanyLitigationCases'
      ).edges.map((e) => e.node['caseId']);
    expect(await ids({ yearFrom: 2023 })).toEqual([ABOVE_2_53, '9']);
    expect(await ids({ yearTo: -1 })).toEqual(['4001']);
    expect(await ids({ yearFrom: 2025, yearTo: 2020 })).toEqual([]);
    expect(await ids({ courtLevel: null, category: null, yearFrom: null, yearTo: null })).toEqual([
      ...COMPANY_ORDER,
    ]);
    expect(await ids({ courtLevel: [], category: [] })).toEqual([...COMPANY_ORDER]);
    expect(await ids({ courtLevel: ['judecatorie'] })).toEqual([]);
    expect(isInvalid(await gql(reader, COMPANY_CASES_Q, { cui: `RO${CUI}`, yearFrom: 0 }))).toBe(
      true
    );
  });

  // ── year intervals over the full native domain ─────────────────────────────────

  it.each(
    SESSIONS.flatMap((s, i) =>
      YEAR_EXPECTATIONS.map(
        ([label, year, utc, ktm]) => [`${s.name}: ${label}`, i, year, i === 0 ? utc : ktm] as const
      )
    )
  )('%s', async (_label, index, year, expected) => {
    expect(await yearIds(readers[index]!, year)).toEqual([...expected]);
  });

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: the aggregate path agrees with the list path (intersection, contradiction, honest keys)',
    async (_name, index) => {
      const reader = readers[index]!;
      const byCourt = await gql(reader, CASELOAD_Q, {
        groupBy: 'court',
        filter: { ...YEAR_BOUND, year: { eq: 2024, gte: 2020 } },
      });
      expect(byCourt.data?.['judicialCaseload']).toEqual({
        groups: [{ key: YEAR_COURT, caseCount: 1 }],
        denominator: 1,
        coverage: 1,
      });
      const empty = await gql(reader, CASELOAD_Q, {
        groupBy: 'court',
        filter: { ...YEAR_BOUND, year: { eq: 2024, lte: 2023 } },
      });
      expect(empty.data?.['judicialCaseload']).toEqual({ groups: [], denominator: 0, coverage: 0 });
      const keys = await gql(reader, CASELOAD_Q, {
        groupBy: 'year',
        filter: { institutionCode: { in: [AGG_COURT] } },
      });
      expect(keys.errors).toBeUndefined();
      const agg = keys.data?.['judicialCaseload'] as {
        groups: { key: string; caseCount: number }[];
        denominator: number;
        coverage: number;
      };
      expect([...agg.groups].sort(byKey)).toEqual([
        { key: '(none)', caseCount: 1 },
        { key: '-infinity', caseCount: 1 },
        { key: '2023', caseCount: 1 },
        { key: '2024', caseCount: 2 },
        { key: 'infinity', caseCount: 1 },
      ]);
      expect(agg.denominator).toBe(6);
      expect(agg.coverage).toBeCloseTo(5 / 6, 12);
      const spill = await gql(reader, CASELOAD_Q, {
        groupBy: 'year',
        filter: { ...YEAR_BOUND, year: { gte: 9999 } },
      });
      const spillGroups = (
        spill.data?.['judicialCaseload'] as { groups: { key: string; caseCount: number }[] }
      ).groups;
      expect([...spillGroups].sort(byKey)).toEqual(
        index === 0
          ? [
              { key: '10000', caseCount: 1 },
              { key: '294276', caseCount: 1 },
              { key: '9999', caseCount: 1 },
            ]
          : [
              { key: '10000', caseCount: 2 },
              { key: '294277', caseCount: 1 },
            ]
      );
    }
  );

  it.each(
    SESSIONS.flatMap((s, i) =>
      [1, 2, 3].map((size) => [`${s.name} size ${String(size)}`, i, size] as const)
    )
  )(
    '%s: a year-filtered case list resumes exactly from every edge and end cursor',
    async (_l, index, size) => {
      const reader = readers[index]!;
      const year = { gte: -2_147_483_648, lte: 2_147_483_647 };
      const expected = [
        '3106',
        '3105',
        '3104',
        '3103',
        '3102',
        '3101',
        '3025',
        '3024',
        '3023',
        '3020',
      ];
      const identity = {
        sort: 'modifiedAt',
        dir: 'desc',
        fhash: `judicial_cases:cursor-v2:filters-a3:${fhashFor(judicialCasesSpec, { ...YEAR_BOUND, year })}`,
      } as const;
      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = conn(
          await gql(reader, LIST_Q, {
            filter: { ...YEAR_BOUND, year },
            first: size,
            ...(after !== undefined && { after }),
          }),
          'judicialCases'
        );
        for (const [i, edge] of page.edges.entries()) {
          const id = String(edge.node['caseId']);
          seen.push(id);
          expect(decodeCursor(edge.cursor, identity)._unsafeUnwrap().keys).toEqual(['', id]);
          const next = conn(
            await gql(reader, LIST_Q, {
              filter: { ...YEAR_BOUND, year },
              first: 1,
              after: edge.cursor,
            }),
            'judicialCases'
          );
          const position = expected.indexOf(id);
          expect(next.edges.map((e) => e.node['caseId'])).toEqual(
            position + 1 < expected.length ? [expected[position + 1]] : []
          );
          if (i === page.edges.length - 1) expect(page.pageInfo.endCursor).toBe(edge.cursor);
        }
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor ?? undefined;
      }
      expect(seen).toEqual(expected);
    }
  );

  it('a pre-A3 case token (cursor-v2 identity without the semantics version) gets the typed restart', async () => {
    const reader = readers[0]!;
    const filter = { ...YEAR_BOUND, year: { eq: 2024, gte: 2020 } };
    const preA3 = buildNextCursor({
      sort: 'modifiedAt',
      dir: 'desc',
      fhash: `judicial_cases:cursor-v2:${fhashFor(judicialCasesSpec, filter)}`,
      lastKeys: ['', '3024'],
    });
    expect(await gql(reader, LIST_Q, { filter, first: 1, after: preA3 })).toEqual({
      data: null,
      errors: [{ message: 'cursor/filter mismatch; restart pagination', code: 'INVALID_INPUT' }],
    });
  });

  // ── input validation on real readers ───────────────────────────────────────────

  it('invalid year operands and virtual values are INVALID_INPUT (old code: DB errors or silent empties)', async () => {
    const reader = readers[0]!;
    for (const filter of [
      { ...YEAR_BOUND, year: { eq: 0 } },
      { ...YEAR_BOUND, courtLevel: { in: ['iccj'] } },
      { courtLevel: { in: ['iccj'] } },
    ]) {
      expect(
        isInvalid(await gql(reader, LIST_Q, { filter, first: 2 })),
        JSON.stringify(filter)
      ).toBe(true);
    }
  });

  it('every real court level binds through the virtual join', async () => {
    const reader = readers[0]!;
    const ids = async (level: string, year?: Record<string, unknown>) =>
      conn(
        await gql(reader, LIST_Q, {
          filter: { courtLevel: { in: [level] }, ...(year !== undefined && { year }) },
          first: 50,
        }),
        'judicialCases'
      ).edges.map((e) => e.node['caseId']);
    expect(await ids('judecatorie')).toEqual(['3301']);
    expect(await ids('tribunal_militar')).toEqual(['3302']);
    expect(await ids('curte_de_apel')).toEqual(['3303']);
    expect(await ids('curte_militara_apel')).toEqual(['3304']);
    expect(await ids('inalta_curte')).toEqual(['3305']);
    expect(await ids('tribunal', { eq: 2020 })).toEqual(['3020']);
  });

  it('null optionals equal omission on GraphQL literals, variables, the MCP schema and the direct handler', async () => {
    const reader = readers[1]!;
    const plain = await yearIds(reader, { gte: 2025 });
    const literal = conn(
      await gql(
        reader,
        `{ judicialCases(filter: { institutionCode: { in: ["${YEAR_COURT}"] }, year: { gte: 2025, eq: null, between: null }, courtLevel: null, modified: { gte: null } }, first: 50) {
          edges { cursor node { caseId } } pageInfo { hasNextPage endCursor } } }`
      ),
      'judicialCases'
    ).edges.map((e) => String(e.node['caseId']));
    expect(literal).toEqual(plain);
    const variables = conn(
      await gql(reader, LIST_Q, {
        filter: { ...YEAR_BOUND, year: { gte: 2025, lte: null }, category: null, hasObject: null },
        first: 50,
      }),
      'judicialCases'
    ).edges.map((e) => String(e.node['caseId']));
    expect(variables).toEqual(plain);
    expect(plain).toEqual(['3106', '3104', '3103', '3025']);

    const base = { groupBy: 'court', institutionCode: [YEAR_COURT], yearFrom: 2025 };
    const omitted = await mcp(reader, 'get_court_caseload', base);
    const withNulls = { ...base, courtLevel: null, category: null, yearTo: null };
    expect(await mcp(reader, 'get_court_caseload', withNulls)).toEqual(omitted);
    expect(await tool(reader, 'get_court_caseload').handler(withNulls)).toEqual(omitted);
    expect(omitted).toMatchObject({ ok: true, item: { denominator: 4 } });

    for (const filter of [
      { year: { eq: null } },
      { modified: { between: {} } },
      { courtLevel: null },
    ]) {
      const res = await gql(reader, LIST_Q, { filter, first: 2 });
      expect(res.errors).toEqual([
        { message: 'judicial case list requires a court or period bound', code: 'INVALID_INPUT' },
      ]);
    }
    const nullMember = await tool(reader, 'get_court_caseload').handler({
      groupBy: 'court',
      institutionCode: [YEAR_COURT, null],
    });
    expect(nullMember).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
    });
  });

  it('discovery and groupBy are validated before any repo access; valid dims and limits 1/50 work', async () => {
    const reader = readers[0]!;
    for (const vars of [
      { dim: 'person', q: 'Ion Popescu' },
      { dim: 'court', q: LOCALITY, limit: 0 },
      { dim: 'court', q: LOCALITY, limit: 51 },
    ]) {
      const res = await gql(reader, RESOLVE_Q, vars);
      expect(isInvalid(res)).toBe(true);
      expect(JSON.stringify(res)).not.toContain('Ion');
    }
    const one = await gql(reader, RESOLVE_Q, { dim: 'court', q: LOCALITY, limit: 1 });
    expect(one.data?.['judicialResolve']).toEqual([{ kind: 'court', value: YEAR_COURT }]);
    const fifty = await gql(reader, RESOLVE_Q, { dim: 'court', q: LOCALITY, limit: 50 });
    expect((fifty.data?.['judicialResolve'] as unknown[]).length).toBe(7);
    const nullLimit = await gql(reader, RESOLVE_Q, { dim: 'court', q: LOCALITY, limit: null });
    expect((nullLimit.data?.['judicialResolve'] as unknown[]).length).toBe(7);
    const category = await gql(reader, RESOLVE_Q, { dim: 'category', q: 'A3CAT3020', limit: 5 });
    expect(category.data?.['judicialResolve']).toEqual([{ kind: 'category', value: 'A3CAT3020' }]);
    const direct = await tool(reader, 'resolve_judicial_filters').handler({
      dim: 'person',
      q: 'Ion',
    });
    expect(direct).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
    });
    expect(JSON.stringify(direct)).not.toContain('Ion');
    const groupBy = await tool(reader, 'get_court_caseload').handler({
      groupBy: 'party',
      institutionCode: [YEAR_COURT],
    });
    expect(groupBy).toMatchObject({
      ok: false,
      errorType: 'InvalidInput',
      errorCode: 'INVALID_INPUT',
    });
  });

  // ── r1: supplied malformed inputs never fall back or widen ─────────────────────

  it('an unsupported inline caseId literal beside a REAL natural key is INVALID_INPUT; null/omitted fall back', async () => {
    const reader = readers[0]!;
    const fallback = `institutionCode: "${CO_COURT}", caseNumber: "9/3/2024"`;
    for (const lit of ['true', '1.5', '1.0', '{}', '[]', 'SECRET_ENUM']) {
      const res = await gql(
        reader,
        `{ judicialCase(caseId: ${lit}, ${fallback}) { case { caseId } } }`
      );
      expect(res, lit).toEqual({
        data: null,
        errors: [
          { message: 'BigInt literal must be a string or an integer', code: 'INVALID_INPUT' },
        ],
      });
    }
    for (const arg of ['caseId: null, ', '']) {
      const res = await gql(reader, `{ judicialCase(${arg}${fallback}) { case { caseId } } }`);
      expect(res, arg).toEqual({
        data: { judicialCase: { case: { caseId: '9' } } },
        errors: undefined,
      });
    }
  });

  it('MCP: a supplied empty caseId beside a REAL natural key fails typed; null/omitted/0/009/max behave as before', async () => {
    const reader = readers[0]!;
    const fallback = { institutionCode: CO_COURT, caseNumber: '9/3/2024' };
    const t = tool(reader, 'get_judicial_case');
    for (const caseId of ['', ' ', '9223372036854775808']) {
      const args = { caseId, ...fallback };
      expect(kernelToolInputSchema(t).safeParse(args).success).toBe(true);
      expect(await t.handler(args), caseId).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
        errorCode: 'INVALID_INPUT',
      });
    }
    for (const args of [
      { caseId: null, ...fallback },
      { ...fallback },
      { caseId: '009', ...fallback },
    ]) {
      expect(await mcp(reader, 'get_judicial_case', args)).toMatchObject({
        ok: true,
        item: { case: { caseId: '9' } },
      });
    }
    for (const caseId of ['0', '9223372036854775807']) {
      const out = await mcp(reader, 'get_judicial_case', { caseId, ...fallback });
      expect(out, caseId).toMatchObject({ ok: true, summary: 'No matching case.' });
      expect(out.item).toBeUndefined();
    }
  });

  it('a malformed modified Date literal beside a real court bound is INVALID_INPUT (list and aggregate)', async () => {
    const reader = readers[1]!;
    const court = `institutionCode: { in: ["${YEAR_COURT}"] }`;
    for (const modified of [
      '{ gte: true }',
      '{ lte: 1.5 }',
      '{ between: { from: {} } }',
      '{ gte: [] }',
    ]) {
      for (const source of [
        `{ judicialCases(filter: { ${court}, modified: ${modified} }, first: 50) { edges { node { caseId } } } }`,
        `{ judicialCaseload(groupBy: court, filter: { ${court}, modified: ${modified} }) { denominator } }`,
      ]) {
        expect(await gql(reader, source), modified).toEqual({
          data: null,
          errors: [
            { message: 'Date literal must be a string or an integer', code: 'INVALID_INPUT' },
          ],
        });
      }
    }
    // Controls: null is absent (all 13 year-court cases, modified is null on every row);
    // a real date bound excludes rows whose modified time is null.
    const all = await gql(
      reader,
      `{ judicialCases(filter: { ${court}, modified: { gte: null } }, first: 50) { edges { node { caseId } } } }`
    );
    expect(conn(all, 'judicialCases').edges).toHaveLength(13);
    const bounded = await gql(
      reader,
      `{ judicialCases(filter: { ${court}, modified: { gte: "2024-01-01" } }, first: 50) { edges { node { caseId } } } }`
    );
    expect(conn(bounded, 'judicialCases').edges).toEqual([]);
  });

  // ── direct IDs ─────────────────────────────────────────────────────────────────

  it('direct case ids: overflow/negative/malformed are typed; 0/max/leading zeros/precision kept; absence is null', async () => {
    const reader = readers[0]!;
    for (const id of ['9223372036854775808', '-1', '1e3']) {
      const res = await gql(reader, DETAIL_Q, { id });
      expect(isInvalid(res), id).toBe(true);
      expect(res.data, id).toEqual({ judicialCase: null });
    }
    for (const [id, expected] of [
      ['0', null],
      ['9223372036854775807', null],
      ['009', { caseId: '9', caseNumber: '9/3/2024' }],
      ['10', { caseId: '10', caseNumber: '10/3/2024' }],
      ['100', { caseId: '100', caseNumber: '100/3/2024' }],
      [ABOVE_2_53, { caseId: ABOVE_2_53, caseNumber: `${ABOVE_2_53}/3/2024` }],
    ] as const) {
      const res = await gql(reader, DETAIL_Q, { id });
      expect(res.errors, id).toBeUndefined();
      expect(res.data?.['judicialCase'], id).toEqual(expected === null ? null : { case: expected });
    }
  });

  it('legal references by case and reverse references by act: typed guards, exact ids, preserved identity', async () => {
    const reader = readers[0]!;
    for (const caseId of ['9223372036854775808', '-1', 'abc']) {
      expect(await mcp(reader, 'get_case_legal_references', { caseId })).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
        errorCode: 'INVALID_INPUT',
      });
    }
    const refs = await mcp(reader, 'get_case_legal_references', { caseId: '009' });
    expect(
      (refs.items as { caseLegalReferenceId: string }[]).map((r) => r.caseLegalReferenceId)
    ).toEqual(['8001', '8002']);
    expect(isInvalid(await gql(reader, CITING_Q, { id: '9223372036854775808', first: 5 }))).toBe(
      true
    );
    const max = conn(
      await gql(reader, CITING_Q, { id: '9223372036854775807', first: 5 }),
      'judicialCasesCitingAct'
    );
    expect(max.edges.map((e) => e.node['caseId'])).toEqual(['9']);
    const seven = conn(
      await gql(reader, CITING_Q, { id: '0007', first: 1 }),
      'judicialCasesCitingAct'
    );
    expect(seven.edges.map((e) => e.node['caseId'])).toEqual([ABOVE_2_53]);
    expect(
      decodeCursor(seven.pageInfo.endCursor ?? '', {
        sort: 'refId',
        dir: 'desc',
        fhash: 'judicial_cases_citing:0007',
      })._unsafeUnwrap().keys
    ).toEqual(['8003']);
    const oldToken = buildNextCursor({
      sort: 'refId',
      dir: 'desc',
      fhash: 'judicial_cases_citing:7',
      lastKeys: ['8003'],
    });
    const resumed = conn(
      await gql(reader, CITING_Q, { id: '7', first: 5, after: oldToken }),
      'judicialCasesCitingAct'
    );
    expect(resumed.edges.map((e) => e.node['caseId'])).toEqual(['9']);
  });
});
