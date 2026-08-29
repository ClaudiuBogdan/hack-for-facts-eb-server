/**
 * E2E — `makeSearchRepo(db)` against a real Postgres
 * (testcontainer) with a minimal `search.documents` table.
 *
 * The shared e2e setup (`tests/e2e/setup.ts`) starts the LEGACY budget/user
 * schema container, which has no `search.*` schema. This repo is part of the
 * prod serving DB, so the test stands up its OWN container with just the columns
 * these reads touch — matching `SearchDocuments` in
 * `src/modules/shared/shell/db/types.ts`.
 *
 * Docker-guarded: when Docker is unavailable the suite SKIPS cleanly (the shared
 * setup-file pattern), never fails.
 *
 * Covers `countByCui` and the withheld-identifier gate across every remaining
 * read path over `search.documents`. The `searchEntities` suites were removed
 * with the method itself on 2026-08-26 (SEARCH_LAYER_REVIEW_2026-08-25.md D5) —
 * the outage path no longer reads this table.
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
  // The two `searchEntities` cases here went with the method (2026-08-26, D5).
  // They asserted row-level containment over `search.documents` on the degrade
  // path; that path no longer reads this table at all.

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

  // THE ASYMMETRY THIS SUITE USED TO PIN IS CLOSED (2026-08-26).
  //
  // It pinned that search resolved a withheld identifier while the CUI-keyed
  // reads refused it — row-level containment on one path, identifier-level on
  // the others — and asked whoever settled the question to move them together.
  // Removing the ILIKE degrade path settled it by construction: the outage path
  // is now `identityRepo.findByCui`, which refuses a withheld id BEFORE issuing
  // any statement, so every read path is identifier-level. That also makes the
  // degrade path agree with the primary one, where the palette physically
  // withholds over-length CUIs from the index (P0A) and Meili could never have
  // resolved one — the asymmetry existed only because the fallback read a
  // different store.
  //
  // The replacement assertion is a unit test, because there is no longer any SQL
  // to observe here: "the DEGRADED path cannot serve a person-only identity" in
  // tests/unit/shared/identity-containment-sql.test.ts asserts that ZERO
  // statements are issued for a withheld identifier.

  it('documentRepo.listByCui returns nothing for a withheld identifier', async () => {
    const repoDocs = makeDocumentRepo(db!);
    const rows = (await repoDocs.listByCui(WITHHELD_CUI, 50))._unsafeUnwrap();
    expect(rows).toEqual([]);
  });
});
