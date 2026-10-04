/**
 * Judicial A1 — real-DDL proof: exact citations, repo-owned cursors over the exact
 * timestamp tuple, and truthful temporal text for cases, children and `asOf`.
 *
 * TARGET GUARD. This suite touches ONLY an explicitly provided throwaway
 * database: `JUDICIAL_A1_TEST_PG_URL` + `JUDICIAL_A1_TEST_DB_NAME`, where the name
 * is `server_justice_a1_<run-id>`, the URL is a loopback endpoint whose database
 * path equals that name and which carries NO query parameters or fragment (pg
 * would let `?host=`/`?port=`/`?options=` override the authority),
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
 * and DateStyle; each pooled connection is verified before any module read. Two
 * sessions run the whole matrix: UTC/ISO and Pacific/Auckland with SQL,DMY.
 *
 * EXPECTATIONS are written independently: hand-ordered id arrays (cross-checked
 * against PostgreSQL's own ORDER BY), literal cursor keys and display strings,
 * and stored-value equality decided by PostgreSQL over the emitted text as typed
 * parameters. Only symbols that predate A1 are imported, so the suite also runs
 * against the original code (where it fails on wrong/missing pages, missing
 * citation fields, rebuilt tokens and JS Date failures).
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
const TARGET_URL = process.env['JUDICIAL_A1_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['JUDICIAL_A1_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const DB_NAME_RE = /^server_justice_a1_[a-z0-9_]{1,40}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validate an explicit target WITHOUT connecting and without ever echoing the URL
 * (it may carry credentials). Pure: the always-run guard block below calls it
 * with synthetic inputs; the suite's setup calls it before any connection.
 */
const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (targetUrl === '' || targetDb === '') {
    throw new Error(
      'A1 PG proof is REQUIRED (TEST_E2E_REQUIRED=1) but JUDICIAL_A1_TEST_PG_URL / JUDICIAL_A1_TEST_DB_NAME are unset'
    );
  }
  if (!DB_NAME_RE.test(targetDb)) {
    throw new Error('JUDICIAL_A1_TEST_DB_NAME must be server_justice_a1_<run-id>');
  }
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error('JUDICIAL_A1_TEST_PG_URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('JUDICIAL_A1_TEST_PG_URL must be a postgres URL');
  }
  // pg's connection-string parser lets query parameters (host, port, options,
  // ...) override the authority and startup behaviour, so NONE are accepted;
  // the readers add their own controlled `options` only after this guard.
  if (url.search !== '' || url.hash !== '') {
    throw new Error('JUDICIAL_A1_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('JUDICIAL_A1_TEST_PG_URL must be a loopback endpoint');
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error('JUDICIAL_A1_TEST_PG_URL database does not equal JUDICIAL_A1_TEST_DB_NAME');
  }
};

// ── target guard: always runs, never connects ───────────────────────────────────

describe('judicial A1 target guard (pure; no connection, no env)', () => {
  const NAME = 'server_justice_a1_guard';
  const AT = `postgres://a1@127.0.0.1:5432/${NAME}`;

  it.each([
    ['a host override', `${AT}?host=remote.example`, 'host', 'remote.example'],
    ['a port override', `${AT}?port=6543`, 'port', 6543],
  ] as const)('rejects %s that pg itself would honour', (_label, url, field, overridden) => {
    // The driver's own parsing (a Client is constructed, never connected)
    // proves the override is real, so the authority check alone is not enough.
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
      `postgres://a1@127.0.0.1/transparenta_prod`,
      'transparenta_prod',
      /server_justice_a1_<run-id>/u,
    ],
    ['a non-postgres URL', `mysql://a1@127.0.0.1/${NAME}`, NAME, /postgres URL/u],
    ['a non-loopback host', `postgres://a1@db.example:5432/${NAME}`, NAME, /loopback/u],
    [
      'a database-name mismatch',
      `postgres://a1@127.0.0.1/server_justice_a1_other`,
      NAME,
      /does not equal/u,
    ],
  ] as const)('rejects %s', (_label, url, name, message) => {
    expect(() => {
      assertThrowawayTarget(url, name);
    }).toThrow(message);
  });

  it.each([AT, `postgresql://a1@localhost/${NAME}`, `postgres://a1@[::1]:5432/${NAME}`])(
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

const ORD = 'TEST_A1_ORD';
const EXT = 'TEST_A1_EXT';
const REF = 'TEST_A1_REF';

interface CaseSeed {
  readonly id: string;
  readonly opened: string | null; // timestamptz input (explicit offset)
  readonly modified: string | null;
}

/** Ordinary values: microsecond ties/near-ties, offsets, numeric ids incl. > 2^53. */
const ORD_CASES: readonly CaseSeed[] = [
  { id: '9', opened: '2024-03-10 08:00:00.123456+00', modified: '2025-01-01 00:00:00.000001+00' },
  { id: '10', opened: '2024-03-10 08:00:00.123456+00', modified: '2025-01-01 00:00:00+00' },
  // same instant as 9/10, written with another offset
  { id: '100', opened: '2024-03-10 10:00:00.123456+02', modified: null },
  {
    id: '9007199254740992',
    opened: '2024-03-10 08:00:00.123457+00',
    modified: '2025-01-01 00:00:00.000001+00',
  },
  { id: '9007199254740993', opened: null, modified: '2024-12-31 18:59:59.999999-05' },
  { id: '11', opened: '2024-03-11 00:30:00+00', modified: '2025-06-01 12:00:00.5+00' },
  { id: '12', opened: '2023-12-31 23:59:59.999999+00', modified: null },
  { id: '13', opened: null, modified: '2025-06-01 12:00:00.500000+00' },
  { id: '101', opened: '2024-03-10 08:00:00.123+00', modified: '2025-01-01 00:00:00.000002+00' },
];

/** Exceptional stored values: the actual timestamp range ends, eras, expanded years, ±infinity. */
const EXT_CASES: readonly CaseSeed[] = [
  {
    id: '1001',
    opened: '4714-11-24 00:00:00+00 BC',
    modified: '294276-12-31 23:59:59.999999+00',
  },
  { id: '1002', opened: '0001-01-01 00:00:00+00', modified: '0001-12-31 23:59:59.999999+00 BC' },
  { id: '1003', opened: '9999-12-31 23:59:59.999999+00', modified: '10000-01-01 00:00:00+00' },
  { id: '1004', opened: 'infinity', modified: '-infinity' },
  { id: '1005', opened: '-infinity', modified: null },
  { id: '1006', opened: null, modified: '0001-01-01 00:00:00+00' },
  { id: '1007', opened: '0001-12-31 00:00:00+00 BC', modified: '9999-12-31 23:59:59.999999+00' },
  { id: '1008', opened: '2000-01-01 00:00:00+00', modified: 'infinity' },
];

const REF_CASES: readonly CaseSeed[] = [
  { id: '2001', opened: '2025-02-01 09:00:00+00', modified: '2025-03-01 00:00:00+00' },
  { id: '2002', opened: '2025-02-02 09:00:00+00', modified: null },
  { id: '2003', opened: '2025-02-03 09:00:00+00', modified: '2025-02-01 00:00:00+00' },
];

type Sort = 'openedAt' | 'modifiedAt';
type Dir = 'ASC' | 'DESC';

/** Hand-ordered expectations: NULLS LAST both ways, numeric id ties. */
const ORDER: Record<string, Record<Sort, Record<Dir, readonly string[]>>> = {
  [ORD]: {
    openedAt: {
      ASC: ['12', '101', '9', '10', '100', '9007199254740992', '11', '13', '9007199254740993'],
      DESC: ['11', '9007199254740992', '100', '10', '9', '101', '12', '9007199254740993', '13'],
    },
    modifiedAt: {
      ASC: ['9007199254740993', '10', '9', '9007199254740992', '101', '11', '13', '12', '100'],
      DESC: ['13', '11', '101', '9007199254740992', '9', '10', '9007199254740993', '100', '12'],
    },
  },
  [EXT]: {
    openedAt: {
      ASC: ['1005', '1001', '1007', '1002', '1008', '1003', '1004', '1006'],
      DESC: ['1004', '1003', '1008', '1002', '1007', '1001', '1005', '1006'],
    },
    modifiedAt: {
      ASC: ['1004', '1002', '1006', '1007', '1003', '1001', '1008', '1005'],
      DESC: ['1008', '1001', '1003', '1007', '1006', '1002', '1004', '1005'],
    },
  },
};

/** The exact cursor key each row must carry ('' = NULL), by sort. */
const KEY: Record<Sort, Readonly<Record<string, string>>> = {
  openedAt: {
    '9': '2024-03-10T08:00:00.123456+00 AD',
    '10': '2024-03-10T08:00:00.123456+00 AD',
    '100': '2024-03-10T08:00:00.123456+00 AD',
    '9007199254740992': '2024-03-10T08:00:00.123457+00 AD',
    '9007199254740993': '',
    '11': '2024-03-11T00:30:00.000000+00 AD',
    '12': '2023-12-31T23:59:59.999999+00 AD',
    '13': '',
    '101': '2024-03-10T08:00:00.123000+00 AD',
    '1001': '4714-11-24T00:00:00.000000+00 BC',
    '1002': '0001-01-01T00:00:00.000000+00 AD',
    '1003': '9999-12-31T23:59:59.999999+00 AD',
    '1004': 'infinity',
    '1005': '-infinity',
    '1006': '',
    '1007': '0001-12-31T00:00:00.000000+00 BC',
    '1008': '2000-01-01T00:00:00.000000+00 AD',
  },
  modifiedAt: {
    '9': '2025-01-01T00:00:00.000001+00 AD',
    '10': '2025-01-01T00:00:00.000000+00 AD',
    '100': '',
    '9007199254740992': '2025-01-01T00:00:00.000001+00 AD',
    '9007199254740993': '2024-12-31T23:59:59.999999+00 AD',
    '11': '2025-06-01T12:00:00.500000+00 AD',
    '12': '',
    '13': '2025-06-01T12:00:00.500000+00 AD',
    '101': '2025-01-01T00:00:00.000002+00 AD',
    '1001': '294276-12-31T23:59:59.999999+00 AD',
    '1002': '0001-12-31T23:59:59.999999+00 BC',
    '1003': '10000-01-01T00:00:00.000000+00 AD',
    '1004': '-infinity',
    '1005': '',
    '1006': '0001-01-01T00:00:00.000000+00 AD',
    '1007': '9999-12-31T23:59:59.999999+00 AD',
    '1008': 'infinity',
  },
};

/** `latestSourceModifiedAt` display (UTC, session-independent). */
const MODIFIED_DISPLAY: Readonly<Record<string, string | null>> = {
  '9': '2025-01-01T00:00:00.000Z',
  '10': '2025-01-01T00:00:00.000Z',
  '100': null,
  '9007199254740992': '2025-01-01T00:00:00.000Z',
  '9007199254740993': '2024-12-31T23:59:59.999Z',
  '11': '2025-06-01T12:00:00.500Z',
  '12': null,
  '13': '2025-06-01T12:00:00.500Z',
  '101': '2025-01-01T00:00:00.000Z',
  '1001': '294276-12-31T23:59:59.999999+00 AD',
  '1002': '0001-12-31T23:59:59.999999+00 BC',
  '1003': '10000-01-01T00:00:00.000000+00 AD',
  '1004': '-infinity',
  '1005': null,
  '1006': '0001-01-01T00:00:00.000Z',
  '1007': '9999-12-31T23:59:59.999Z',
  '1008': 'infinity',
};

/** `sourceOpenedAt` display — the declared SESSION-date semantics, per session. */
const OPENED_UTC: Readonly<Record<string, string | null>> = {
  '9': '2024-03-10',
  '10': '2024-03-10',
  '100': '2024-03-10',
  '9007199254740992': '2024-03-10',
  '9007199254740993': null,
  '11': '2024-03-11',
  '12': '2023-12-31',
  '13': null,
  '101': '2024-03-10',
  '1001': '4714-11-24 BC',
  '1002': '0001-01-01',
  '1003': '9999-12-31',
  '1004': 'infinity',
  '1005': '-infinity',
  '1006': null,
  '1007': '0001-12-31 BC',
  '1008': '2000-01-01',
};
/** Pacific/Auckland: +13 (NZDT) on these modern summer dates; LMT +11:39:04 for ancient ones. */
const OPENED_AUCKLAND: Readonly<Record<string, string | null>> = {
  ...OPENED_UTC,
  '12': '2024-01-01', // 2023-12-31 23:59:59.999999Z is already 1 January in Auckland
  '1003': '10000-01-01 AD', // 9999-12-31 23:59:59.999999Z is year 10000 in Auckland
};

interface ChildSeed {
  readonly index: number;
  readonly at: string | null; // hearing_at (timestamptz input)
  readonly atDisplay: string | null;
  /** true: the display must cast back EXACTLY; false: equals the ms-truncated instant. */
  readonly atExact: boolean;
  readonly pronouncement: string | null; // date input
  readonly pronouncementDisplay: string | null;
  readonly document: string | null;
  readonly documentDisplay: string | null;
}

/** Case 2003's hearings — every temporal shape on every one of the three date columns. */
const HEARINGS_2003: readonly ChildSeed[] = [
  {
    index: 0,
    at: '2026-05-04 15:15:00.123456+02',
    atDisplay: '2026-05-04T13:15:00.123Z',
    atExact: false,
    pronouncement: '2026-05-04',
    pronouncementDisplay: '2026-05-04',
    document: '5874897-12-31',
    documentDisplay: '5874897-12-31 AD',
  },
  {
    index: 1,
    at: '0001-01-01 00:00:00+00',
    atDisplay: '0001-01-01T00:00:00.000Z',
    atExact: false,
    pronouncement: '0001-01-01',
    pronouncementDisplay: '0001-01-01',
    document: '0001-12-31 BC',
    documentDisplay: '0001-12-31 BC',
  },
  {
    index: 2,
    at: '9999-12-31 23:59:59.999999+00',
    atDisplay: '9999-12-31T23:59:59.999Z',
    atExact: false,
    pronouncement: '9999-12-31',
    pronouncementDisplay: '9999-12-31',
    document: '10000-01-01',
    documentDisplay: '10000-01-01 AD',
  },
  {
    index: 3,
    at: '0001-12-31 23:59:59.123456+00 BC',
    atDisplay: '0001-12-31T23:59:59.123456+00 BC',
    atExact: true,
    pronouncement: '0001-12-31 BC',
    pronouncementDisplay: '0001-12-31 BC',
    document: 'infinity',
    documentDisplay: 'infinity',
  },
  {
    index: 4,
    at: '10000-01-01 00:00:00.123456+00',
    atDisplay: '10000-01-01T00:00:00.123456+00 AD',
    atExact: true,
    pronouncement: 'infinity',
    pronouncementDisplay: 'infinity',
    document: '-infinity',
    documentDisplay: '-infinity',
  },
  {
    index: 5,
    at: 'infinity',
    atDisplay: 'infinity',
    atExact: true,
    pronouncement: '-infinity',
    pronouncementDisplay: '-infinity',
    document: null,
    documentDisplay: null,
  },
  {
    index: 6,
    at: '-infinity',
    atDisplay: '-infinity',
    atExact: true,
    pronouncement: null,
    pronouncementDisplay: null,
    document: '0044-03-15 BC',
    documentDisplay: '0044-03-15 BC',
  },
  {
    index: 7,
    at: null,
    atDisplay: null,
    atExact: true,
    pronouncement: '5874897-12-31',
    pronouncementDisplay: '5874897-12-31 AD',
    document: '0001-01-01',
    documentDisplay: '0001-01-01',
  },
];

/** Case 2003's appeals: the third native-date column, same shapes. */
const APPEALS_2003: readonly { index: number; declared: string | null; display: string | null }[] =
  [
    { index: 0, declared: '2026-06-01', display: '2026-06-01' },
    { index: 1, declared: '5874897-12-31', display: '5874897-12-31 AD' },
    { index: 2, declared: '0001-12-31 BC', display: '0001-12-31 BC' },
    { index: 3, declared: 'infinity', display: 'infinity' },
    { index: 4, declared: '-infinity', display: '-infinity' },
    { index: 5, declared: null, display: null },
    { index: 6, declared: '10000-01-01', display: '10000-01-01 AD' },
    { index: 7, declared: '0001-01-01', display: '0001-01-01' },
  ];

/** Legal references. 704 is the excluded source field; 706 repeats 701's token on another hearing. */
const REFS = [
  {
    id: '700',
    caseId: '2001',
    sourceField: 'object',
    hearingIndex: null,
    citation: 'Legea nr. 31/1990',
    actType: 'lege',
    actNumber: '31',
    actYear: 1990,
    targetActId: '42',
    resolutionStatus: 'unique',
    confidenceScore: '0.950',
    articleFragment: null,
    span: [0, 17],
  },
  {
    id: '701',
    caseId: '2001',
    sourceField: 'solution',
    hearingIndex: 0,
    citation: 'legea nr. 31/1990',
    actType: 'lege',
    actNumber: '31',
    actYear: 1990,
    targetActId: '42',
    resolutionStatus: 'unique',
    confidenceScore: '0.900',
    articleFragment: null,
    span: [5, 22],
  },
  {
    id: '702',
    caseId: '2002',
    sourceField: 'object',
    hearingIndex: null,
    citation: 'Legea 31/1990',
    actType: 'lege',
    actNumber: '31',
    actYear: 1990,
    targetActId: '42',
    resolutionStatus: 'unique',
    confidenceScore: null,
    articleFragment: null,
    span: [0, 13],
  },
  {
    id: '703',
    caseId: '2002',
    sourceField: 'object',
    hearingIndex: null,
    citation: 'Legea nr. 7/2010',
    actType: 'lege',
    actNumber: '7',
    actYear: 2010,
    targetActId: '43',
    resolutionStatus: 'unique',
    confidenceScore: '0.990',
    articleFragment: null,
    span: [20, 36],
  },
  {
    id: '704',
    caseId: '2001',
    sourceField: 'solution_summary',
    hearingIndex: 1,
    citation: 'legea nr. 31/1990',
    actType: 'lege',
    actNumber: '31',
    actYear: 1990,
    targetActId: '42',
    resolutionStatus: 'unique',
    confidenceScore: '0.900',
    articleFragment: null,
    span: [5, 22],
  },
  {
    id: '705',
    caseId: '2001',
    sourceField: 'object',
    hearingIndex: null,
    citation: 'art.336 ncp',
    actType: null,
    actNumber: null,
    actYear: null,
    targetActId: null,
    resolutionStatus: 'unresolved',
    confidenceScore: null,
    articleFragment: 'art. 336',
    span: [40, 51],
  },
  {
    id: '706',
    caseId: '2001',
    sourceField: 'solution',
    hearingIndex: 1,
    citation: 'legea nr. 31/1990',
    actType: 'lege',
    actNumber: '31',
    actYear: 1990,
    targetActId: null,
    resolutionStatus: 'ambiguous',
    confidenceScore: '0.500',
    articleFragment: null,
    span: [5, 22],
  },
] as const;

const refView = (id: string) => {
  const r = REFS.find((x) => x.id === id);
  if (r === undefined) throw new Error(`ref ${id}`);
  return {
    caseLegalReferenceId: r.id,
    caseId: r.caseId,
    sourceField: r.sourceField,
    hearingIndex: r.hearingIndex,
    actType: r.actType,
    actNumber: r.actNumber,
    actYear: r.actYear,
    issuerSlug: null,
    articleFragment: r.articleFragment,
    targetActId: r.targetActId,
    resolutionStatus: r.resolutionStatus,
    confidenceScore: r.confidenceScore,
    citation: r.citation,
  };
};
/** Case 2001's served references: id order, 704 (solution_summary) excluded, no dedup. */
const DETAIL_REFS_2001 = ['700', '701', '705', '706'].map(refView);
/** Reverse list for act 42: reference rows DESC, 704 excluded, repeated case kept. */
const CITING_42 = ['702', '701', '700'] as const;
const CITING_CASE: Readonly<Record<string, string>> = {
  '702': '2002',
  '701': '2001',
  '700': '2001',
};

const seed = async (client: pg.Client, cases: readonly CaseSeed[], court: string) => {
  for (const c of cases) {
    await client.query(
      `insert into justice.cases (case_id, institution_code, case_number, source_opened_at, latest_source_modified_at)
       values ($1::bigint, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [c.id, court, `${c.id}/3/2026`, c.opened, c.modified]
    );
  }
};

const seedBase = async (client: pg.Client): Promise<void> => {
  for (const [code, ordinal] of [
    [ORD, 9001],
    [EXT, 9002],
    [REF, 9003],
  ] as const) {
    await client.query(
      `insert into justice.courts (institution_code, ordinal, court_level, locality)
       values ($1, $2, 'tribunal', 'A1')`,
      [code, ordinal]
    );
  }
  await seed(client, ORD_CASES, ORD);
  await seed(client, REF_CASES, REF);
  // Case 2001: two ordinary hearings (the citation anchors); 2003: every temporal shape.
  for (const index of [0, 1]) {
    await client.query(
      `insert into justice.case_hearings (case_id, hearing_index, hearing_at, panel,
         pronouncement_date, document_number, document_date, row_hash)
       values (2001, $1, '2025-02-10 10:00:00+00', 'C1', '2025-02-10', $2, '2025-02-11', 'h')`,
      [index, `D${String(index)}`]
    );
  }
  for (const h of HEARINGS_2003) {
    await client.query(
      `insert into justice.case_hearings (case_id, hearing_index, hearing_at, panel,
         pronouncement_date, document_number, document_date, row_hash)
       values (2003, $1, $2::timestamptz, 'C1', $3::date, $4, $5::date, 'h')`,
      [h.index, h.at, h.pronouncement, `D${String(h.index)}`, h.document]
    );
  }
  for (const a of APPEALS_2003) {
    await client.query(
      `insert into justice.case_appeals (case_id, appeal_index, appeal_declared_at, appeal_type, row_hash)
       values (2003, $1, $2::date, 'apel', 'h')`,
      [a.index, a.declared]
    );
  }
  for (const r of REFS) {
    await client.query(
      `insert into justice.case_legal_references (case_legal_reference_id, case_id, source_field,
         raw_text, span_start, span_end, act_type, act_number, act_year, article_fragment,
         target_act_id, resolution_status, confidence_score, resolver_version, hearing_index)
       overriding system value
       values ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12,
               $13::numeric, 'test-a1', $14)`,
      [
        r.id,
        r.caseId,
        r.sourceField,
        r.citation,
        r.span[0],
        r.span[1],
        r.actType,
        r.actNumber,
        r.actYear,
        r.articleFragment,
        r.targetActId,
        r.resolutionStatus,
        r.confidenceScore,
        r.hearingIndex,
      ]
    );
  }
};

// ── readers and the real module ─────────────────────────────────────────────────

interface Session {
  readonly name: string;
  readonly timeZone: string;
  readonly dateStyle: string;
  readonly expectedDateStyle: string;
  readonly opened: Readonly<Record<string, string | null>>;
}

const SESSIONS: readonly Session[] = [
  {
    name: 'UTC/ISO',
    timeZone: 'UTC',
    dateStyle: 'ISO,MDY',
    expectedDateStyle: 'ISO, MDY',
    opened: OPENED_UTC,
  },
  {
    name: 'Pacific/Auckland SQL,DMY',
    timeZone: 'Pacific/Auckland',
    dateStyle: 'SQL,DMY',
    expectedDateStyle: 'SQL, DMY',
    opened: OPENED_AUCKLAND,
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

// ── traversal helpers ────────────────────────────────────────────────────────

const LIST_QUERY = `query ($filter: JudicialCasesFilter, $first: Int, $after: String, $sort: JudicialCaseSort, $dir: JudicialSortDir) {
  judicialCases(filter: $filter, first: $first, after: $after, sort: $sort, dir: $dir) {
    edges { cursor node { caseId sourceOpenedAt latestSourceModifiedAt } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CITING_QUERY = `query ($first: Int, $after: String) {
  judicialCasesCitingAct(targetActId: "42", first: $first, after: $after) {
    edges { cursor node { caseId institutionCode caseNumber actType actNumber actYear } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface Edge {
  readonly cursor: string;
  readonly node: Record<string, unknown>;
}
interface Page {
  readonly edges: readonly Edge[];
  readonly pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

type Fetch = (first: number, after: string | undefined) => Promise<Page>;

const listFetch =
  (reader: Reader, court: string, sort: Sort, dir: Dir): Fetch =>
  async (first, after) => {
    const res = await gql(reader, LIST_QUERY, {
      filter: { institutionCode: { in: [court] } },
      first,
      sort,
      dir,
      ...(after !== undefined && { after }),
    });
    expect(res.errors).toBeUndefined();
    return res.data?.['judicialCases'] as Page;
  };

const citingFetch =
  (reader: Reader): Fetch =>
  async (first, after) => {
    const res = await gql(reader, CITING_QUERY, { first, ...(after !== undefined && { after }) });
    expect(res.errors).toBeUndefined();
    return res.data?.['judicialCasesCitingAct'] as Page;
  };

const idOf = (edge: Edge): string => String(edge.node['caseId']);

/**
 * Follow endCursor from `after` to the end, checking every page's pageInfo.
 * Capped: lossy cursors (the pre-A1 code) can repeat rows forever.
 */
const traverse = async (
  fetch: Fetch,
  first: number,
  after: string | undefined,
  expectedCount: number
): Promise<{ edges: Edge[]; pages: number }> => {
  const edges: Edge[] = [];
  let cursor = after;
  for (let pages = 1; pages <= expectedCount + 2; pages += 1) {
    const page = await fetch(first, cursor);
    const last = page.edges[page.edges.length - 1];
    expect(page.pageInfo.endCursor).toBe(last?.cursor ?? null);
    edges.push(...page.edges);
    if (!page.pageInfo.hasNextPage) return { edges, pages };
    expect(page.edges).toHaveLength(first);
    cursor = page.pageInfo.endCursor ?? undefined;
  }
  throw new Error(`traversal did not terminate (${String(edges.length)} rows collected)`);
};

/** Full traversal + every edge's suffix + the empty page after the last row. */
const checkTraversal = async (
  fetch: Fetch,
  expected: readonly string[],
  ids: (edge: Edge) => string
): Promise<Edge[]> => {
  let firstEdges: Edge[] = [];
  for (const size of [1, 2, 3]) {
    const full = await traverse(fetch, size, undefined, expected.length);
    expect(full.edges.map(ids)).toEqual([...expected]);
    expect(full.pages).toBe(Math.max(1, Math.ceil(expected.length / size)));
    expect(new Set(full.edges.map((e) => e.cursor)).size).toBe(expected.length);
    for (const [i, edge] of full.edges.entries()) {
      const suffix = await traverse(fetch, size, edge.cursor, expected.length);
      expect(suffix.edges.map(ids), `size ${String(size)} after edge ${String(i)}`).toEqual(
        expected.slice(i + 1)
      );
      if (i === full.edges.length - 1) {
        expect(await fetch(size, edge.cursor)).toEqual({
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        });
      }
    }
    if (size === 1) firstEdges = full.edges;
  }
  return firstEdges;
};

/** The one exact codec, written out independently for the PostgreSQL witnesses. */
const EXACT_CODEC = (expr: string): string =>
  `case when ${expr} is null then null when isfinite(${expr}) then to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00' || to_char(${expr} at time zone 'UTC', ' BC') else ${expr}::text end`;

// ── the suite ─────────────────────────────────────────────────────────────────

const describeA1 = CONFIGURED || REQUIRED ? describe : describe.skip;

describeA1('judicial A1 — actual DDL, explicit throwaway database', () => {
  let setup: pg.Client | undefined;
  let setupDb: ProdDb | undefined;
  const readers: Reader[] = [];
  const v2Fhash = (court: string): string =>
    `judicial_cases:cursor-v2:${fhashFor(judicialCasesSpec, { institutionCode: { in: [court] } })}`;

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
    await seedBase(setup);

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

  /** Fixture self-check: the hand-ordered arrays equal PostgreSQL's own ORDER BY. */
  const checkFixtureOrdering = async (court: string): Promise<void> => {
    for (const [sort, col] of [
      ['openedAt', 'source_opened_at'],
      ['modifiedAt', 'latest_source_modified_at'],
    ] as const) {
      for (const dir of ['ASC', 'DESC'] as const) {
        const r = await setup!.query<{ id: string }>(
          `select case_id::text as id from justice.cases where institution_code = $1
           order by ${col} ${dir} nulls last, case_id ${dir}`,
          [court]
        );
        expect(
          r.rows.map((x) => x.id),
          `${court} ${sort} ${dir}`
        ).toEqual([...(ORDER[court]?.[sort][dir] ?? [])]);
      }
    }
  };

  it('the hand-ordered expectations equal PostgreSQL native ordering (ordinary court self-check)', async () => {
    await checkFixtureOrdering(ORD);
  });

  // ── citations ────────────────────────────────────────────────────────────────

  it('case detail (GraphQL + both MCP tools) serves the exact stored tokens, fields and anchors', async () => {
    const reader = readers[0]!;
    const res = await gql(
      reader,
      `{ judicialCase(caseId: "2001") { legalReferences {
          caseLegalReferenceId caseId sourceField hearingIndex actType actNumber actYear issuerSlug
          articleFragment targetActId resolutionStatus confidenceScore citation } } }`
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ judicialCase: { legalReferences: DETAIL_REFS_2001 } });

    const detail = await mcp(reader, 'get_judicial_case', { caseId: '2001' });
    expect(detail.ok).toBe(true);
    expect((detail.item as { legalReferences: unknown }).legalReferences).toEqual(DETAIL_REFS_2001);
    const refs = await mcp(reader, 'get_case_legal_references', { caseId: '2001' });
    expect(refs.ok).toBe(true);
    expect(refs.items).toEqual(DETAIL_REFS_2001);
    expect(refs.summary).toBe('Case 2001 has 4 legal citation(s) (2 uniquely resolved).');
    for (const payload of [detail, refs]) {
      const serialized = JSON.stringify(payload);
      for (const leaked of ['"cursor"', '"node"', '"sort_key"', '"edges"']) {
        expect(serialized).not.toContain(leaked);
      }
    }
    // Stored-token equality, decided by PostgreSQL for each served row.
    for (const ref of DETAIL_REFS_2001) {
      expect(
        await witness(
          'select raw_text = $1 and source_field = $2 and hearing_index is not distinct from $3::integer as v from justice.case_legal_references where case_legal_reference_id = $4::bigint',
          [ref.citation, ref.sourceField, ref.hearingIndex, ref.caseLegalReferenceId]
        )
      ).toBe(true);
    }
  });

  /** Reverse edges identify reference rows by their decoded cursor key. */
  const idOfRef = (edge: Edge): string => {
    const decoded = decodeCursor(edge.cursor, {
      sort: 'refId',
      dir: 'desc',
      fhash: 'judicial_cases_citing:42',
    });
    return decoded.isOk() ? (decoded.value.keys[0] ?? '?') : `undecodable:${idOf(edge)}`;
  };

  it('reverse citations keep reference-row grain: every edge, every suffix, final and empty pages', async () => {
    for (const reader of readers) {
      const first = await checkTraversal(citingFetch(reader), CITING_42, idOfRef);
      expect(first.map((e) => idOf(e))).toEqual(CITING_42.map((id) => CITING_CASE[id]));
      // Repeated case 2001 → two different cursors (reference ids 701, 700).
      expect(first[1]?.cursor).not.toBe(first[2]?.cursor);
    }
    // A pre-A1 valid END cursor (reference id) is still accepted; a pre-A1 per-edge
    // caseId cursor is rejected before SQL.
    const legacyEnd = buildNextCursor({
      sort: 'refId',
      dir: 'desc',
      fhash: 'judicial_cases_citing:42',
      lastKeys: ['701'],
    });
    const after = await citingFetch(readers[0]!)(3, legacyEnd);
    expect(after.edges.map(idOf)).toEqual(['2001']);
    const legacyEdge = buildNextCursor({
      sort: 'caseId',
      dir: 'desc',
      fhash: 'judicial_cases_citing:42',
      lastKeys: ['2001'],
    });
    const rejected = await gql(readers[0]!, CITING_QUERY, { first: 2, after: legacyEdge });
    expect(rejected.errors?.[0]?.code).toBe('INVALID_INPUT');
  });

  // ── ordinary case-list traversal (both sessions) ──────────────────────────────

  const traversalMatrix = (court: string) =>
    SESSIONS.flatMap((session, readerIndex) =>
      (['openedAt', 'modifiedAt'] as const).flatMap((sort) =>
        (['ASC', 'DESC'] as const).map(
          (dir) => [session.name, sort, dir, readerIndex] as [string, Sort, Dir, number]
        )
      )
    ).map(
      ([name, sort, dir, readerIndex]) =>
        [`${name} ${court} ${sort} ${dir}`, court, sort, dir, readerIndex] as const
    );

  const checkCaseList = async (court: string, sort: Sort, dir: Dir, readerIndex: number) => {
    const reader = readers[readerIndex]!;
    const expected = ORDER[court]?.[sort][dir] ?? [];
    const edges = await checkTraversal(listFetch(reader, court, sort, dir), expected, idOf);
    const identity = { sort, dir: dir === 'ASC' ? 'asc' : 'desc', fhash: v2Fhash(court) } as const;
    for (const edge of edges) {
      const id = idOf(edge);
      // The cursor carries the exact tuple; PostgreSQL proves it is the stored value.
      const keys = decodeCursor(edge.cursor, identity)._unsafeUnwrap().keys;
      expect(keys).toEqual([KEY[sort][id], id]);
      // (Branch in JS: a CASE could still fold ''::timestamptz at plan time.)
      const col = sort === 'openedAt' ? 'source_opened_at' : 'latest_source_modified_at';
      expect(
        keys[0] === ''
          ? await witness(
              `select ${col} is null as v from justice.cases where case_id = $1::bigint`,
              [id]
            )
          : await witness(
              `select ($1::timestamptz is not distinct from ${col}) as v from justice.cases where case_id = $2::bigint`,
              [keys[0], id]
            )
      ).toBe(true);
      // Display: UTC modified (session-independent) and the session-date opened.
      expect(edge.node).toEqual({
        caseId: id,
        sourceOpenedAt: reader.session.opened[id],
        latestSourceModifiedAt: MODIFIED_DISPLAY[id],
      });
    }
    // Cursor bytes are identical across sessions.
    if (readerIndex > 0) {
      const base = await traverse(
        listFetch(readers[0]!, court, sort, dir),
        1,
        undefined,
        edges.length
      );
      expect(edges.map((e) => e.cursor)).toEqual(base.edges.map((e) => e.cursor));
    }
  };

  it.each(traversalMatrix(ORD))(
    '%s: every edge and end cursor follows the exact tuple',
    async (_label, court, sort, dir, readerIndex) => {
      await checkCaseList(court, sort, dir, readerIndex);
    },
    60_000
  );

  it('the cursor validator agrees with PostgreSQL on every boundary spelling (accept ⇔ valid AND canonical)', async () => {
    const reader = readers[0]!;
    const candidates = [
      '4714-11-23T23:59:59.999999+00 BC',
      '4714-11-24T00:00:00.000000+00 BC',
      '4714-11-24T00:00:00.000001+00 BC',
      '4715-01-01T00:00:00.000000+00 BC',
      '294276-12-31T23:59:59.999999+00 AD',
      '294277-01-01T00:00:00.000000+00 AD',
      '0000-01-01T00:00:00.000000+00 AD',
      '0001-02-29T00:00:00.000000+00 BC',
      '0001-02-29T00:00:00.000000+00 AD',
      '0004-02-29T00:00:00.000000+00 AD',
      '0005-02-29T00:00:00.000000+00 BC',
      '0101-02-29T00:00:00.000000+00 BC',
      '0401-02-29T00:00:00.000000+00 BC',
      '1900-02-29T00:00:00.000000+00 AD',
      '2000-02-29T00:00:00.000000+00 AD',
      '2023-02-29T00:00:00.000000+00 AD',
      '2024-04-31T00:00:00.000000+00 AD',
      '2024-01-01T24:00:00.000000+00 AD',
      '2024-01-01T23:59:60.000000+00 AD',
      '2024-01-01T00:00:00.12345+00 AD',
      '2024-01-01T00:00:00.000000+01 AD',
      '2024-01-01T00:00:00.000000+00',
      '2024-01-01T00:00:00.000000Z',
      '10000-01-01T00:00:00.000000+00 AD',
      '010000-01-01T00:00:00.000000+00 AD',
      '2026-05-04 13:15:00.123456+00 AD',
      '2026-05-04T13:15:00.123Z',
      'infinity',
      '-infinity',
      'Infinity',
      'epoch',
      'now',
    ];
    const fhash = v2Fhash(ORD);
    for (const text of candidates) {
      const admitted = (await witness(
        `select pg_input_is_valid($1, 'timestamp with time zone') as v`,
        [text]
      )) as boolean;
      const canonical = admitted
        ? await witness(`select ${EXACT_CODEC('$1::timestamptz')} as v`, [text])
        : null;
      const shouldAccept = admitted && canonical === text;
      const after = buildNextCursor({
        sort: 'modifiedAt',
        dir: 'desc',
        fhash,
        lastKeys: [text, '1'],
      });
      const res = await gql(reader, LIST_QUERY, {
        filter: { institutionCode: { in: [ORD] } },
        first: 1,
        after,
      });
      expect(res.errors === undefined, `${text}: accept=${String(shouldAccept)}`).toBe(
        shouldAccept
      );
      if (!shouldAccept) expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
    }
    for (const id of [
      '0',
      '9223372036854775807',
      '9223372036854775808',
      '-9223372036854775808',
      '-9223372036854775809',
      '-0',
      '007',
      '1e3',
    ]) {
      const admitted = (await witness(`select pg_input_is_valid($1, 'bigint') as v`, [
        id,
      ])) as boolean;
      const canonical = admitted ? await witness('select $1::bigint::text as v', [id]) : null;
      const shouldAccept = admitted && canonical === id;
      const after = buildNextCursor({
        sort: 'modifiedAt',
        dir: 'desc',
        fhash,
        lastKeys: ['2025-01-01T00:00:00.000000+00 AD', id],
      });
      const res = await gql(reader, LIST_QUERY, {
        filter: { institutionCode: { in: [ORD] } },
        first: 1,
        after,
      });
      expect(res.errors === undefined, `id ${id}: accept=${String(shouldAccept)}`).toBe(
        shouldAccept
      );
    }
    // Pre-A1 case-list tokens (original identity, lossy keys) restart.
    for (const sort of ['openedAt', 'modifiedAt'] as const) {
      const legacy = buildNextCursor({
        sort,
        dir: 'desc',
        fhash: fhashFor(judicialCasesSpec, { institutionCode: { in: [ORD] } }),
        lastKeys: [sort === 'openedAt' ? '2024-03-10' : '2025-01-01T00:00:00.000Z', '9'],
      });
      const res = await gql(reader, LIST_QUERY, {
        filter: { institutionCode: { in: [ORD] } },
        first: 1,
        sort,
        after: legacy,
      });
      expect(res.errors?.[0]?.code).toBe('INVALID_INPUT');
      expect(res.errors?.[0]?.message).toMatch(/restart pagination/u);
    }
  });

  // ── children + detail temporal text (both sessions) ───────────────────────────

  const DETAIL_2003 = `{ judicialCase(caseId: "2003") {
    case { caseId sourceOpenedAt latestSourceModifiedAt }
    hearings { hearingIndex hearingAt pronouncementDate documentDate }
    appeals { appealIndex appealDeclaredAt }
    asOf { asOf estimated } } }`;

  const expectedHearings = HEARINGS_2003.map((h) => ({
    hearingIndex: h.index,
    hearingAt: h.atDisplay,
    pronouncementDate: h.pronouncementDisplay,
    documentDate: h.documentDisplay,
  }));
  const expectedAppeals = APPEALS_2003.map((a) => ({
    appealIndex: a.index,
    appealDeclaredAt: a.display,
  }));

  it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
    '%s: child temporal text through repos, getCaseDetail, GraphQL and MCP (ordinary asOf)',
    async (_name, readerIndex) => {
      const reader = readers[readerIndex]!;
      const hearings = (await reader.module.repos.hearings.listForCase('2003'))._unsafeUnwrap();
      expect(
        hearings.map((h) => ({
          hearingIndex: h.hearingIndex,
          hearingAt: h.hearingAt,
          pronouncementDate: h.pronouncementDate,
          documentDate: h.documentDate,
        }))
      ).toEqual(expectedHearings);
      const appeals = (await reader.module.repos.appeals.listForCase('2003'))._unsafeUnwrap();
      expect(
        appeals.map((a) => ({ appealIndex: a.appealIndex, appealDeclaredAt: a.appealDeclaredAt }))
      ).toEqual(expectedAppeals);

      const res = await gql(reader, DETAIL_2003);
      expect(res.errors).toBeUndefined();
      expect(res.data).toEqual({
        judicialCase: {
          case: {
            caseId: '2003',
            sourceOpenedAt: '2025-02-03',
            latestSourceModifiedAt: '2025-02-01T00:00:00.000Z',
          },
          hearings: expectedHearings,
          appeals: expectedAppeals,
          // max over ORD + REF before the exceptional rows exist
          asOf: { asOf: '2025-06-01T12:00:00.500Z', estimated: true },
        },
      });
      const idOnly = await gql(reader, '{ judicialCase(caseId: "2003") { case { caseId } } }');
      expect(idOnly).toEqual({
        data: { judicialCase: { case: { caseId: '2003' } } },
        errors: undefined,
      });

      const out = await mcp(reader, 'get_judicial_case', { caseId: '2003' });
      expect(out.ok).toBe(true);
      expect(out.item).toMatchObject({
        hearings: HEARINGS_2003.map((h) => ({
          hearingIndex: h.index,
          hearingAt: h.atDisplay,
          pronouncementDate: h.pronouncementDisplay,
          documentDate: h.documentDisplay,
        })),
        appeals: expectedAppeals,
        // A2: the additive source-scoped metadata (every A1 case is portal_just).
        asOf: {
          asOf: '2025-06-01T12:00:00.500Z',
          estimated: true,
          sourceSlug: 'portal_just',
          basis: 'max_stored_source_modified_at',
          captureFreshnessAt: null,
          loadFreshnessAt: null,
        },
      });
    }
  );

  it('every emitted child value denotes the stored native value (PostgreSQL witness)', async () => {
    for (const h of HEARINGS_2003) {
      const at = h.atDisplay;
      expect(
        await witness(
          h.atExact
            ? `select ($1::timestamptz is not distinct from hearing_at) as v from justice.case_hearings where case_id = 2003 and hearing_index = $2`
            : `select ($1::timestamptz is not distinct from date_trunc('milliseconds', hearing_at)) as v from justice.case_hearings where case_id = 2003 and hearing_index = $2`,
          [at, h.index]
        ),
        `hearing ${String(h.index)} hearing_at`
      ).toBe(true);
      for (const [col, display] of [
        ['pronouncement_date', h.pronouncementDisplay],
        ['document_date', h.documentDisplay],
      ] as const) {
        expect(
          await witness(
            `select ($1::date is not distinct from ${col}) as v from justice.case_hearings where case_id = 2003 and hearing_index = $2`,
            [display, h.index]
          ),
          `hearing ${String(h.index)} ${col}`
        ).toBe(true);
      }
    }
    for (const a of APPEALS_2003) {
      expect(
        await witness(
          `select ($1::date is not distinct from appeal_declared_at) as v from justice.case_appeals where case_id = 2003 and appeal_index = $2`,
          [a.display, a.index]
        ),
        `appeal ${String(a.index)}`
      ).toBe(true);
    }
  });

  // ── exceptional stored case values (seeded now: they change the global asOf) ──

  describe('exceptional stored values', () => {
    beforeAll(async () => {
      await seed(setup!, EXT_CASES, EXT);
    });

    it('the hand-ordered expectations equal PostgreSQL native ordering (exceptional court self-check)', async () => {
      await checkFixtureOrdering(EXT);
    });

    it.each(traversalMatrix(EXT))(
      '%s: every edge and end cursor follows the exact tuple',
      async (_label, court, sort, dir, readerIndex) => {
        await checkCaseList(court, sort, dir, readerIndex);
      },
      60_000
    );

    it('exceptional modified displays denote the stored value (exact, or the ms-truncated instant)', async () => {
      for (const c of EXT_CASES) {
        const display = MODIFIED_DISPLAY[c.id] ?? null;
        const ordinary = display?.endsWith('Z') === true;
        expect(
          await witness(
            ordinary
              ? `select ($1::timestamptz is not distinct from date_trunc('milliseconds', latest_source_modified_at)) as v from justice.cases where case_id = $2::bigint`
              : `select ($1::timestamptz is not distinct from latest_source_modified_at) as v from justice.cases where case_id = $2::bigint`,
            [display, c.id]
          ),
          `case ${c.id}`
        ).toBe(true);
      }
    });

    it.each(SESSIONS.map((s, i) => [s.name, i] as const))(
      '%s: an infinity maximum is reported as asOf text on GraphQL and MCP detail',
      async (_name, readerIndex) => {
        const reader = readers[readerIndex]!;
        const res = await gql(reader, DETAIL_2003);
        expect(res.errors).toBeUndefined();
        expect((res.data?.['judicialCase'] as { asOf: unknown }).asOf).toEqual({
          asOf: 'infinity',
          estimated: true,
        });
        const out = await mcp(reader, 'get_judicial_case', { caseId: '1001' });
        expect(out.ok).toBe(true);
        expect(out.item).toMatchObject({
          case: {
            caseId: '1001',
            sourceOpenedAt: reader.session.opened['1001'],
            sourceOpenedAtBasis: 'portal_header_data',
            latestSourceModifiedAt: '294276-12-31T23:59:59.999999+00 AD',
          },
          // A2: the additive source-scoped metadata (every A1 case is portal_just).
          asOf: {
            asOf: 'infinity',
            estimated: true,
            sourceSlug: 'portal_just',
            basis: 'max_stored_source_modified_at',
            captureFreshnessAt: null,
            loadFreshnessAt: null,
          },
        });
      }
    );
  });
});
