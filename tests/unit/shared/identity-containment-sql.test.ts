/**
 * P0 containment pinned at the SQL layer, against the REAL repos.
 *
 * The sibling `identity-containment.test.ts` injects fake repos, so it proves the
 * use-case refusals but would stay green if the repo guards were deleted (codex
 * review, 2026-07-25). These tests run `makeIdentityRepo` / `makeSearchRepo`
 * against Kysely's DummyDriver and assert on the COMPILED SQL, so removing a
 * predicate fails here rather than in production.
 *
 * DummyDriver executes nothing and returns no rows — that is precisely what makes
 * "issued no query at all" an observable, assertable property.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeIdentityRepo } from '@/modules/shared/shell/repo/identity-repo.js';
import { makeSearchRepo } from '@/modules/shared/shell/repo/search-repo.js';

import type { ProdDatabase } from '@/modules/shared/shell/db/types.js';

const WITHHELD_13 = '9999999999999';
const SERVED = '2816464';

/** A Kysely that compiles but never executes, capturing every statement. */
const recordingDb = (): { db: Kysely<ProdDatabase>; sql: string[] } => {
  const captured: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') captured.push(event.query.sql);
    },
  });
  return { db, sql: captured };
};

describe('identity repo — containment is in the SQL, not just the use case', () => {
  it('findByCui issues NO statement for a withheld identifier', async () => {
    const { db, sql } = recordingDb();
    const res = await makeIdentityRepo(db).findByCui(WITHHELD_13);

    expect(res.isOk()).toBe(true);
    expect((res as unknown as { value: unknown }).value).toBeNull();
    // Not "returns null after querying" — it must never reach the database.
    expect(sql).toHaveLength(0);
  });

  it('findByCui DOES query for a servable identifier', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).findByCui(SERVED);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('core');
  });

  it('territoryForCui issues NO statement for a withheld identifier', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).territoryForCui(WITHHELD_13);
    expect(sql).toHaveLength(0);
  });

  it('getIdentifiers joins the spine and filters — an opaque org_id must not bypass the gate', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).getIdentifiers('123');

    expect(sql).toHaveLength(1);
    const stmt = sql[0] ?? '';
    expect(stmt).toContain('organizations');
    expect(stmt).toContain('length');
  });

  it('searchByName excludes withheld rows in SQL (not after the scan cap)', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).searchByName('popescu', 10);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('length');
  });
});

describe('search repo — the degraded path cannot serve a person-only document', () => {
  it('searchEntities requires at least one servable cui, or none at all', async () => {
    const { db, sql } = recordingDb();
    await makeSearchRepo(db).searchEntities('popescu', { limit: 10 });

    expect(sql).toHaveLength(1);
    const stmt = sql[0] ?? '';
    // Keyed-to-nobody-servable docs are excluded; CUI-less docs stay searchable.
    expect(stmt).toContain('cardinality');
    expect(stmt).toContain('length');
  });

  it('an all-digit query still reaches the cui branch (the CNP lookup path exists and is guarded)', async () => {
    const { db, sql } = recordingDb();
    await makeSearchRepo(db).searchEntities(WITHHELD_13, { limit: 10 });

    const stmt = sql[0] ?? '';
    expect(stmt).toContain('any(cuis)');
    expect(stmt).toContain('cardinality');
  });
});
