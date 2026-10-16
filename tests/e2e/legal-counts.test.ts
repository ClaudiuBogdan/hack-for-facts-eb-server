/**
 * E2E — legal counts that must not depend on the page or list they ride on,
 * against a REAL Postgres.
 *
 * 1. I-19: an act's `versionCount` is the exact number of its document
 *    expressions. It used to be the length of a list capped at 200, so the
 *    Fiscal Code's 243 expressions read as 200.
 * 2. I-21: `moIssues` reported `total: 0` on a page past the end of a
 *    1,065-issue year, because the total was a window count over the page's
 *    own rows. Empty pages must not redefine the filtered population.
 *
 * The schema below is a MINIMAL SHAPE — the columns these reads touch, typed as
 * the module's db-schema declares them, not a replica of the scrapper's
 * migrations. Docker-guarded like the other e2e suites.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeMonitorulRepo } from '@/modules/legal/mo/repo.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { MonitorulRepo } from '@/modules/legal/mo/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

let container: StartedPostgreSqlContainer | undefined;
let db: Kysely<ProdDatabase> | undefined;
let mo: MonitorulRepo | undefined;
let acts: LegalActsRepo | undefined;
let dockerAvailable = false;

/** Report a missing runtime as SKIPPED rather than PASSED. */
const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

/** More expressions than the old 200 cap, to prove the count is not a list length. */
const EXPRESSIONS = 243;

const DDL = `
  drop schema if exists legal cascade;
  create schema legal;
  create table legal.act_documents (
    document_id text primary key,
    act_id bigint not null,
    version_kind text not null default 'consolidare',
    version_date date,
    is_canonical boolean not null default false,
    den text,
    title text,
    issuer_raw text,
    publication_raw text,
    entry_into_force date,
    first_publication_date date,
    status_markers text[],
    extraction_status text,
    compatibility_tier text,
    mo_part text,
    mo_number text,
    mo_date date
  );
  create table legal.mo_issues (
    mo_issue_id bigint primary key,
    part_code text not null,
    mo_part smallint,
    issue_label text not null,
    issue_number integer,
    issue_suffix text not null default '',
    issue_year smallint not null,
    issue_date date,
    pdf_url text,
    pdf_bytes bigint,
    has_archive_index boolean not null default false,
    has_emonitor_link boolean not null default false,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    privacy_class text not null default 'public'
      check (privacy_class in ('public','restricted'))
  );
`;

const SEED = `
  insert into legal.act_documents (document_id, act_id)
    select 'doc-' || g, 66150 from generate_series(1, ${String(EXPRESSIONS)}) g;
  insert into legal.act_documents (document_id, act_id) values ('other', 7);
  insert into legal.mo_issues (mo_issue_id, part_code, mo_part, issue_label, issue_number, issue_year, issue_date)
    select g, 'PI', 1, g::text, g, 2026, date '2026-01-01' + g from generate_series(1, 5) g;
`;

beforeAll(async () => {
  if (!dockerCliUp()) {
    console.warn('Docker CLI unavailable — legal counts e2e SKIPPED.');
    return;
  }
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable — legal counts e2e SKIPPED: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  const connectionString = container.getConnectionUri();
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(DDL);
  await client.query(SEED);
  await client.end();

  db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  mo = makeMonitorulRepo(db);
  acts = makeLegalActsRepo(db);
  dockerAvailable = true;
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

const value = <T, E>(res: Result<T, E>): T => {
  expect(res.isOk()).toBe(true);
  return res._unsafeUnwrap();
};

describe('legal counts on real rows', () => {
  it("counts every one of an act's expressions, past the old 200 cap (I-19)", async () => {
    expect(value(await acts!.countDocuments('66150'))).toBe(EXPRESSIONS);
    expect(value(await acts!.countDocuments('7'))).toBe(1);
    expect(value(await acts!.countDocuments('999'))).toBe(0);
  });

  it("lists every one of an act's expressions, so the list length matches the count (I-19)", async () => {
    const docs = value(await acts!.listDocuments('66150'));
    expect(docs).toHaveLength(EXPRESSIONS);
    expect(new Set(docs.map((d) => d.documentId)).size).toBe(EXPRESSIONS);
  });

  it('keeps the issue total on a page past the end (I-21)', async () => {
    const first = value(
      await mo!.listIssues({ year: { eq: 2026 } }, { page: 1, pageSize: 2 }, 'issue_date_desc')
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    const beyond = value(
      await mo!.listIssues(
        { year: { eq: 2026 } },
        { page: 100_000, pageSize: 2 },
        'issue_date_desc'
      )
    );
    expect(beyond).toEqual({ items: [], total: 5 });
  });
});
