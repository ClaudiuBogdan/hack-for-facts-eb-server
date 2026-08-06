/**
 * E2E — the committee-documents and committee-bills reads against a REAL
 * Postgres, for the two properties a SQL-text assertion cannot establish.
 *
 * 1. THE PRIVACY GATE. The platform stores restricted data deliberately and
 *    withholds it HERE; `privacy_class` is `not null` with a
 *    `check (… in ('public','restricted'))`. Every committee row is `public` on
 *    Chronos today (94,200 of 94,200), so a live test cannot discriminate and a
 *    string assertion only proves the predicate was typed, not that it filters.
 *    These rows are the discriminating case the production data does not have.
 *
 * 2. THE LINK FAN-OUT. `committee_bill_links` is keyed
 *    (committee_document_key, source_bill_scheme, source_bill_value,
 *    source_bill_year_key), so ONE document may carry SEVERAL link rows. A join
 *    would emit that document twice with an identical (ord, key) cursor —
 *    duplicating a node, making billKey arbitrary, and skipping a row at a page
 *    boundary while `total` counted the document once. Zero documents carry two
 *    link rows on Chronos today; that is DATA, and the keyset must not depend on
 *    it. Only real rows through the real query can prove the resolution is 1:1.
 *
 * The schema below is a MINIMAL SHAPE — the columns these two reads touch, typed
 * as `src/modules/parliament/shell/db/schema.ts` declares them. It is not a
 * replica of the scrapper's migrations (those live in the other repo and are not
 * importable here), so it proves the QUERY's behaviour, not DDL fidelity.
 *
 * Docker-guarded: skips cleanly when no container runtime is reachable, the same
 * contract `search-repo-entities.test.ts` follows.
 */

import { execSync } from 'node:child_process';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { COMMITTEE_LINKED_BILLS_CAP } from '@/modules/parliament/core/usecases.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
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
let repo: ParliamentRepo | undefined;
let dockerAvailable = false;

/** Report a missing runtime as SKIPPED rather than PASSED. */
const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

const COMMITTEE = 'senate:privacy-fixture';
const OTHER_COMMITTEE = 'senate:other-fixture';

const DDL = `
  drop schema if exists parliament cascade;
  create schema parliament;
  create table parliament.bills (
    bill_key text primary key,
    plx_number text, plx_year integer, senate_number text, senate_year integer,
    title text, final_law_number text, final_law_year integer,
    decision_chamber text,
    is_canonical boolean not null default true,
    canonical_bill_key text,
    attrs jsonb not null default '{}'::jsonb,
    source_updated_at timestamptz,
    updated_at timestamptz not null default now()
  );
  create table parliament.committee_documents (
    committee_document_key text primary key,
    committee_key text,
    doc_type text,
    doc_date date,
    title text,
    document_url text,
    source_url text not null,
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
  create table parliament.committee_bill_links (
    committee_document_key text not null,
    source_bill_scheme text not null,
    source_bill_value text not null,
    source_bill_year_key text not null,
    bill_key text,
    resolution_status text not null,
    source_url text not null,
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted')),
    primary key (committee_document_key, source_bill_scheme, source_bill_value, source_bill_year_key)
  );
  create table parliament.bill_step_links (
    bill_step_link_id serial primary key,
    bill_key text not null,
    position integer not null,
    step_position integer not null,
    link_kind text not null,
    target_key text,
    source_href text not null,
    resolution_status text not null,
    match_method text not null default 'guid',
    resolver_version text not null default 'test',
    evidence jsonb not null default '{}'::jsonb
  );
`;

const seed = async (client: pg.Client): Promise<void> => {
  await client.query(`
    insert into parliament.bills (bill_key, title, is_canonical, canonical_bill_key) values
      ('bill-public',    'Lege publică',    true,  null),
      ('bill-linked',    'Lege legată',     true,  null),
      ('bill-twin',      'Geamăn suprimat', false, 'bill-linked'),
      ('bill-restricted','Lege restricted', true,  null);
  `);

  await client.query(
    `insert into parliament.committee_documents
       (committee_document_key, committee_key, doc_type, doc_date, title, document_url, source_url, privacy_class)
     values
       -- Plain public document, dated.
       ('doc-public',      $1, 'raport', '2026-03-14', 'Raport public',  null, 'https://s.test/1', 'public'),
       -- RESTRICTED: must never appear in rows, in the total, or via its link.
       ('doc-restricted',  $1, 'raport', '2026-03-13', 'Raport intern',  null, 'https://s.test/2', 'restricted'),
       -- Public document whose ONLY link row is restricted: the document stays
       -- visible, but billKey must be null rather than leaking the linked bill.
       ('doc-link-restr',  $1, 'aviz',   '2026-03-12', 'Aviz cu link restrâns', null, 'https://s.test/3', 'public'),
       -- Public document with TWO public link rows (the PK permits it).
       ('doc-two-links',   $1, 'aviz',   null,         'Aviz cu două linkuri',  null, 'https://s.test/4', 'public'),
       -- A second committee, to prove the total is committee-scoped.
       ('doc-other',       $2, 'raport', '2026-01-01', 'Alt raport',     null, 'https://s.test/5', 'public')`,
    [COMMITTEE, OTHER_COMMITTEE]
  );

  await client.query(`
    insert into parliament.committee_bill_links
      (committee_document_key, source_bill_scheme, source_bill_value, source_bill_year_key,
       bill_key, resolution_status, source_url, privacy_class)
    values
      -- The restricted document's link is itself public: the DOCUMENT's class is
      -- what must exclude it from the bills union, not the link's.
      ('doc-restricted', 'plx', '1', '2026', 'bill-restricted', 'linked', 'https://s.test/2', 'public'),
      -- A restricted LINK on a public document.
      ('doc-link-restr', 'plx', '2', '2026', 'bill-restricted', 'linked', 'https://s.test/3', 'restricted'),
      -- Two public link rows on ONE document — the fan-out case. The second
      -- points at a SUPPRESSED twin, so the coalesce must resolve it to the
      -- canonical key rather than serving the twin.
      ('doc-two-links', 'plx', '3', '2026', 'bill-public', 'linked', 'https://s.test/4', 'public'),
      ('doc-two-links', 'senate', '3', '2026', 'bill-twin', 'linked', 'https://s.test/4', 'public');
  `);

  // A referral step-link arm for the bills union, on the same committee.
  await client.query(
    `insert into parliament.bill_step_links
       (bill_key, position, step_position, link_kind, target_key, source_href, resolution_status)
     values ('bill-linked', 1, 1, 'committee', $1, 'https://s.test/ref', 'linked')`,
    [COMMITTEE]
  );
};

const resolveConnection = async (): Promise<string | undefined> => {
  const external = process.env['E2E_PARLIAMENT_PG_URL'];
  if (external !== undefined && external !== '') return external;
  if (!dockerCliUp()) {
    console.warn('Docker CLI unavailable — parliament committee-documents e2e SKIPPED.');
    return undefined;
  }
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    return container.getConnectionUri();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable — parliament committee-documents e2e SKIPPED: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
};

beforeAll(async () => {
  const connectionString = await resolveConnection();
  if (connectionString === undefined) return;

  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(DDL);
  await seed(client);
  await client.end();

  db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  repo = makeParliamentRepo(db);
  dockerAvailable = true;
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

describe('listCommitteeDocuments — privacy and one-bill-per-document, on real rows', () => {
  it('never serves a restricted document, in the rows OR in the total', async () => {
    const res = await repo!.listCommitteeDocuments(COMMITTEE, { first: 50 });
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;

    const keys = res.value.items.map((d) => d.committeeDocumentKey);
    expect(keys).not.toContain('doc-restricted');
    // Four seeded documents on this committee, one restricted → three visible.
    expect(keys).toHaveLength(3);
    // The total is measured under the SAME gate: a total of 4 would tell the
    // reader a document exists that the page will never show them.
    expect(res.value.total).toBe(3);
    // …and it is committee-scoped, not a table-wide count.
    expect(keys).not.toContain('doc-other');
  });

  it('keeps a public document whose only link is restricted, with billKey null', async () => {
    const res = await repo!.listCommitteeDocuments(COMMITTEE, { first: 50 });
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;

    const doc = res.value.items.find((d) => d.committeeDocumentKey === 'doc-link-restr');
    // Present: the DOCUMENT is public. Withholding it because a link is
    // restricted would hide a public act to protect a private edge.
    expect(doc).toBeDefined();
    expect(doc?.billKey).toBeNull();
  });

  it('emits a multi-link document ONCE, with a canonical, deterministic billKey', async () => {
    const res = await repo!.listCommitteeDocuments(COMMITTEE, { first: 50 });
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;

    const matches = res.value.items.filter((d) => d.committeeDocumentKey === 'doc-two-links');
    expect(matches).toHaveLength(1);
    // Both link rows resolve to 'bill-public' or, through the twin, to
    // 'bill-linked' — whichever is picked, it must be a CANONICAL key.
    expect(['bill-public', 'bill-linked']).toContain(matches[0]?.billKey);
    // Cursors stay 1:1 with the nodes; a fan-out would have produced two edges
    // sharing one (ord, key) and a page boundary that skips a row.
    expect(res.value.cursors).toHaveLength(res.value.items.length);
    expect(new Set(res.value.cursors).size).toBe(res.value.cursors.length);
  });

  it('pages the whole visible set without repeating or losing a row', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let draw = 0; draw < 10; draw += 1) {
      const page: Awaited<ReturnType<ParliamentRepo['listCommitteeDocuments']>> =
        await repo!.listCommitteeDocuments(COMMITTEE, {
          first: 1,
          ...(after !== undefined && { after }),
        });
      expect(page.isOk()).toBe(true);
      if (!page.isOk()) return;
      seen.push(...page.value.items.map((d) => d.committeeDocumentKey));
      // The total must not move as the keyset bound narrows the page — the trap
      // a `count(*) over ()` would fall into.
      expect(page.value.total).toBe(3);
      if (page.value.next === null) break;
      after = page.value.next;
    }
    expect(new Set(seen).size).toBe(3);
    expect(seen).not.toContain('doc-restricted');
  });
});

describe('listCommitteeLinkedBills — privacy on the document arm, on real rows', () => {
  it('excludes a bill reachable only through a restricted document', async () => {
    const res = await repo!.listCommitteeLinkedBills(COMMITTEE, COMMITTEE_LINKED_BILLS_CAP);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;

    const keys = res.value.bills.map((b) => b.billKey);
    // 'bill-restricted' is linked ONLY by doc-restricted (a restricted document)
    // and by doc-link-restr's restricted LINK. Neither may surface it.
    expect(keys).not.toContain('bill-restricted');
    // The referral step-link arm still serves its bill — the gate narrows the
    // document arm, it does not disable the union.
    expect(keys).toContain('bill-linked');
    expect(keys).toContain('bill-public');
    // The total is measured by the same statement, over the same predicate.
    expect(res.value.total).toBe(keys.length);
    expect(res.value.total).toBe(2);
  });
});
