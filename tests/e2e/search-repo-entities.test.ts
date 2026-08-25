/**
 * E2E — `makeSearchRepo(db).searchEntities(...)` against a real Postgres
 * (testcontainer) with a minimal `search.documents` table.
 *
 * The shared e2e setup (`tests/e2e/setup.ts`) starts the LEGACY budget/user
 * schema container, which has no `search.*` schema. This repo is part of the
 * prod serving DB, so the test stands up its OWN container with just the columns
 * `searchEntities` reads — matching `SearchDocuments` in
 * `src/modules/shared/shell/db/types.ts`.
 *
 * Docker-guarded: when Docker is unavailable the suite SKIPS cleanly (the shared
 * setup-file pattern), never fails.
 *
 * Covers the visibility/tombstone/allowlist gate, ILIKE on title/body/doc_id,
 * the all-digits EXACT cui match (matches a row whose title does NOT contain the
 * digits), county + year (year via `extract(year from doc_date)`) filters, the
 * all-invalid-docTypes empty short-circuit, and the limit cap.
 */

import { execSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeDocumentRepo } from '@/modules/shared/shell/repo/document-repo.js';
import { makeSearchRepo } from '@/modules/shared/shell/repo/search-repo.js';

import type { SearchRepo } from '@/modules/shared/core/ports.js';
import type { ProdDatabase } from '@/modules/shared/shell/db/types.js';

const dockerCliUp = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

let container: StartedPostgreSqlContainer | undefined;
let db: Kysely<ProdDatabase> | undefined;
let repo: SearchRepo | undefined;
/**
 * True only when a container actually started. The Docker CLI can report a
 * daemon while testcontainers still can't find a working runtime strategy (the
 * socket-probe fails) — so we gate on the real `start()`, not just `docker info`,
 * and SKIP cleanly on any startup failure rather than failing the suite.
 */
let dockerAvailable = false;

/**
 * Mark Docker-dependent tests as skipped at execution time. `beforeAll` is the
 * first point where testcontainers availability is known, so collection-time
 * helpers such as `it.skipIf(...)` cannot make the decision correctly.
 *
 * The individual test bodies keep their defensive early return, but this
 * wrapper ensures a missing runtime is reported as SKIPPED instead of PASSED.
 */
const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

/** 13 digits — a person-shaped identifier, longer than MAX_SERVED_CUI_DIGITS. */
const WITHHELD_CUI = '1234567890123';
/** The servable identifier sharing a document with it. */
const SERVABLE_CUI = '222';

const DDL = `
  drop schema if exists search cascade;
  create schema search;
  create table search.documents (
    doc_id text primary key,
    doc_type text not null,
    title text not null,
    body text,
    cuis text[] not null default '{}',
    doc_date date,
    amount_ron numeric,
    county_name text,
    url text,
    attrs jsonb not null default '{}'::jsonb,
    visibility text not null default 'public',
    rank_boost double precision,
    deleted_at timestamptz,
    updated_at timestamptz not null default now(),
    embedded_at timestamptz,
    indexed_meili_at timestamptz,
    indexed_os_at timestamptz
  );
`;

interface SeedRow {
  doc_id: string;
  doc_type: string;
  title: string;
  body?: string | null;
  cuis?: string[];
  doc_date?: string | null;
  county_name?: string | null;
  url?: string | null;
  attrs?: Record<string, unknown>;
  visibility?: string;
  /** When set, the row is tombstoned (`deleted_at = now()`) — must be excluded. */
  deleted?: boolean;
}

const SEED: SeedRow[] = [
  // Entity-grade, public, visible — the canonical match for "acme".
  {
    doc_id: 'company:1',
    doc_type: 'company',
    title: 'ACME Industrial SRL',
    body: 'manufacturer of widgets',
    cuis: ['111'],
    doc_date: '2024-03-01',
    county_name: 'Cluj',
    url: 'https://x.test/acme',
    attrs: { kind: 'srl' },
    visibility: 'public',
  },
  // Restricted — must be excluded even though it matches the query.
  { doc_id: 'company:2', doc_type: 'company', title: 'ACME Hidden SRL', visibility: 'restricted' },
  // Different county / year — for the county + year filters.
  {
    doc_id: 'company:3',
    doc_type: 'company',
    title: 'ACME Bucuresti SA',
    doc_date: '2022-06-15',
    county_name: 'Bucuresti',
  },
  // Non-entity doc type — excluded from the entity-grade allowlist.
  { doc_id: 'judicial_case:1', doc_type: 'judicial_case', title: 'ACME litigation file' },
  // Title does NOT contain the digits, but cuis does → exact-cui match for digit queries.
  { doc_id: 'company:4', doc_type: 'company', title: 'Beta Trading SRL', cuis: ['7654321'] },
  // Match via body only.
  { doc_id: 'company:5', doc_type: 'company', title: 'Gamma SRL', body: 'a special acme partner' },
  // Tombstoned (deleted_at set) but otherwise matches "acme" — must be excluded.
  { doc_id: 'company:6', doc_type: 'company', title: 'ACME Deleted SRL', deleted: true },
  // WITHHELD-ONLY: keyed solely to a person-shaped identifier (>10 digits).
  // Public and not tombstoned, so ONLY the containment rule can exclude it —
  // which is what makes it a real test of that rule rather than of visibility.
  {
    doc_id: 'company:7',
    doc_type: 'company',
    title: 'ACME Persoana Fizica',
    cuis: [WITHHELD_CUI],
  },
  // DUAL-KEYED: a public act that also names a person. The row must SURVIVE and
  // the person's identifier must NOT ride out on it. Measured 2026-08-12, prod
  // currently has zero of these — the case is seeded here precisely because the
  // permissive row rule exists for it, and an untested branch is where it will
  // break when the case returns.
  {
    doc_id: 'company:8',
    doc_type: 'company',
    title: 'ACME Contract Public',
    cuis: [SERVABLE_CUI, WITHHELD_CUI],
  },
];

/**
 * Resolve a Postgres connection string for the e2e:
 *  1. `E2E_SEARCH_PG_URL` (an external throwaway Postgres) — used to prove the
 *     SQL when no local container runtime exists (the local docker context here
 *     is a remote SSH host we must not spin throwaway containers on);
 *  2. otherwise a testcontainers Postgres (CI / a local Docker Desktop daemon).
 * Returns undefined → the suite SKIPS cleanly.
 */
const resolveConnection = async (): Promise<string | undefined> => {
  const external = process.env['E2E_SEARCH_PG_URL'];
  if (external !== undefined && external !== '') return external;

  if (!dockerCliUp()) {
    console.warn('Docker CLI unavailable and no E2E_SEARCH_PG_URL — search-repo e2e SKIPPED.');
    return undefined;
  }
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    return container.getConnectionUri();
  } catch (error) {
    // Daemon reported by the CLI but no working testcontainers runtime — skip.
    console.warn(
      `Testcontainers runtime unavailable — search-repo e2e SKIPPED: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
};

beforeAll(async () => {
  const connectionString = await resolveConnection();
  if (connectionString === undefined) return;

  // Seed through the raw pg client — `SearchDocuments` types the timestamptz
  // columns as read-only (the serving Kysely instance is read-only), so writes
  // go via plain SQL and the typed Kysely instance is reserved for repo reads.
  const pgClient = new pg.Client({ connectionString });
  await pgClient.connect();
  await pgClient.query(DDL);
  for (const r of SEED) {
    await pgClient.query(
      `insert into search.documents
         (doc_id, doc_type, title, body, cuis, doc_date, county_name, url, attrs, visibility, deleted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, case when $11 then now() else null end)`,
      [
        r.doc_id,
        r.doc_type,
        r.title,
        r.body ?? null,
        r.cuis ?? [],
        r.doc_date ?? null,
        r.county_name ?? null,
        r.url ?? null,
        JSON.stringify(r.attrs ?? {}),
        r.visibility ?? 'public',
        r.deleted ?? false,
      ]
    );
  }
  await pgClient.end();

  const pool = new pg.Pool({ connectionString });
  db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
  repo = makeSearchRepo(db);
  dockerAvailable = true;
}, 120_000);

afterAll(async () => {
  if (db !== undefined) await db.destroy();
  if (container !== undefined) await container.stop();
});

const ids = (hits: readonly { id: string }[]): string[] => hits.map((h) => h.id).sort();

describe('searchEntities (e2e) — visibility / tombstone / allowlist gate', () => {
  it('returns only public, non-deleted, entity-grade rows that match', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { limit: 50 });
    expect(res.isOk()).toBe(true);
    const got = ids(res._unsafeUnwrap());

    // company:1 (title+body), company:3 (title), company:5 (body).
    // company:8 is the dual-keyed public act added for the privacy cases: it
    // matches "acme" on its title and legitimately survives the row rule.
    expect(got).toEqual(['company:1', 'company:3', 'company:5', 'company:8']);
    // restricted (company:2), judicial_case:1, tombstoned (company:6) excluded.
    expect(got).not.toContain('company:2');
    expect(got).not.toContain('judicial_case:1');
    expect(got).not.toContain('company:6');
  });

  it('excludes a restricted row even when it matches the query', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('Hidden', { limit: 50 });
    expect(res._unsafeUnwrap()).toEqual([]);
  });

  it('excludes a non-entity doc_type (judicial_case)', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('litigation', { limit: 50 });
    expect(res._unsafeUnwrap()).toEqual([]);
  });
});

describe('searchEntities (e2e) — docTypes narrowing', () => {
  it('restricts to a requested valid doc type', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { docTypes: ['company'], limit: 50 });
    // company:8 is the dual-keyed public act added for the privacy cases: it
    // matches "acme" on its title and legitimately survives the row rule.
    expect(ids(res._unsafeUnwrap())).toEqual(['company:1', 'company:3', 'company:5', 'company:8']);
  });

  it('returns [] when every requested docType is invalid (all-invalid short-circuit)', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { docTypes: ['not_a_type'], limit: 50 });
    expect(res._unsafeUnwrap()).toEqual([]);
  });

  it('keeps only the entity-grade subset when a docType is non-entity', async () => {
    if (!dockerAvailable) return;
    // 'judicial_case' is NOT entity-grade → dropped; 'company' kept.
    const res = await repo!.searchEntities('acme', {
      docTypes: ['judicial_case', 'company'],
      limit: 50,
    });
    // company:8 is the dual-keyed public act added for the privacy cases: it
    // matches "acme" on its title and legitimately survives the row rule.
    expect(ids(res._unsafeUnwrap())).toEqual(['company:1', 'company:3', 'company:5', 'company:8']);
  });
});

describe('searchEntities (e2e) — exact CUI match for digit queries', () => {
  it('matches a row by its cuis array when q is all digits (title does NOT contain it)', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('7654321', { limit: 50 });
    const got = ids(res._unsafeUnwrap());
    expect(got).toContain('company:4'); // title 'Beta Trading SRL', cuis ['7654321']
  });

  it('does not exact-cui-match a non-digit query', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('Beta', { limit: 50 });
    expect(ids(res._unsafeUnwrap())).toEqual(['company:4']); // ILIKE on title only
  });
});

describe('searchEntities (e2e) — county + year filters', () => {
  it('filters by county_name', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { county: 'Cluj', limit: 50 });
    expect(ids(res._unsafeUnwrap())).toEqual(['company:1']);
  });

  it('filters by year via extract(year from doc_date)', async () => {
    if (!dockerAvailable) return;
    const res2024 = await repo!.searchEntities('acme', { year: 2024, limit: 50 });
    expect(ids(res2024._unsafeUnwrap())).toEqual(['company:1']);

    const res2022 = await repo!.searchEntities('acme', { year: 2022, limit: 50 });
    expect(ids(res2022._unsafeUnwrap())).toEqual(['company:3']);
  });

  it('combines county + year (no row → empty)', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { county: 'Cluj', year: 2022, limit: 50 });
    expect(res._unsafeUnwrap()).toEqual([]);
  });
});

describe('searchEntities (e2e) — bounds + mapping', () => {
  it('caps the result count at the requested limit', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('acme', { limit: 1 });
    expect(res._unsafeUnwrap()).toHaveLength(1);
  });

  it('returns [] for an empty/whitespace query without scanning', async () => {
    if (!dockerAvailable) return;
    expect((await repo!.searchEntities('', { limit: 50 }))._unsafeUnwrap()).toEqual([]);
    expect((await repo!.searchEntities('   ', { limit: 50 }))._unsafeUnwrap()).toEqual([]);
  });

  it('maps a hit with source "postgres", docKey, attrs, county, url, and cuis', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.searchEntities('Industrial', { limit: 50 });
    const hit = res._unsafeUnwrap().find((h) => h.id === 'company:1');
    expect(hit).toBeDefined();
    expect(hit!.source).toBe('postgres');
    expect(hit!.docId).toBe('company:1');
    expect(hit!.docKey).toBe('1'); // substring after the first ':'
    expect(hit!.countyName).toBe('Cluj');
    expect(hit!.url).toBe('https://x.test/acme');
    expect(hit!.cuis).toEqual(['111']);
    expect(hit!.attrs).toEqual({ kind: 'srl' });
  });
});

describe('countByCui (e2e)', () => {
  it('counts documents whose cuis array contains the CUI', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.countByCui('111');
    expect(res._unsafeUnwrap()).toBe(1);
  });

  it('returns 0 for a CUI present in no document', async () => {
    if (!dockerAvailable) return;
    const res = await repo!.countByCui('000');
    expect(res._unsafeUnwrap()).toBe(0);
  });
});

// The `fallbackTextSearch (e2e)` suite was removed with the method
// (2026-08-25): it had no production caller and did not pin visibility.

describe('the withheld-identifier gate, on every read path over search.documents', () => {
  it('searchEntities drops a document keyed ONLY to a person', async () => {
    const res = await repo?.searchEntities('acme', { limit: 50 });
    const rows = res?._unsafeUnwrap() ?? [];
    expect(rows.map((r) => r.docId)).not.toContain('company:7');
  });

  it('searchEntities KEEPS a dual-keyed public act but scrubs the person from it', async () => {
    // Both halves matter. Dropping the row would remove a public act from the
    // surface; echoing the array would publish the identifier. The row filter is
    // only safe because this scrub runs.
    const res = await repo?.searchEntities('acme', { limit: 50 });
    const rows = res?._unsafeUnwrap() ?? [];
    const hit = rows.find((r) => r.docId === 'company:8');
    expect(hit).toBeDefined();
    expect(hit?.cuis).toEqual([SERVABLE_CUI]);
  });

  it('countByCui answers 0 for a withheld identifier', async () => {
    // A count cannot be scrubbed: the number IS the answer to "how many
    // documents mention this person?". Unfiltered, this returned 2.
    const result = await repo?.countByCui(WITHHELD_CUI);
    expect(result?.isOk()).toBe(true);
    expect(result?._unsafeUnwrap()).toBe(0);
  });

  it('countByCui is unchanged for a servable identifier', async () => {
    // MUTATE TO ABSENT in the other direction: the gate must not quietly
    // deflate ordinary counts, or it would be indistinguishable from a bug.
    const result = await repo?.countByCui(SERVABLE_CUI);
    expect(result?._unsafeUnwrap()).toBe(1);
  });

  // The fallbackTextSearch withheld-gate case was removed with the method
  // (2026-08-25); searchEntities carries the equivalent assertion above.

  it('documentRepo.findById refuses the withheld-only document', async () => {
    const repoDocs = makeDocumentRepo(db!);
    expect((await repoDocs.findById('company:7'))._unsafeUnwrap()).toBeNull();
    expect((await repoDocs.findById('company:1'))._unsafeUnwrap()).not.toBeNull();
  });

  it('documentRepo scrubs the person from a dual-keyed document', async () => {
    const repoDocs = makeDocumentRepo(db!);
    const doc = (await repoDocs.findById('company:8'))._unsafeUnwrap();
    expect(doc?.cuis).toEqual([SERVABLE_CUI]);
  });

  it('PINS the open asymmetry: search still resolves a withheld id, the CUI-keyed reads do not', async () => {
    // Not an endorsement -- a pin. `searchEntities` keeps the guarded CNP
    // lookup because an existing test states that decision explicitly, while
    // countByCui/listByCui refuse the key because they had no filter at all and
    // no decision behind them. Both behaviours are asserted here so that
    // whoever settles task #15 changes them together and cannot move one by
    // accident.
    const byPerson = await repo?.searchEntities(WITHHELD_CUI, { limit: 50 });
    expect((byPerson?._unsafeUnwrap() ?? []).map((r) => r.docId)).toContain('company:8');
    // ...and the identifier is still scrubbed from what comes back.
    const hit = (byPerson?._unsafeUnwrap() ?? []).find((r) => r.docId === 'company:8');
    expect(hit?.cuis).toEqual([SERVABLE_CUI]);
  });

  it('documentRepo.listByCui returns nothing for a withheld identifier', async () => {
    const repoDocs = makeDocumentRepo(db!);
    const rows = (await repoDocs.listByCui(WITHHELD_CUI, 50))._unsafeUnwrap();
    expect(rows).toEqual([]);
  });
});
