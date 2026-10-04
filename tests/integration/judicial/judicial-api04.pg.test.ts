/**
 * Judicial API-04 — real-DDL proof of the stored-decision reads and the
 * complete judicial REST/GraphQL/MCP read matrix.
 *
 * TARGET GUARD. Touches ONLY an explicitly provided throwaway database:
 * `JUDICIAL_API04_TEST_PG_URL` + `JUDICIAL_API04_TEST_DB_NAME`, where the name is
 * `server_justice_api04_<run-id>`, the URL is a loopback endpoint whose database
 * path equals that name and carries NO query parameters or fragment,
 * `current_database()` matches, and the database holds no user schema or
 * relation before setup. Without the inputs it SKIPS; with
 * `TEST_E2E_REQUIRED=1` it FAILS. No `.env`, no container.
 *
 * SCHEMA. The five original scrapper prod migrations (the four justice
 * migrations + 20260629T132000__justice_decisions), hash-pinned, imported from
 * `SCRAPPER_REPO_ROOT` and executed (`up`) — no hand-written DDL, no relaxed
 * CHECK, FK or unique constraint.
 *
 * CONNECTIONS. One setup connection seeds synthetic rows (identity overrides
 * only here) and evaluates independent PostgreSQL witnesses. Every module read
 * goes through read-only readers whose startup options set
 * `default_transaction_read_only=on` plus TimeZone/DateStyle, verified on every
 * pooled connection: UTC/ISO and Asia/Kathmandu with SQL,DMY. Each reader owns
 * (a) the REAL redesign app (`buildRedesignApp`, modules legal+judicial, built
 * with NODE_ENV=production so the production GraphQL formatter is the one
 * exercised) driven through Fastify.inject over REST, HTTP GraphQL and the real
 * `/api/v1/mcp` JSON-RPC path; and (b) a directly built module for the
 * old-compatible witnesses. The per-IP MCP token bucket (30/min) is a property
 * of the route, not of the data: each injected MCP call uses its own synthetic
 * remote address so a deterministic suite is never throttled.
 *
 * EXPECTATIONS are hand-written literals (IDs as text, dates, timestamps, JSON
 * values, memberships, orders) plus independent PostgreSQL witnesses; never the
 * module's own transforms. High int8 IDs are compared as text (no whole-row
 * JSON decoded through JS numbers).
 *
 * IMPORT-SAFE ON THE PRE-API04 BASELINE: only pre-existing exports are
 * imported. On ce48c60f8 the existing-case blocks run (the ambiguous natural
 * key returns an arbitrary row; a NULL lineage target fails the old non-null
 * SDL); the new REST paths, roots and tools are simply absent there.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql, type GraphQLSchema } from 'graphql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeJudicialModule, type JudicialModule } from '@/modules/judicial/index.js';
import {
  createContributorRegistry,
  kernelToolInputSchema,
  type McpToolOutput,
} from '@/modules/shared/index.js';
import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

// ── target guard ───────────────────────────────────────────────────────────────

const REQUIRED = process.env['TEST_E2E_REQUIRED'] === '1';
const TARGET_URL = process.env['JUDICIAL_API04_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['JUDICIAL_API04_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const DB_NAME_RE = /^server_justice_api04_[a-z0-9_]{1,40}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Validate an explicit target WITHOUT connecting and without echoing the URL. */
const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (targetUrl === '' || targetDb === '') {
    throw new Error(
      'API-04 PG proof is REQUIRED (TEST_E2E_REQUIRED=1) but JUDICIAL_API04_TEST_PG_URL / JUDICIAL_API04_TEST_DB_NAME are unset'
    );
  }
  if (!DB_NAME_RE.test(targetDb)) {
    throw new Error('JUDICIAL_API04_TEST_DB_NAME must be server_justice_api04_<run-id>');
  }
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error('JUDICIAL_API04_TEST_PG_URL is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('JUDICIAL_API04_TEST_PG_URL must be a postgres URL');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('JUDICIAL_API04_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('JUDICIAL_API04_TEST_PG_URL must be a loopback endpoint');
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error(
      'JUDICIAL_API04_TEST_PG_URL database does not equal JUDICIAL_API04_TEST_DB_NAME'
    );
  }
};

describe('judicial API-04 target guard (pure; no connection, no env)', () => {
  const NAME = 'server_justice_api04_guard';
  const AT = `postgres://api04@127.0.0.1:5432/${NAME}`;

  it.each([
    ['a host override', `${AT}?host=remote.example`],
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
      'a serving database name',
      'postgres://api04@127.0.0.1/transparenta_prod',
      'transparenta_prod',
      /server_justice_api04_<run-id>/u,
    ],
    [
      'the A2 throwaway name',
      'postgres://api04@127.0.0.1/server_justice_a2_x',
      'server_justice_a2_x',
      /server_justice_api04_<run-id>/u,
    ],
    ['a non-postgres URL', `mysql://api04@127.0.0.1/${NAME}`, NAME, /postgres URL/u],
    ['a non-loopback host', `postgres://api04@db.example:5432/${NAME}`, NAME, /loopback/u],
    [
      'a database-name mismatch',
      'postgres://api04@127.0.0.1/server_justice_api04_other',
      NAME,
      /does not equal/u,
    ],
  ] as const)('rejects %s', (_label, url, name, message) => {
    expect(() => {
      assertThrowawayTarget(url, name);
    }).toThrow(message);
  });

  it('accepts a clean loopback target', () => {
    expect(() => {
      assertThrowawayTarget(AT, NAME);
    }).not.toThrow();
  });
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
  '20260629T132000__justice_decisions.ts':
    '640dc337e0d634d8303f76c57984940bbf9ab03359c07f547f092f3b2e431a44',
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

const D = {
  max: '9223372036854775807',
  p53plus1: '9007199254740993',
  p53: '9007199254740992',
  nine: '9',
  eight: '8',
  seven: '7',
  zero: '0',
  min: '-9223372036854775808',
  other: '-5',
} as const;

const SRC = 'api04_src';
const OTHER_SRC = 'api04_other';
const BODY = 'api04_body';
const TS_DEFAULT = {
  created: '2026-03-04 05:06:07.000001+00',
  updated: '2026-03-04 05:06:07.999999+00',
};
const TS_DEFAULT_TEXT = {
  createdAt: '2026-03-04T05:06:07.000001+00 AD',
  updatedAt: '2026-03-04T05:06:07.999999+00 AD',
};
const MAX_ATTRS = {
  total_amount_eur: '9007199254740993.0100',
  nested: { k: [1, null, 'x'], unfamiliar: { deeper: true } },
};

interface DecisionSeed {
  readonly id: string;
  readonly body: string;
  readonly system: string;
  readonly ref: string;
  readonly no: string | null;
  readonly year: number | null;
  readonly date: string | null;
  readonly kind: string | null;
  readonly outcome: string | null;
  readonly ecli: string | null;
  readonly appNo: string | null;
  /** The JSON text stored with ::jsonb. */
  readonly attrsJson: string;
  readonly privacy: 'public' | 'restricted';
  readonly url: string;
  readonly created: string;
  readonly updated: string;
}

const DECISIONS: readonly DecisionSeed[] = [
  {
    id: D.max,
    body: BODY,
    system: SRC,
    ref: 'ref/a:b?c#d é',
    no: '12',
    year: 2019,
    date: '2020-02-29',
    kind: 'decizie',
    outcome: 'admis',
    ecli: 'ECLI:API04:SHARED',
    appNo: 'APP-1',
    attrsJson: JSON.stringify(MAX_ATTRS),
    privacy: 'restricted',
    url: 'https://example.invalid/api04/max',
    created: '2026-01-02 03:04:05.123456+00',
    updated: '2026-01-02 03:04:05.654321+00',
  },
  {
    id: D.p53plus1,
    body: 'ccr',
    system: SRC,
    ref: 'same-ref',
    no: null,
    year: 0,
    date: '0044-03-15 BC',
    kind: null,
    outcome: null,
    ecli: 'ECLI:API04:SHARED',
    appNo: 'APP-1',
    attrsJson: 'null',
    privacy: 'public',
    url: 'https://example.invalid/api04/2',
    ...TS_DEFAULT,
  },
  {
    id: D.p53,
    body: 'ccr',
    system: SRC,
    ref: '',
    no: null,
    year: -32768,
    date: '5874897-12-31',
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '[1,"a"]',
    privacy: 'public',
    url: 'https://example.invalid/api04/3',
    ...TS_DEFAULT,
  },
  {
    id: D.nine,
    body: 'ccr',
    system: SRC,
    ref: 'ordinary',
    no: null,
    year: 2024,
    date: '2024-06-30',
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '{}',
    privacy: 'public',
    url: 'https://example.invalid/api04/9',
    ...TS_DEFAULT,
  },
  {
    id: D.eight,
    body: 'echr',
    system: SRC,
    ref: 'date-no-year',
    no: null,
    year: null,
    date: '4713-01-01 BC',
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '"scalar"',
    privacy: 'public',
    url: 'https://example.invalid/api04/8',
    ...TS_DEFAULT,
  },
  {
    id: D.seven,
    body: 'echr',
    system: SRC,
    ref: 'year-no-date',
    no: null,
    year: 2021,
    date: null,
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '42',
    privacy: 'public',
    url: 'https://example.invalid/api04/7',
    ...TS_DEFAULT,
  },
  {
    id: D.zero,
    body: 'echr',
    system: SRC,
    ref: '   spaced  ',
    no: null,
    year: 32767,
    date: 'infinity',
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: 'true',
    privacy: 'public',
    url: 'https://example.invalid/api04/0',
    ...TS_DEFAULT,
  },
  {
    id: D.min,
    body: 'echr',
    system: SRC,
    ref: 'neg',
    no: null,
    year: null,
    date: '-infinity',
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '{"amount":"0.10"}',
    privacy: 'restricted',
    url: 'https://example.invalid/api04/min',
    created: '0044-03-15 12:00:00.000001+00 BC',
    updated: 'infinity',
  },
  {
    id: D.other,
    body: 'ccr',
    system: OTHER_SRC,
    ref: 'same-ref',
    no: null,
    year: null,
    date: null,
    kind: null,
    outcome: null,
    ecli: null,
    appNo: null,
    attrsJson: '{}',
    privacy: 'public',
    url: 'https://example.invalid/api04/other',
    ...TS_DEFAULT,
  },
];

/** The served view of every decision, written by hand (not the transform). */
const DECISION_VIEW: Readonly<Record<string, Record<string, unknown>>> = {
  [D.max]: {
    decisionId: D.max,
    issuingBody: BODY,
    sourceSystem: SRC,
    sourceRef: 'ref/a:b?c#d é',
    decisionNo: '12',
    decisionYear: 2019,
    decisionDate: '2020-02-29',
    decisionKind: 'decizie',
    outcomeNormalized: 'admis',
    ecli: 'ECLI:API04:SHARED',
    applicationNo: 'APP-1',
    attrs: MAX_ATTRS,
    privacyClass: 'restricted',
    sourceUrl: 'https://example.invalid/api04/max',
    sourceObjectKey: null,
    createdAt: '2026-01-02T03:04:05.123456+00 AD',
    updatedAt: '2026-01-02T03:04:05.654321+00 AD',
  },
  [D.p53plus1]: {
    decisionId: D.p53plus1,
    issuingBody: 'ccr',
    sourceSystem: SRC,
    sourceRef: 'same-ref',
    decisionNo: null,
    decisionYear: 0,
    decisionDate: '0044-03-15 BC',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: 'ECLI:API04:SHARED',
    applicationNo: 'APP-1',
    attrs: null,
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/2',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.p53]: {
    decisionId: D.p53,
    issuingBody: 'ccr',
    sourceSystem: SRC,
    sourceRef: '',
    decisionNo: null,
    decisionYear: -32768,
    decisionDate: '5874897-12-31 AD',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: [1, 'a'],
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/3',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.nine]: {
    decisionId: D.nine,
    issuingBody: 'ccr',
    sourceSystem: SRC,
    sourceRef: 'ordinary',
    decisionNo: null,
    decisionYear: 2024,
    decisionDate: '2024-06-30',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: {},
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/9',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.eight]: {
    decisionId: D.eight,
    issuingBody: 'echr',
    sourceSystem: SRC,
    sourceRef: 'date-no-year',
    decisionNo: null,
    decisionYear: null,
    decisionDate: '4713-01-01 BC',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: 'scalar',
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/8',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.seven]: {
    decisionId: D.seven,
    issuingBody: 'echr',
    sourceSystem: SRC,
    sourceRef: 'year-no-date',
    decisionNo: null,
    decisionYear: 2021,
    decisionDate: null,
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: 42,
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/7',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.zero]: {
    decisionId: D.zero,
    issuingBody: 'echr',
    sourceSystem: SRC,
    sourceRef: '   spaced  ',
    decisionNo: null,
    decisionYear: 32767,
    decisionDate: 'infinity',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: true,
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/0',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
  [D.min]: {
    decisionId: D.min,
    issuingBody: 'echr',
    sourceSystem: SRC,
    sourceRef: 'neg',
    decisionNo: null,
    decisionYear: null,
    decisionDate: '-infinity',
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: { amount: '0.10' },
    privacyClass: 'restricted',
    sourceUrl: 'https://example.invalid/api04/min',
    sourceObjectKey: null,
    createdAt: '0044-03-15T12:00:00.000001+00 BC',
    updatedAt: 'infinity',
  },
  [D.other]: {
    decisionId: D.other,
    issuingBody: 'ccr',
    sourceSystem: OTHER_SRC,
    sourceRef: 'same-ref',
    decisionNo: null,
    decisionYear: null,
    decisionDate: null,
    decisionKind: null,
    outcomeNormalized: null,
    ecli: null,
    applicationNo: null,
    attrs: {},
    privacyClass: 'public',
    sourceUrl: 'https://example.invalid/api04/other',
    sourceObjectKey: null,
    ...TS_DEFAULT_TEXT,
  },
};

/** The SRC list in native decision_id DESC order (also witnessed in SQL below). */
const SRC_ORDER = [D.max, D.p53plus1, D.p53, D.nine, D.eight, D.seven, D.zero, D.min];

const L = {
  max: '9223372036854775807',
  p53plus1: '9007199254740993',
  zero: '0',
  minusOne: '-1',
  min: '-9223372036854775808',
  five: '5',
} as const;
const LINK_TS = {
  created: '2026-04-05 06:07:08.000001+00',
  updated: '2026-04-05 06:07:08.000002+00',
};
const LINK_TS_TEXT = {
  createdAt: '2026-04-05T06:07:08.000001+00 AD',
  updatedAt: '2026-04-05T06:07:08.000002+00 AD',
};

interface LinkSeed {
  readonly id: string;
  readonly decision: string;
  readonly kind: string;
  readonly ref: string;
  readonly role: string | null;
  readonly method: string | null;
  readonly score: string | null;
  readonly status: string;
  readonly evidenceJson: string;
  readonly resolver: string | null;
}

const LINKS: readonly LinkSeed[] = [
  {
    id: L.max,
    decision: D.max,
    kind: 'company',
    ref: '00012345',
    role: 'party',
    method: 'api04',
    score: '0.999',
    status: 'accepted',
    evidenceJson: '{"amount":"1.10","k":[1]}',
    resolver: 'v1',
  },
  {
    id: L.p53plus1,
    decision: D.max,
    kind: 'public_entity',
    ref: '00012345',
    role: null,
    method: null,
    score: null,
    status: 'rejected',
    evidenceJson: 'null',
    resolver: null,
  },
  {
    id: L.zero,
    decision: D.max,
    kind: 'contract',
    ref: 'C-1/2024',
    role: null,
    method: null,
    score: '1.500',
    status: 'candidate',
    evidenceJson: '[]',
    resolver: null,
  },
  {
    id: L.minusOne,
    decision: D.max,
    kind: 'ecris_case',
    ref: '999999999999999999999',
    role: null,
    method: null,
    score: '0.000',
    status: 'needs_review',
    evidenceJson: '"s"',
    resolver: null,
  },
  {
    id: L.min,
    decision: D.max,
    kind: 'notice',
    ref: ' N 7 ',
    role: null,
    method: null,
    score: '9.999',
    status: 'accepted',
    evidenceJson: '{}',
    resolver: null,
  },
  {
    id: L.five,
    decision: D.p53plus1,
    kind: 'company',
    ref: '00012345',
    role: null,
    method: null,
    score: '0.100',
    status: 'candidate',
    evidenceJson: '{}',
    resolver: null,
  },
];

const linkView = (id: string): Record<string, unknown> => {
  const s = LINKS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`link ${id}`);
  const evidence: unknown = {
    [L.max]: { amount: '1.10', k: [1] },
    [L.p53plus1]: null,
    [L.zero]: [],
    [L.minusOne]: 's',
    [L.min]: {},
    [L.five]: {},
  }[id];
  return {
    linkId: s.id,
    decisionId: s.decision,
    subjectKind: s.kind,
    subjectRef: s.ref,
    role: s.role,
    method: s.method,
    confidenceScore: s.score,
    validationStatus: s.status,
    evidence,
    resolverVersion: s.resolver,
    ...LINK_TS_TEXT,
  };
};

// Cases: a native two-source natural-key collision + unique/absent controls.
const COURT_A = 'TEST_API04_A';
const COURT_B = 'TEST_API04_B';
const COLL = { one: '9007199254740993', two: '9007199254740994', number: '77/2024' } as const;

interface CaseSeed {
  readonly id: string;
  readonly slug: string;
  readonly court: string;
  readonly number: string;
  readonly object: string | null;
  readonly opened: string | null;
  readonly modified: string | null;
}

const CASES: readonly CaseSeed[] = [
  {
    id: COLL.one,
    slug: 'api04_src_one',
    court: COURT_A,
    number: COLL.number,
    object: 'obiect unu',
    opened: '2024-01-02 12:00:00+00',
    modified: '2026-01-01 00:00:00+00',
  },
  {
    id: COLL.two,
    slug: 'api04_src_two',
    court: COURT_A,
    number: COLL.number,
    object: 'obiect doi',
    opened: null,
    modified: '2026-02-01 00:00:00+00',
  },
  {
    id: '4001',
    slug: 'portal_just',
    court: COURT_A,
    number: '78/2024',
    object: 'obiect trei',
    opened: '2025-02-03 12:00:00+00',
    modified: '2026-03-01 10:00:00.250+00',
  },
  {
    id: '4002',
    slug: 'iccj',
    court: COURT_B,
    number: '79/2024',
    object: null,
    opened: '2020-05-06 12:00:00+00',
    modified: null,
  },
  {
    id: '4003',
    slug: 'api04_src_one',
    court: COURT_A,
    number: '80/2024',
    object: null,
    opened: null,
    modified: '2025-12-31 00:00:00+00',
  },
  {
    id: '4004',
    slug: 'api04_src_two',
    court: COURT_A,
    number: '81/2024',
    object: null,
    opened: null,
    modified: null,
  },
  {
    id: '5002',
    slug: 'portal_just',
    court: COURT_B,
    number: '90/2024',
    object: null,
    opened: '2024-07-01 12:00:00+00',
    modified: null,
  },
];

const MARKERS = [
  'LINEAGE_EVIDENCE_MARKER',
  'PCC_EVIDENCE_MARKER',
  'PCC_CANDIDATES_MARKER',
  'SOLUTION_MARKER_SECRET',
  'SUMMARY_MARKER_SECRET',
  'SUMMARY_REF_MARKER',
] as const;

const seedAll = async (client: pg.Client): Promise<void> => {
  await client.query(
    `insert into justice.courts (institution_code, ordinal, court_level, locality, county_code)
     values ($1, 9501, 'tribunal', 'API04', 'B')`,
    [COURT_A]
  );
  await client.query(
    `insert into justice.courts (institution_code, ordinal, court_level, locality, county_code,
       parent_institution_code)
     values ($1, 9502, 'judecatorie', 'API04', 'B', $2)`,
    [COURT_B, COURT_A]
  );
  for (const c of CASES) {
    await client.query(
      `insert into justice.cases (case_id, source_slug, institution_code, case_number, object,
         source_opened_at, latest_source_modified_at)
       values ($1::bigint, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [c.id, c.slug, c.court, c.number, c.object, c.opened, c.modified]
    );
  }
  // Case 4001: a hearing with forbidden/withheld text, a company + a person party,
  // a published company candidate whose jsonb carries markers, citations, lineage.
  await client.query(
    `insert into justice.case_hearings (case_id, hearing_index, hearing_at, panel,
       pronouncement_date, document_number, document_date, row_hash, solution, solution_summary)
     values (4001, 1, '2025-02-10 10:00:00+00', 'C1', '2025-02-10', 'D1', '2025-02-11', 'h',
       'SOLUTION_MARKER_SECRET', 'SUMMARY_MARKER_SECRET')`
  );
  await client.query(
    `insert into justice.party_name_keys (name_key_id, name_key, display_name, party_kind,
       classifier_version, normalizer_version)
     overriding system value
     values (700, 'api04 companie', 'SC API04 COMPANIE SRL', 'company', 'party-kind-v0', 'test-api04')`
  );
  await client.query(
    `insert into justice.case_parties (case_id, party_index, name_key_id, party_kind,
       classifier_version, classifier_rule, row_hash, latest_response_id, parser_version)
     values (4001, 0, 700, 'company', 'party-kind-v0', 'company_legal_form', 'h', 1, 'test-api04'),
            (4001, 1, null, 'person', 'party-kind-v0', 'person_shape', 'h', 1, 'test-api04')`
  );
  await client.query(
    `insert into justice.party_company_candidates (name_key_id, candidate_cui, method,
       confidence_tier, validation_status, resolver_version, evidence, candidates)
     values (700, '12345678', 'exact_normalized_name_unique', 'A', 'published', 'test-api04',
       '{"marker":"PCC_EVIDENCE_MARKER"}', '[{"m":"PCC_CANDIDATES_MARKER"}]')`
  );
  const refs: readonly (readonly [
    string,
    string,
    string,
    string,
    number,
    number,
    number | null,
    string | null,
  ])[] = [
    // [id, case, field, raw, span start, span end, hearing, target]
    ['9223372036854775807', '4001', 'object', 'Legea 7/2000', 0, 12, null, '42'],
    ['9007199254740993', '4001', 'object', 'Legea 7/2000', 20, 32, null, '42'],
    ['3', '4001', 'solution', 'art. 5', 0, 6, 1, null],
    ['4', '4001', 'solution_summary', 'SUMMARY_REF_MARKER', 0, 5, 1, '42'],
    ['5', '5002', 'object', 'Legea 7/2000', 0, 12, null, '42'],
  ];
  for (const [id, caseId, field, raw, start, end, hearing, target] of refs) {
    await client.query(
      `insert into justice.case_legal_references (case_legal_reference_id, case_id, source_field,
         raw_text, span_start, span_end, act_type, act_number, act_year, target_act_id,
         resolution_status, resolver_version, hearing_index)
       overriding system value
       values ($1::bigint, $2::bigint, $3, $4, $5, $6, 'lege', '7', 2000, $7::bigint,
               $8, 'test-api04', $9)`,
      [
        id,
        caseId,
        field,
        raw,
        start,
        end,
        target,
        target === null ? 'unresolved' : 'unique',
        hearing,
      ]
    );
  }
  await client.query(
    `insert into justice.case_lineage_candidates (lineage_candidate_id, from_case_id, to_case_id,
       lineage_type, method, confidence_score, validation_status, evidence, resolver_version)
     overriding system value
     values (9, 4001, null, 'appeal', 'api04', null, 'candidate',
             '{"marker":"LINEAGE_EVIDENCE_MARKER"}', 'test-api04'),
            (10, 4001, 5002, 'old_number', 'api04', 0.750, 'accepted',
             '{"marker":"LINEAGE_EVIDENCE_MARKER"}', 'test-api04')`
  );
  // Decisions: a module-new extensible issuing body + the seeded ones.
  await client.query(
    `insert into justice.issuing_bodies (issuing_body, label, kind, notes, created_at)
     values ($1, 'API04 body', 'court', 'n', '2026-05-06 07:08:09.123456+00')`,
    [BODY]
  );
  await client.query(
    `update justice.issuing_bodies set created_at = '2026-01-01 00:00:00+00' where issuing_body <> $1`,
    [BODY]
  );
  for (const d of DECISIONS) {
    await client.query(
      `insert into justice.decisions (decision_id, issuing_body, source_system, source_ref,
         decision_no, decision_year, decision_date, decision_kind, outcome_normalized, ecli,
         application_no, attrs, privacy_class, source_url, created_at, updated_at)
       overriding system value
       values ($1::bigint, $2, $3, $4, $5, $6::smallint, $7::date, $8, $9, $10, $11, $12::jsonb,
               $13, $14, $15::timestamptz, $16::timestamptz)`,
      [
        d.id,
        d.body,
        d.system,
        d.ref,
        d.no,
        d.year,
        d.date,
        d.kind,
        d.outcome,
        d.ecli,
        d.appNo,
        d.attrsJson,
        d.privacy,
        d.url,
        d.created,
        d.updated,
      ]
    );
  }
  for (const l of LINKS) {
    await client.query(
      `insert into justice.decision_subject_links (link_id, decision_id, subject_kind, subject_ref,
         role, method, confidence_score, validation_status, evidence, resolver_version,
         created_at, updated_at)
       overriding system value
       values ($1::bigint, $2::bigint, $3, $4, $5, $6, $7::numeric, $8, $9::jsonb, $10,
               $11::timestamptz, $12::timestamptz)`,
      [
        l.id,
        l.decision,
        l.kind,
        l.ref,
        l.role,
        l.method,
        l.score,
        l.status,
        l.evidenceJson,
        l.resolver,
        LINK_TS.created,
        LINK_TS.updated,
      ]
    );
  }
};

// ── readers: the real app over HTTP + the directly built module ────────────────

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
  readonly app: FastifyInstance;
  readonly kernelPool: pg.Pool;
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

const openReader = async (session: Session): Promise<Reader> => {
  const prod = createProdDb({ connectionString: readerUrl(session), max: READER_POOL_MAX, min: 0 });
  const module = makeJudicialModule({
    db: prod.db,
    registry: createContributorRegistry(),
    legalActLoader: () => undefined,
  });
  const schema = makeExecutableSchema({
    typeDefs: GLUE_TYPEDEFS + module.graphqlSlice.typeDefs,
    resolvers: { ...scalarResolvers, ...(module.graphqlResolvers as Record<string, never>) },
  });
  // The production GraphQL formatter is selected at build time from NODE_ENV.
  const savedNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  let built: Awaited<ReturnType<typeof buildRedesignApp>>;
  try {
    built = await buildRedesignApp({
      logLevel: 'silent',
      modules: ['legal', 'judicial'],
      procurementWarmCache: false,
      kernelConfig: {
        prodDatabaseUrl: readerUrl(session),
        poolMax: READER_POOL_MAX,
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
    });
  } finally {
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
  }
  await built.app.ready();
  return {
    session,
    prod,
    module,
    schema,
    app: built.app,
    kernelPool: built.kernel.pool,
  };
};

/** Every connection of a reader pool must carry the startup settings and refuse writes. */
const verifyPool = async (pool: pg.Pool, session: Session): Promise<void> => {
  const clients = await Promise.all(Array.from({ length: READER_POOL_MAX }, () => pool.connect()));
  try {
    for (const client of clients) {
      const r = await client.query<{
        db: string;
        dro: string;
        tro: string;
        tz: string;
        ds: string;
      }>(
        `select current_database() as db,
                current_setting('default_transaction_read_only') as dro,
                current_setting('transaction_read_only') as tro,
                current_setting('TimeZone') as tz,
                current_setting('DateStyle') as ds`
      );
      expect(r.rows[0]).toEqual({
        db: TARGET_DB,
        dro: 'on',
        tro: 'on',
        tz: session.timeZone,
        ds: session.expectedDateStyle,
      });
      await expect(
        client.query(
          `insert into justice.issuing_bodies (issuing_body, label, kind) values ('x', 'x', 'court')`
        )
      ).rejects.toMatchObject({ code: '25006' });
    }
  } finally {
    for (const client of clients) client.release();
  }
};

// ── transports ─────────────────────────────────────────────────────────────────

interface RestReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
  readonly cacheControl: unknown;
}

const rest = async (reader: Reader, url: string): Promise<RestReply> => {
  const res = await reader.app.inject({ method: 'GET', url: `/api/v1/judicial${url}` });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown>>(),
    raw: res.body,
    cacheControl: res.headers['cache-control'],
  };
};

interface GqlReply {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly { message: string; extensions?: { code?: string | undefined } }[];
}

const gqlHttp = async (
  reader: Reader,
  query: string,
  variables?: Record<string, unknown>
): Promise<GqlReply> => {
  const res = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    payload: { query, ...(variables !== undefined && { variables }) },
  });
  return res.json<GqlReply>();
};

let mcpCalls = 0;
const mcpHttp = async (
  reader: Reader,
  name: string,
  args: Record<string, unknown>
): Promise<{ structured: McpToolOutput | undefined; isError: boolean; raw: string }> => {
  mcpCalls += 1;
  const res = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    remoteAddress: `10.40.${String(Math.floor(mcpCalls / 250))}.${String((mcpCalls % 250) + 1)}`,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: mcpCalls,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = res.json<{
    result?: { structuredContent?: McpToolOutput; isError?: boolean };
  }>();
  return {
    structured: body.result?.structuredContent,
    isError: body.result?.isError === true,
    raw: res.body,
  };
};

const gqlDirect = async (reader: Reader, source: string): Promise<GqlReply> => {
  const result = await graphql({ schema: reader.schema, source });
  return {
    data: result.data ?? null,
    ...(result.errors !== undefined && {
      errors: result.errors.map((e) => ({
        message: e.message,
        extensions: { code: e.extensions['code'] as string | undefined },
      })),
    }),
  };
};

const mcpDirect = async (
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

const DECISION_FIELDS = `decisionId issuingBody sourceSystem sourceRef decisionNo decisionYear
  decisionDate decisionKind outcomeNormalized ecli applicationNo attrs privacyClass sourceUrl
  sourceObjectKey createdAt updatedAt`;
const LINK_FIELDS = `linkId decisionId subjectKind subjectRef role method confidenceScore
  validationStatus evidence resolverVersion createdAt updatedAt`;

const ids = (items: readonly unknown[], key: string): string[] =>
  items.map((x) => String((x as Record<string, unknown>)[key]));

/** The raw field values (no String coercion: null stays null, '5' never equals 5). */
const field = (items: readonly unknown[], key: string): unknown[] =>
  items.map((x) => (x as Record<string, unknown>)[key]);

const mcpToolsList = async (
  reader: Reader
): Promise<{ status: number; names: readonly unknown[] | undefined }> => {
  mcpCalls += 1;
  const res = await reader.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    remoteAddress: `10.40.${String(Math.floor(mcpCalls / 250))}.${String((mcpCalls % 250) + 1)}`,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: mcpCalls, method: 'tools/list', params: {} }),
  });
  const body = res.json<{ result?: { tools?: unknown } }>();
  const tools = body.result?.tools;
  return {
    status: res.statusCode,
    names: Array.isArray(tools) ? tools.map((t) => (t as { name?: unknown }).name) : undefined,
  };
};

/**
 * The accepted public judicial MCP contract, listed independently (not read from
 * the factory or the SDK). The composed app also carries kernel + legal tools.
 */
const JUDICIAL_TOOL_NAMES = [
  'resolve_judicial_filters',
  'get_judicial_case',
  'get_court_caseload',
  'get_company_litigation',
  'get_case_legal_references',
  'list_judicial_courts',
  'get_judicial_court',
  'list_judicial_cases',
  'get_case_lineage',
  'list_company_litigation_cases',
  'list_cases_citing_act',
  'list_judicial_issuing_bodies',
  'list_judicial_decisions',
  'get_judicial_decision',
  'get_judicial_decision_by_source',
  'list_judicial_decision_subject_links',
  'resolve_judicial_decision_filters',
] as const;
/** Names of the judicial family in a composed list (no kernel/legal tool matches). */
const JUDICIAL_NAME_RE = /judicial|court|case|litigation/u;

// ── the suite ──────────────────────────────────────────────────────────────────

const describeApi04 = CONFIGURED || REQUIRED ? describe : describe.skip;

describeApi04('judicial API-04 — actual DDL, explicit throwaway database', () => {
  let setup: pg.Client | undefined;
  let setupDb: ProdDb | undefined;
  const readers: Reader[] = [];

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
      const reader = await openReader(session);
      readers.push(reader);
      await verifyPool(reader.prod.pool, session);
      await verifyPool(reader.kernelPool, session);
    }
  }, 300_000);

  afterAll(async () => {
    await Promise.allSettled([
      // app.close() also closes the kernel pool (its onClose hook).
      ...readers.map(async (r) => {
        await r.app.close();
        await r.prod.db.destroy();
      }),
      setupDb?.db.destroy(),
      setup?.end(),
    ]);
  });

  const each = (fn: (reader: Reader) => Promise<void>) => async () => {
    expect(readers).toHaveLength(SESSIONS.length);
    for (const reader of readers) await fn(reader);
  };

  // ── fixture self-checks (independent PostgreSQL witnesses) ──────────────────

  it('the fixture holds the intended native values (identity overrides, ordering, constraints)', async () => {
    const order = await setup!.query<{ id: string }>(
      `select decision_id::text as id from justice.decisions where source_system = $1
        order by decision_id desc`,
      [SRC]
    );
    expect(order.rows.map((r) => r.id)).toEqual(SRC_ORDER);
    const pair = await setup!.query<{ n: number }>(
      `select count(*)::int as n from justice.decisions where source_ref = 'same-ref'`
    );
    expect(pair.rows[0]?.n).toBe(2);
    const lineage = await setup!.query<{ n: number }>(
      `select count(*)::int as n from justice.case_lineage_candidates where to_case_id is null`
    );
    expect(lineage.rows[0]?.n).toBe(1);
    const collision = await setup!.query<{ n: number; slugs: number }>(
      `select count(*)::int as n, count(distinct source_slug)::int as slugs from justice.cases
        where institution_code = $1 and case_number = $2`,
      [COURT_A, COLL.number]
    );
    expect(collision.rows[0]).toEqual({ n: 2, slugs: 2 });
    const year = await setup!.query<{ y: number; date_year: string }>(
      `select decision_year as y, extract(year from decision_date)::text as date_year
         from justice.decisions where decision_id = $1::bigint`,
      [D.p53plus1]
    );
    expect(year.rows[0]).toEqual({ y: 0, date_year: '-44' });
  });

  // ── existing-case adapters, old-compatible witnesses (correction 2 + 1) ─────

  describe('existing case lookups (runnable on the pre-API04 baseline)', () => {
    it(
      'the ambiguous two-field lookup is a typed InvalidInput in the repo, GraphQL and MCP (old code: an arbitrary row)',
      each(async (reader) => {
        const repo = await reader.module.repos.cases.getByNaturalKey(COURT_A, COLL.number);
        expect(repo.isErr() && repo.error).toEqual({
          type: 'InvalidInput',
          message: 'case lookup is ambiguous; use caseId',
          field: 'caseNumber',
        });
        const gql = await gqlDirect(
          reader,
          `{ judicialCase(institutionCode: "${COURT_A}", caseNumber: "${COLL.number}") { case { caseId } } }`
        );
        expect(gql.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
        expect(gql.data).toEqual({ judicialCase: null });
        const mcp = await mcpDirect(reader, 'get_judicial_case', {
          institutionCode: COURT_A,
          caseNumber: COLL.number,
        });
        expect(mcp).toMatchObject({
          ok: false,
          errorType: 'InvalidInput',
          errorCode: 'INVALID_INPUT',
        });
        expect(mcp.item).toBeUndefined();
      })
    );

    it(
      'unique, absent and exact-id controls keep their existing results',
      each(async (reader) => {
        const one = await gqlDirect(
          reader,
          `{ judicialCase(institutionCode: "${COURT_A}", caseNumber: "80/2024") {
              case { caseId sourceSlug sourceOpenedAtBasis } asOf { asOf sourceSlug } } }`
        );
        expect(one).toEqual({
          data: {
            judicialCase: {
              case: { caseId: '4003', sourceSlug: 'api04_src_one', sourceOpenedAtBasis: 'unknown' },
              asOf: { asOf: '2026-01-01T00:00:00.000Z', sourceSlug: 'api04_src_one' },
            },
          },
        });
        const two = await gqlDirect(
          reader,
          `{ judicialCase(institutionCode: "${COURT_A}", caseNumber: "81/2024") { case { caseId sourceSlug } asOf { asOf } } }`
        );
        expect(two.data).toEqual({
          judicialCase: {
            case: { caseId: '4004', sourceSlug: 'api04_src_two' },
            asOf: { asOf: '2026-02-01T00:00:00.000Z' },
          },
        });
        const absent = await gqlDirect(
          reader,
          `{ judicialCase(institutionCode: "${COURT_A}", caseNumber: "99/2024") { case { caseId } } }`
        );
        expect(absent).toEqual({ data: { judicialCase: null } });
        expect(
          await mcpDirect(reader, 'get_judicial_case', {
            institutionCode: COURT_A,
            caseNumber: '99/2024',
          })
        ).toMatchObject({ ok: true, summary: 'No matching case.' });
        for (const [id, object] of [
          [COLL.one, 'obiect unu'],
          [COLL.two, 'obiect doi'],
        ] as const) {
          const byId = await gqlDirect(
            reader,
            `{ judicialCase(caseId: "${id}") { case { caseId object } } }`
          );
          expect(byId.data).toEqual({ judicialCase: { case: { caseId: id, object } } });
        }
        // caseId precedence: an exact id wins over the (ambiguous) pair; an absent
        // id never falls back to the pair.
        const precedence = await gqlDirect(
          reader,
          `{ judicialCase(caseId: "${COLL.two}", institutionCode: "${COURT_A}", caseNumber: "${COLL.number}") { case { caseId } } }`
        );
        expect(precedence.data).toEqual({ judicialCase: { case: { caseId: COLL.two } } });
        const noFallback = await gqlDirect(
          reader,
          `{ judicialCase(caseId: "123", institutionCode: "${COURT_A}", caseNumber: "80/2024") { case { caseId } } }`
        );
        expect(noFallback).toEqual({ data: { judicialCase: null } });
      })
    );

    it(
      'case detail lineage serves a NULL target as null, without bubbling (old code: non-null violation)',
      each(async (reader) => {
        const res = await gqlDirect(
          reader,
          `{ judicialCase(caseId: "4001") { lineage { lineageCandidateId fromCaseId toCaseId lineageType validationStatus } } }`
        );
        expect(res).toEqual({
          data: {
            judicialCase: {
              lineage: [
                {
                  lineageCandidateId: '9',
                  fromCaseId: '4001',
                  toCaseId: null,
                  lineageType: 'appeal',
                  validationStatus: 'candidate',
                },
                {
                  lineageCandidateId: '10',
                  fromCaseId: '4001',
                  toCaseId: '5002',
                  lineageType: 'old_number',
                  validationStatus: 'accepted',
                },
              ],
            },
          },
        });
      })
    );
  });

  // ── stored decisions over the three HTTP transports ──────────────────────────

  describe('stored decisions — REST, HTTP GraphQL and /api/v1/mcp agree on every stored value', () => {
    it(
      'detail by native id: every field as stored, both privacy classes, all native spellings',
      each(async (reader) => {
        for (const id of [...SRC_ORDER, D.other]) {
          const view = DECISION_VIEW[id];
          const r = await rest(reader, `/decisions/${id}`);
          expect(r.status, id).toBe(200);
          expect(r.body, id).toEqual({
            ok: true,
            data: view,
            requestId: expect.any(String) as unknown,
          });
          expect(r.raw, id).toContain(`"decisionId":"${id}"`);
          expect(r.cacheControl).toBe('no-store');
          const g = await gqlHttp(
            reader,
            `{ judicialDecision(decisionId: "${id}") { ${DECISION_FIELDS} } }`
          );
          expect(g, id).toEqual({ data: { judicialDecision: view } });
          const m = await mcpHttp(reader, 'get_judicial_decision', { decisionId: id });
          expect(m.structured, id).toMatchObject({
            ok: true,
            kind: 'judicial_decision',
            item: view,
          });
        }
        expect((await rest(reader, '/decisions/9223372036854775807')).raw).toContain(
          '"total_amount_eur":"9007199254740993.0100"'
        );
      })
    );

    it(
      'a valid absent id is 404 / null / no-match; malformed ids are typed input errors',
      each(async (reader) => {
        const absent = await rest(reader, '/decisions/42');
        expect(absent.status).toBe(404);
        expect(absent.body).toMatchObject({ ok: false, error: 'NotFound', resource: 'decision' });
        expect(
          await gqlHttp(reader, '{ judicialDecision(decisionId: "42") { decisionId } }')
        ).toEqual({
          data: { judicialDecision: null },
        });
        expect(
          (await mcpHttp(reader, 'get_judicial_decision', { decisionId: '42' })).structured
        ).toMatchObject({
          ok: true,
          summary: 'No matching decision.',
        });
        for (const bad of ['01', '-0', '9223372036854775808', '1.0', 'abc']) {
          const r = await rest(reader, `/decisions/${encodeURIComponent(bad)}`);
          expect(r.status, bad).toBe(400);
          expect(r.body, bad).toMatchObject({ error: 'InvalidInput', field: 'decisionId' });
          const g = await gqlHttp(
            reader,
            `{ judicialDecision(decisionId: "${bad}") { decisionId } }`
          );
          expect(g.errors?.[0]?.extensions?.code, bad).toBe('INVALID_INPUT');
          const m = await mcpHttp(reader, 'get_judicial_decision', { decisionId: bad });
          expect(m.structured, bad).toMatchObject({ ok: false, errorType: 'InvalidInput' });
        }
      })
    );

    it(
      'source lookup is the exact pair: the same ref under two systems, no trimming',
      each(async (reader) => {
        const a = await rest(reader, `/decisions/lookup?sourceSystem=${SRC}&sourceRef=same-ref`);
        expect(a.body).toMatchObject({ ok: true, data: { decisionId: D.p53plus1 } });
        const b = await rest(
          reader,
          `/decisions/lookup?sourceSystem=${OTHER_SRC}&sourceRef=same-ref`
        );
        expect(b.body).toMatchObject({ ok: true, data: { decisionId: D.other } });
        const spaced = await rest(
          reader,
          `/decisions/lookup?sourceSystem=${SRC}&sourceRef=${encodeURIComponent('   spaced  ')}`
        );
        expect(spaced.body).toMatchObject({ ok: true, data: { decisionId: D.zero } });
        const empty = await rest(reader, `/decisions/lookup?sourceSystem=${SRC}&sourceRef=`);
        expect(empty.body).toMatchObject({ ok: true, data: { decisionId: D.p53 } });
        const unicode = await rest(
          reader,
          `/decisions/lookup?sourceSystem=${SRC}&sourceRef=${encodeURIComponent('ref/a:b?c#d é')}`
        );
        expect(unicode.body).toMatchObject({ ok: true, data: { decisionId: D.max } });
        const trimmed = await rest(
          reader,
          `/decisions/lookup?sourceSystem=${SRC}&sourceRef=spaced`
        );
        expect(trimmed.status).toBe(404);
        const half = await rest(reader, `/decisions/lookup?sourceSystem=${SRC}`);
        expect(half.status).toBe(400);
        const g = await gqlHttp(
          reader,
          `{ judicialDecisionBySource(sourceSystem: "${OTHER_SRC}", sourceRef: "same-ref") { decisionId sourceSystem } }`
        );
        expect(g).toEqual({
          data: { judicialDecisionBySource: { decisionId: D.other, sourceSystem: OTHER_SRC } },
        });
        const m = await mcpHttp(reader, 'get_judicial_decision_by_source', {
          sourceSystem: SRC,
          sourceRef: 'same-ref',
        });
        expect(m.structured).toMatchObject({ ok: true, item: { decisionId: D.p53plus1 } });
      })
    );

    it(
      'the list pages in native decision_id DESC across sizes and surfaces; cursors are reusable across surfaces',
      each(async (reader) => {
        // REST, first=1, full iteration.
        const seen: string[] = [];
        let after: string | null = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const url = `/decisions?sourceSystem=${SRC}&first=1${after === null ? '' : `&after=${encodeURIComponent(after)}`}`;
          const page = await rest(reader, url);
          expect(page.status).toBe(200);
          seen.push(...ids(page.body['data'] as unknown[], 'decisionId'));
          after = (page.body['meta'] as { cursor: { next: string | null } }).cursor.next;
          if (after === null) break;
        }
        expect(seen).toEqual(SRC_ORDER);
        // HTTP GraphQL, first=3, endCursor on every nonempty page incl. the last.
        const gseen: string[] = [];
        let gAfter: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const g: GqlReply = await gqlHttp(
            reader,
            'query ($after: String) { judicialDecisions(filter: { sourceSystem: { eq: "api04_src" } }, first: 3, after: $after) { edges { cursor node { decisionId } } pageInfo { hasNextPage endCursor } totalCount } }',
            { after: gAfter }
          );
          const conn = g.data?.['judicialDecisions'] as {
            edges: { cursor: string; node: { decisionId: string } }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            totalCount: number | null;
          };
          expect(conn.totalCount).toBeNull();
          expect(conn.pageInfo.endCursor).toBe(conn.edges[conn.edges.length - 1]?.cursor);
          gseen.push(...conn.edges.map((e) => e.node.decisionId));
          if (!conn.pageInfo.hasNextPage) break;
          gAfter = conn.pageInfo.endCursor;
        }
        expect(gseen).toEqual(SRC_ORDER);
        // MCP over HTTP, first=2.
        const mseen: string[] = [];
        let mAfter: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const m = await mcpHttp(reader, 'list_judicial_decisions', {
            sourceSystem: SRC,
            first: 2,
            ...(mAfter !== null && { after: mAfter }),
          });
          mseen.push(...ids(m.structured?.items ?? [], 'decisionId'));
          mAfter = (m.structured?.meta as { cursor: { next: string | null } }).cursor.next;
          if (mAfter === null) break;
        }
        expect(mseen).toEqual(SRC_ORDER);
        // The same operator object on every surface: a REST cursor resumes GraphQL and MCP.
        const p1 = await rest(reader, `/decisions?sourceSystem=${SRC}&first=2`);
        const next = (p1.body['meta'] as { cursor: { next: string } }).cursor.next;
        const g2 = await gqlHttp(
          reader,
          'query ($after: String) { judicialDecisions(filter: { sourceSystem: { eq: "api04_src" } }, first: 2, after: $after) { edges { node { decisionId } } } }',
          { after: next }
        );
        expect(
          (
            g2.data?.['judicialDecisions'] as { edges: { node: { decisionId: string } }[] }
          ).edges.map((e) => e.node.decisionId)
        ).toEqual([D.p53, D.nine]);
        const m2 = await mcpHttp(reader, 'list_judicial_decisions', {
          sourceSystem: SRC,
          first: 2,
          after: next,
        });
        expect(ids(m2.structured?.items ?? [], 'decisionId')).toEqual([D.p53, D.nine]);
        // The cursor is bound to the filter: a different filter refuses it (typed
        // InvalidInput; the no-query proof is the scripted-driver unit suite).
        const mismatch = await rest(
          reader,
          `/decisions?sourceSystem=${SRC}&decisionYearIsNull=false&first=2&after=${encodeURIComponent(next)}`
        );
        expect(mismatch.status).toBe(400);
        expect(mismatch.body).toMatchObject({ error: 'InvalidInput', field: 'cursor' });
        // A JSON number past 2^53 cannot be a JS literal; the cursor text spells it.
        const tampered = Buffer.from(
          '{"v":1,"sort":"decisionId","dir":"desc","keys":[9007199254740993],"fhash":"x"}'
        ).toString('base64url');
        expect(
          (await rest(reader, `/decisions?sourceSystem=${SRC}&after=${tampered}`)).status
        ).toBe(400);
      })
    );

    it(
      'decisionYear is the independent smallint: 0, negatives, endpoints, intersections and out-of-smallint operands',
      each(async (reader) => {
        const list = async (query: string): Promise<string[]> => {
          const r = await rest(reader, `/decisions?sourceSystem=${SRC}&${query}`);
          expect(r.status, query).toBe(200);
          return ids(r.body['data'] as unknown[], 'decisionId');
        };
        expect(await list('decisionYear=0')).toEqual([D.p53plus1]);
        expect(await list('decisionYear=-32768')).toEqual([D.p53]);
        expect(await list('decisionYear=32767')).toEqual([D.zero]);
        expect(await list('decisionYearGte=-32768&decisionYearLte=32767')).toEqual([
          D.max,
          D.p53plus1,
          D.p53,
          D.nine,
          D.seven,
          D.zero,
        ]);
        expect(await list('decisionYearFrom=-40000&decisionYearTo=40000')).toEqual([
          D.max,
          D.p53plus1,
          D.p53,
          D.nine,
          D.seven,
          D.zero,
        ]);
        expect(await list('decisionYear=40000')).toEqual([]);
        expect(await list('decisionYearGte=40000')).toEqual([]);
        expect(await list('decisionYearLte=-40000')).toEqual([]);
        expect(await list('decisionYear=2021&decisionYearGte=2020')).toEqual([D.seven]);
        expect(await list('decisionYear=2019&decisionYearGte=2020')).toEqual([]);
        expect(await list('decisionYearGte=5&decisionYearLte=4')).toEqual([]);
        expect(await list('decisionYearIsNull=true')).toEqual([D.eight, D.min]);
        expect(await list('decisionYearIsNull=false&decisionYear=2019')).toEqual([D.max]);
        // Year is independent of the date: 2021 has no date; 44 BC is stored with year 0.
        expect(await list('decisionDateIsNull=true')).toEqual([D.seven]);
        expect(await list('decisionYearIsNull=true&decisionDateIsNull=false')).toEqual([
          D.eight,
          D.min,
        ]);
        const g = await gqlHttp(
          reader,
          '{ judicialDecisions(filter: { sourceSystem: { eq: "api04_src" }, decisionYear: { eq: 40000 } }) { edges { node { decisionId } } } }'
        );
        expect(g).toEqual({ data: { judicialDecisions: { edges: [] } } });
        const tooBig = await gqlHttp(
          reader,
          '{ judicialDecisions(filter: { sourceSystem: { eq: "api04_src" }, decisionYear: { gte: 2147483647, lte: -2147483648 } }) { edges { node { decisionId } } } }'
        );
        expect(tooBig).toEqual({ data: { judicialDecisions: { edges: [] } } });
        for (const bad of [
          'decisionYear=1.5',
          'decisionYear=2147483648',
          'decisionYearIsNull=yes',
        ]) {
          const r = await rest(reader, `/decisions?sourceSystem=${SRC}&${bad}`);
          expect(r.status, bad).toBe(400);
        }
      })
    );

    it(
      'the list bound and attribute filters: exact text, shared ECLI/appno stay distinct rows',
      each(async (reader) => {
        const unbounded = await rest(reader, '/decisions?decisionYear=0');
        expect(unbounded.status).toBe(400);
        expect(unbounded.body).toMatchObject({
          error: 'InvalidInput',
          message: 'judicial decision list requires sourceSystem.eq or issuingBody.eq',
        });
        const shared = await rest(
          reader,
          `/decisions?sourceSystem=${SRC}&ecli=ECLI%3AAPI04%3ASHARED`
        );
        expect(ids(shared.body['data'] as unknown[], 'decisionId')).toEqual([D.max, D.p53plus1]);
        const byBody = await rest(reader, `/decisions?issuingBody=${BODY}`);
        expect(ids(byBody.body['data'] as unknown[], 'decisionId')).toEqual([D.max]);
        const restricted = await rest(
          reader,
          `/decisions?sourceSystem=${SRC}&privacyClass=restricted`
        );
        expect(ids(restricted.body['data'] as unknown[], 'decisionId')).toEqual([D.max, D.min]);
        const emptySystem = await rest(reader, '/decisions?sourceSystem=');
        expect(emptySystem.body).toMatchObject({ ok: true, data: [] });
        const noKind = await rest(
          reader,
          `/decisions?sourceSystem=${SRC}&decisionKindIsNull=false`
        );
        expect(ids(noKind.body['data'] as unknown[], 'decisionId')).toEqual([D.max]);
      })
    );
  });

  // ── decision subject links (link grain, exactly one anchor) ──────────────────

  describe('decision subject links — link grain, all kinds and statuses, exact anchors', () => {
    it(
      'by decision: every stored link row (all five kinds, four statuses), native link_id DESC, stored JSON/score text',
      each(async (reader) => {
        const r = await rest(reader, `/decisions/${D.max}/subject-links`);
        expect(r.body).toEqual({
          ok: true,
          data: [L.max, L.p53plus1, L.zero, L.minusOne, L.min].map(linkView),
          requestId: expect.any(String) as unknown,
          meta: { cursor: { next: null } },
        });
        const g = await gqlHttp(
          reader,
          `{ judicialDecisionSubjectLinks(filter: { decisionId: { eq: "${D.max}" } }) { edges { node { ${LINK_FIELDS} } } } }`
        );
        expect(
          (g.data?.['judicialDecisionSubjectLinks'] as { edges: { node: unknown }[] }).edges.map(
            (e) => e.node
          )
        ).toEqual([L.max, L.p53plus1, L.zero, L.minusOne, L.min].map(linkView));
        const m = await mcpHttp(reader, 'list_judicial_decision_subject_links', {
          decisionId: D.max,
        });
        expect(m.structured?.items).toEqual(
          [L.max, L.p53plus1, L.zero, L.minusOne, L.min].map(linkView)
        );
        const accepted = await rest(
          reader,
          `/decisions/${D.max}/subject-links?validationStatus=accepted`
        );
        expect(ids(accepted.body['data'] as unknown[], 'linkId')).toEqual([L.max, L.min]);
      })
    );

    it(
      'by subject: exact kind + text (no CUI normalization), dangling refs kept, several decisions per subject',
      each(async (reader) => {
        const company = await rest(
          reader,
          '/decision-subject-links?subjectKind=company&subjectRef=00012345'
        );
        expect(ids(company.body['data'] as unknown[], 'linkId')).toEqual([L.max, L.five]);
        expect(ids(company.body['data'] as unknown[], 'decisionId')).toEqual([D.max, D.p53plus1]);
        const entity = await rest(
          reader,
          '/decision-subject-links?subjectKind=public_entity&subjectRef=00012345'
        );
        expect(ids(entity.body['data'] as unknown[], 'linkId')).toEqual([L.p53plus1]);
        const normalized = await rest(
          reader,
          '/decision-subject-links?subjectKind=company&subjectRef=12345'
        );
        expect(normalized.body).toMatchObject({ ok: true, data: [] });
        const dangling = await rest(
          reader,
          '/decision-subject-links?subjectKind=ecris_case&subjectRef=999999999999999999999'
        );
        expect(ids(dangling.body['data'] as unknown[], 'linkId')).toEqual([L.minusOne]);
        const padded = await rest(
          reader,
          `/decision-subject-links?subjectKind=notice&subjectRef=${encodeURIComponent(' N 7 ')}`
        );
        expect(ids(padded.body['data'] as unknown[], 'linkId')).toEqual([L.min]);
        const absent = await rest(reader, '/decisions/42/subject-links');
        expect(absent.body).toMatchObject({ ok: true, data: [] });
      })
    );

    it(
      'pages at link grain and refuses half pairs, both anchors, unanchored statuses and unknown labels',
      each(async (reader) => {
        const p1 = await rest(reader, `/decisions/${D.max}/subject-links?first=2`);
        expect(ids(p1.body['data'] as unknown[], 'linkId')).toEqual([L.max, L.p53plus1]);
        const next = (p1.body['meta'] as { cursor: { next: string } }).cursor.next;
        const p2 = await rest(
          reader,
          `/decisions/${D.max}/subject-links?first=2&after=${encodeURIComponent(next)}`
        );
        expect(ids(p2.body['data'] as unknown[], 'linkId')).toEqual([L.zero, L.minusOne]);
        // Complete the walk: REST page 2's next cursor resumes the SAME decision
        // anchor and page size over HTTP GraphQL; the last page holds only the
        // int8 minimum. Expected IDs are literal text, never JS numbers.
        const next2 = (p2.body['meta'] as { cursor: { next: unknown } }).cursor.next;
        expect(typeof next2).toBe('string');
        const LINK_PAGE = `query ($after: String) { judicialDecisionSubjectLinks(
          filter: { decisionId: { eq: "9223372036854775807" } }, first: 2, after: $after) {
          edges { cursor node { linkId } } pageInfo { hasNextPage endCursor } totalCount } }`;
        interface LinkConnection {
          readonly edges: readonly { cursor: unknown; node: { linkId: unknown } }[];
          readonly pageInfo: { hasNextPage: unknown; endCursor: unknown };
          readonly totalCount: unknown;
        }
        const p3 = await gqlHttp(reader, LINK_PAGE, { after: next2 });
        expect(p3.errors).toBeUndefined();
        const c3 = p3.data?.['judicialDecisionSubjectLinks'] as LinkConnection;
        expect(c3.edges.map((e) => e.node.linkId)).toEqual(['-9223372036854775808']);
        const terminal = c3.edges[0]?.cursor;
        expect(typeof terminal).toBe('string');
        expect(terminal).not.toBe('');
        expect(c3.pageInfo).toEqual({ hasNextPage: false, endCursor: terminal });
        expect(c3.totalCount).toBeNull();
        // The terminal EDGE cursor (REST gives no next token on a last page)
        // continues to an empty page on all three surfaces.
        expect(await gqlHttp(reader, LINK_PAGE, { after: terminal })).toEqual({
          data: {
            judicialDecisionSubjectLinks: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: null,
            },
          },
        });
        const r4 = await rest(
          reader,
          `/decisions/9223372036854775807/subject-links?first=2&after=${encodeURIComponent(String(terminal))}`
        );
        expect(r4.status).toBe(200);
        expect(r4.body).toMatchObject({ ok: true, data: [], meta: { cursor: { next: null } } });
        const m4 = await mcpHttp(reader, 'list_judicial_decision_subject_links', {
          decisionId: '9223372036854775807',
          first: 2,
          after: terminal,
        });
        expect(m4.structured).toMatchObject({
          ok: true,
          items: [],
          meta: { cursor: { next: null } },
        });
        // The walk returns every stored link of the decision exactly once, in native
        // link_id DESC order, as exact text.
        expect([
          ...field(p1.body['data'] as unknown[], 'linkId'),
          ...field(p2.body['data'] as unknown[], 'linkId'),
          ...c3.edges.map((e) => e.node.linkId),
        ]).toEqual(['9223372036854775807', '9007199254740993', '0', '-1', '-9223372036854775808']);
        const otherAnchor = await rest(
          reader,
          `/decisions/${D.p53plus1}/subject-links?first=2&after=${encodeURIComponent(next)}`
        );
        expect(otherAnchor.status).toBe(400);
        for (const url of [
          '/decision-subject-links?subjectKind=company',
          '/decision-subject-links?subjectRef=1',
          '/decision-subject-links?validationStatus=accepted',
          '/decision-subject-links?subjectKind=person&subjectRef=1',
          `/decisions/${D.max}/subject-links?validationStatus=published`,
          '/decisions/01/subject-links',
        ]) {
          const r = await rest(reader, url);
          expect(r.status, url).toBe(400);
          expect(r.body, url).toMatchObject({ ok: false, error: 'InvalidInput' });
        }
        const both = await gqlHttp(
          reader,
          `{ judicialDecisionSubjectLinks(filter: { decisionId: { eq: "${D.max}" }, subjectKind: { eq: "company" }, subjectRef: { eq: "00012345" } }) { edges { cursor } } }`
        );
        expect(both.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
      })
    );
  });

  // ── issuing bodies + decision discovery ──────────────────────────────────────

  describe('issuing bodies and decision discovery', () => {
    it(
      'the complete issuing-body reference list, ordered by key (seed read by the setup connection)',
      each(async (reader) => {
        const seed = await setup!.query<{
          issuingBody: string;
          label: string;
          kind: string;
          notes: string | null;
        }>(
          `select issuing_body as "issuingBody", label, kind, notes from justice.issuing_bodies order by issuing_body`
        );
        expect(seed.rows.length).toBeGreaterThan(1);
        const expected = seed.rows.map((b) => ({
          ...b,
          createdAt:
            b.issuingBody === BODY
              ? '2026-05-06T07:08:09.123456+00 AD'
              : '2026-01-01T00:00:00.000000+00 AD',
        }));
        const r = await rest(reader, '/issuing-bodies');
        expect(r.body).toEqual({
          ok: true,
          data: expected,
          requestId: expect.any(String) as unknown,
        });
        const g = await gqlHttp(
          reader,
          '{ judicialIssuingBodies { issuingBody label kind notes createdAt } }'
        );
        expect(g).toEqual({ data: { judicialIssuingBodies: expected } });
        const m = await mcpHttp(reader, 'list_judicial_issuing_bodies', {});
        expect(m.structured?.items).toEqual(expected);
      })
    );

    it(
      'discovery over stored values; the case dimensions stay four; malformed originals are typed errors',
      each(async (reader) => {
        const systems = await rest(reader, '/decisions/filters/resolve?dim=sourceSystem&q=api04');
        expect(systems.body).toMatchObject({
          ok: true,
          data: [
            { kind: 'sourceSystem', value: OTHER_SRC, label: OTHER_SRC },
            { kind: 'sourceSystem', value: SRC, label: SRC },
          ],
        });
        const bodies = await rest(reader, '/decisions/filters/resolve?dim=issuingBody&q=API04');
        expect(bodies.body).toMatchObject({
          ok: true,
          data: [{ kind: 'issuingBody', value: BODY, label: 'API04 body', hint: 'court' }],
        });
        const escaped = await rest(
          reader,
          '/decisions/filters/resolve?dim=sourceSystem&q=api04%25'
        );
        expect(escaped.body).toMatchObject({ ok: true, data: [] });
        for (const url of [
          '/decisions/filters/resolve?dim=court&q=x',
          '/decisions/filters/resolve?dim=sourceSystem&q=x&limit=0',
          '/decisions/filters/resolve?dim=sourceSystem&q=x&limit=1.5',
          '/filters/resolve?dim=issuingBody&q=x',
        ]) {
          expect((await rest(reader, url)).status, url).toBe(400);
        }
        const m = await mcpHttp(reader, 'resolve_judicial_decision_filters', {
          dim: 'subjectKind',
          q: 'co',
        });
        // A substring match over the five stored kinds (every kind contains 'c').
        expect(ids(m.structured?.items ?? [], 'value')).toEqual(['company', 'contract']);
        // The new root over production HTTP GraphQL, on a stored-value dimension.
        expect(
          await gqlHttp(
            reader,
            '{ judicialDecisionResolve(dim: "issuingBody", q: "API04") { kind value label hint } }'
          )
        ).toEqual({
          data: {
            judicialDecisionResolve: [
              { kind: 'issuingBody', value: 'api04_body', label: 'API04 body', hint: 'court' },
            ],
          },
        });
      })
    );

    it(
      'the actual SDK tools/list on /api/v1/mcp carries each judicial tool exactly once',
      each(async (reader) => {
        const listed = await mcpToolsList(reader);
        expect(listed.status).toBe(200);
        expect(Array.isArray(listed.names)).toBe(true);
        const names = listed.names ?? [];
        // The composed app (kernel + legal + judicial) lists more than 17 tools.
        for (const name of JUDICIAL_TOOL_NAMES) {
          expect(
            names.filter((n) => n === name),
            name
          ).toHaveLength(1);
        }
        const judicialSubset = names
          .filter((n): n is string => typeof n === 'string' && JUDICIAL_NAME_RE.test(n))
          .sort();
        expect(judicialSubset).toEqual([...JUDICIAL_TOOL_NAMES].sort());
      })
    );
  });

  // ── existing-case REST/MCP adapters over the same usecases ────────────────────

  describe('existing case reads through the new REST paths and tools', () => {
    it(
      'courts, the court tree, the case list and the aggregate',
      each(async (reader) => {
        const courts = await rest(reader, '/courts?q=API04');
        expect(ids(courts.body['data'] as unknown[], 'institutionCode')).toEqual([
          COURT_A,
          COURT_B,
        ]);
        const tree = await rest(reader, `/courts/${COURT_A}`);
        expect(tree.body).toMatchObject({
          ok: true,
          data: { court: { institutionCode: COURT_A }, children: [{ institutionCode: COURT_B }] },
        });
        expect((await rest(reader, '/courts/NOPE')).status).toBe(404);
        const cases = await rest(reader, `/cases?institutionCode=${COURT_B}`);
        expect(ids(cases.body['data'] as unknown[], 'caseId')).toEqual(['5002', '4002']);
        expect((await rest(reader, '/cases')).status).toBe(400);
        const agg = await rest(reader, `/cases/aggregate?groupBy=court&institutionCode=${COURT_A}`);
        expect(agg.body).toMatchObject({
          ok: true,
          data: { groups: [{ key: COURT_A, caseCount: 5 }], denominator: 5 },
        });
        const m = await mcpHttp(reader, 'list_judicial_cases', { institutionCode: [COURT_B] });
        expect(ids(m.structured?.items ?? [], 'caseId')).toEqual(['5002', '4002']);
        const mCourts = await mcpHttp(reader, 'list_judicial_courts', { q: 'API04' });
        expect(mCourts.isError).toBe(false);
        expect(mCourts.structured).toMatchObject({ ok: true, kind: 'judicial_courts' });
        const courtItems = mCourts.structured?.items ?? [];
        expect(
          courtItems.map((c) => {
            const r = c as Record<string, unknown>;
            return [r['institutionCode'], r['ordinal'], r['courtLevel']];
          })
        ).toEqual([
          ['TEST_API04_A', 9501, 'tribunal'],
          ['TEST_API04_B', 9502, 'judecatorie'],
        ]);
        const court = await mcpHttp(reader, 'get_judicial_court', { institutionCode: COURT_A });
        expect(court.structured).toMatchObject({
          ok: true,
          item: { children: [{ institutionCode: COURT_B }] },
        });
      })
    );

    it(
      'REST case lookup refuses the ambiguous pair (400), finds a unique one and 404s an absent one',
      each(async (reader) => {
        const amb = await rest(
          reader,
          `/cases/lookup?institutionCode=${COURT_A}&caseNumber=${encodeURIComponent(COLL.number)}`
        );
        expect(amb.status).toBe(400);
        expect(amb.body).toEqual({
          ok: false,
          error: 'InvalidInput',
          message: 'case lookup is ambiguous; use caseId',
          field: 'caseNumber',
          requestId: expect.any(String) as unknown,
        });
        const g = await gqlHttp(
          reader,
          `{ judicialCase(institutionCode: "${COURT_A}", caseNumber: "${COLL.number}") { case { caseId } } }`
        );
        expect(g.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
        const m = await mcpHttp(reader, 'get_judicial_case', {
          institutionCode: COURT_A,
          caseNumber: COLL.number,
        });
        expect(m.structured).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
        const unique = await rest(
          reader,
          `/cases/lookup?institutionCode=${COURT_A}&caseNumber=80%2F2024`
        );
        expect(unique.body).toMatchObject({ ok: true, data: { case: { caseId: '4003' } } });
        expect(
          (await rest(reader, `/cases/lookup?institutionCode=${COURT_A}&caseNumber=99%2F2024`))
            .status
        ).toBe(404);
        expect((await rest(reader, `/cases/${COLL.two}`)).body).toMatchObject({
          ok: true,
          data: { case: { caseId: COLL.two, object: 'obiect doi' } },
        });
      })
    );

    it(
      'case detail, citations (stored-row grain, solution_summary excluded) and lineage (NULL target)',
      each(async (reader) => {
        const detail = await rest(reader, '/cases/4001');
        expect(detail.status).toBe(200);
        const data = detail.body['data'] as {
          parties: { name: string | null; nameKeyId: string | null; partyKind: string }[];
          personPartyCount: number;
          legalReferences: {
            caseLegalReferenceId: string;
            citation: string;
            sourceField: string;
          }[];
          lineage: { toCaseId: string | null }[];
          hearings: { hearingIndex: number }[];
          asOf: { asOf: string | null; sourceSlug: string };
        };
        expect(data.parties.map((p) => [p.partyKind, p.nameKeyId, p.name])).toEqual([
          ['company', '700', null],
          ['person', null, null],
        ]);
        expect(data.personPartyCount).toBe(1);
        expect(
          data.legalReferences.map((r) => [r.caseLegalReferenceId, r.sourceField, r.citation])
        ).toEqual([
          ['3', 'solution', 'art. 5'],
          ['9007199254740993', 'object', 'Legea 7/2000'],
          ['9223372036854775807', 'object', 'Legea 7/2000'],
        ]);
        expect(data.lineage.map((e) => e.toCaseId)).toEqual([null, '5002']);
        expect(data.asOf).toMatchObject({
          asOf: '2026-03-01T10:00:00.250Z',
          sourceSlug: 'portal_just',
        });
        const refs = await rest(reader, '/cases/4001/legal-references');
        expect(ids(refs.body['data'] as unknown[], 'caseLegalReferenceId')).toEqual([
          '3',
          '9007199254740993',
          '9223372036854775807',
        ]);
        const gRefs = await gqlHttp(
          reader,
          '{ judicialCaseLegalReferences(caseId: "4001") { caseLegalReferenceId } }'
        );
        expect(gRefs).toEqual({
          data: {
            judicialCaseLegalReferences: [
              { caseLegalReferenceId: '3' },
              { caseLegalReferenceId: '9007199254740993' },
              { caseLegalReferenceId: '9223372036854775807' },
            ],
          },
        });
        const lineage = await rest(reader, '/cases/4001/lineage');
        expect(ids(lineage.body['data'] as unknown[], 'toCaseId')).toEqual(['null', '5002']);
        // ids() coerces with String(); the raw fields distinguish SQL NULL from text.
        const restEdges = lineage.body['data'] as unknown[];
        expect(field(restEdges, 'lineageCandidateId')).toEqual(['9', '10']);
        expect(field(restEdges, 'toCaseId')).toEqual([null, '5002']);
        expect(
          await gqlHttp(
            reader,
            '{ judicialCaseLineage(caseId: "4001") { lineageCandidateId toCaseId } }'
          )
        ).toEqual({
          data: {
            judicialCaseLineage: [
              { lineageCandidateId: '9', toCaseId: null },
              { lineageCandidateId: '10', toCaseId: '5002' },
            ],
          },
        });
        const gLineage = await gqlHttp(
          reader,
          '{ judicialCaseLineage(caseId: "5002") { lineageCandidateId toCaseId } }'
        );
        expect(gLineage).toEqual({
          data: { judicialCaseLineage: [{ lineageCandidateId: '10', toCaseId: '5002' }] },
        });
        const mLineage = await mcpHttp(reader, 'get_case_lineage', { caseId: '4001' });
        expect(ids(mLineage.structured?.items ?? [], 'toCaseId')).toEqual(['null', '5002']);
        const mcpEdges = mLineage.structured?.items ?? [];
        expect(field(mcpEdges, 'lineageCandidateId')).toEqual(['9', '10']);
        expect(field(mcpEdges, 'toCaseId')).toEqual([null, '5002']);
        const citing = await rest(reader, '/acts/42/cases');
        expect(ids(citing.body['data'] as unknown[], 'caseId')).toEqual(['4001', '4001', '5002']);
        const mCiting = await mcpHttp(reader, 'list_cases_citing_act', { targetActId: '42' });
        expect(ids(mCiting.structured?.items ?? [], 'caseId')).toEqual(['4001', '4001', '5002']);
      })
    );

    it(
      'company litigation stays published-only; its cases list pages by case id',
      each(async (reader) => {
        const summary = await rest(reader, '/companies/12345678/litigation');
        expect(summary.body).toMatchObject({ ok: true, data: { cui: '12345678', caseCount: 1 } });
        const cases = await rest(reader, '/companies/12345678/cases');
        expect(cases.body).toMatchObject({
          ok: true,
          data: [{ caseId: '4001', institutionCode: COURT_A, caseNumber: '78/2024' }],
          meta: { cursor: { next: null } },
        });
        const m = await mcpHttp(reader, 'list_company_litigation_cases', { cui: '12345678' });
        expect(ids(m.structured?.items ?? [], 'caseId')).toEqual(['4001']);
      })
    );
  });

  // ── the scoped override is exact: old-policy evidence/withheld fields stay absent ─

  describe('serve-as-stored applies to the decision tables only', () => {
    it(
      'new link evidence is served, while candidate/lineage evidence, hearing solutions and party names never are',
      each(async (reader) => {
        const served = await rest(reader, `/decisions/${D.max}/subject-links`);
        // jsonb does not keep key insertion order (PostgreSQL emits "k" before
        // "amount"), so the stored evidence VALUE is compared parsed; no
        // byte-identical jsonb text or property order is claimed.
        expect(served.status).toBe(200);
        const servedLinks = served.body['data'] as unknown[];
        expect(field(servedLinks, 'linkId')[0]).toBe('9223372036854775807');
        expect(field(servedLinks, 'evidence')[0]).toEqual({ amount: '1.10', k: [1] });
        // The amount stays a quoted JSON string in the body (never re-encoded as a number).
        expect(served.raw).toContain('"amount":"1.10"');
        expect(served.raw).toContain('"k":[1]');
        const outputs: string[] = [];
        for (const url of [
          '/cases/4001',
          '/cases/4001/lineage',
          '/cases/4001/legal-references',
          '/companies/12345678/litigation',
          '/companies/12345678/cases',
          '/acts/42/cases',
        ]) {
          outputs.push((await rest(reader, url)).raw);
        }
        outputs.push(
          JSON.stringify(
            await gqlHttp(
              reader,
              '{ judicialCase(caseId: "4001") { hearings { hearingIndex panel } parties { name nameKeyId } lineage { toCaseId } legalReferences { citation } } judicialCaseLineage(caseId: "4001") { method } }'
            )
          )
        );
        for (const [name, args] of [
          ['get_judicial_case', { caseId: '4001' }],
          ['get_case_lineage', { caseId: '4001' }],
          ['get_case_legal_references', { caseId: '4001' }],
          ['get_company_litigation', { cui: '12345678' }],
          ['list_company_litigation_cases', { cui: '12345678' }],
        ] as const) {
          outputs.push((await mcpHttp(reader, name, args)).raw);
        }
        const all = outputs.join('\n');
        for (const marker of MARKERS) expect(all, marker).not.toContain(marker);
        // Keys only: "solution" is also a legitimate sourceField VALUE.
        expect(all).not.toMatch(/"(?:evidence|candidates|solution|solutionSummary)":/u);
      })
    );
  });
});
