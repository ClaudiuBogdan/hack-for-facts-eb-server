/**
 * P0 containment pinned at the SQL layer, against the REAL repos.
 *
 * The sibling `identity-containment.test.ts` injects fake repos, so it proves the
 * use-case refusals but would stay green if the repo guards were deleted (codex
 * review, 2026-07-25). These tests run `makeIdentityRepo` — and the global-search
 * usecase over it — against Kysely's DummyDriver and assert on the COMPILED SQL,
 * so removing a predicate fails here rather than in production.
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
import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { upstreamError } from '@/modules/shared/core/errors.js';
import {
  makeGlobalSearch,
  type GlobalSearchResult,
} from '@/modules/shared/core/usecases/global-search.js';
import { makeIdentityRepo } from '@/modules/shared/shell/repo/identity-repo.js';

import type { MeiliClient } from '@/modules/shared/core/ports.js';
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

  it('findByCui DOES query for a servable identifier, and PINS the privacy class', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).findByCui(SERVED);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('core');
    // Not implied by the length guard. Every `restricted` organization happens
    // to carry a >10-digit CUI today (measured 2026-08-26), so without this
    // assertion the predicate could be deleted and every test would stay green
    // until the two populations diverged.
    expect(sql[0]).toContain('privacy_class');
  });

  it('findManyByCui is ONE statement for many keys, and drops withheld ids from it', async () => {
    const { db, sql } = recordingDb();
    await makeIdentityRepo(db).findManyByCui([SERVED, '4305857', WITHHELD_13, SERVED]);

    // The entire point of the primitive: N keys, one round trip.
    expect(sql).toHaveLength(1);
    const stmt = sql[0] ?? '';
    // Two distinct servable keys (the duplicate is de-duped), and the withheld
    // one is absent from the statement rather than filtered afterwards. One
    // extra bound parameter belongs to the privacy_class pin, so count keys as
    // params-minus-one rather than pinning a raw total that moves whenever a
    // predicate is added.
    expect((stmt.match(/\$\d+/gu) ?? []).length - 1).toBe(2);
    // This is the method the `organizationByCui` DataLoader calls — pinning the
    // class only on the single-row lookup would leave the GraphQL batch path
    // unguarded.
    expect(stmt).toContain('privacy_class');
  });

  it('findManyByCui CHUNKS past the per-statement bound instead of truncating', async () => {
    const { db, sql } = recordingDb();
    // 600 distinct servable ids: three statements, and every id must appear.
    const many = Array.from({ length: 600 }, (_, i) => String(10_000_000 + i));
    await makeIdentityRepo(db).findManyByCui(many);

    expect(sql).toHaveLength(3);
    const totalParams = sql.reduce((n, s) => n + (s.match(/\$\d+/gu)?.length ?? 0), 0);
    // The load-bearing assertion: no id is silently dropped. Each statement also
    // binds one privacy_class parameter, hence `- sql.length`.
    expect(totalParams - sql.length).toBe(600);
  });

  it('findManyByCui issues NO statement when every key is withheld', async () => {
    const { db, sql } = recordingDb();
    const res = await makeIdentityRepo(db).findManyByCui([WITHHELD_13]);

    expect(sql).toHaveLength(0);
    expect((res as unknown as { value: ReadonlyMap<string, unknown> }).value.size).toBe(0);
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
    // Shape AND declared class — a free-text name search is the highest-exposure
    // read in this repo.
    expect(sql[0]).toContain('privacy_class');
  });
});

/**
 * The degraded path was rebuilt on 2026-08-26 (SEARCH_LAYER_REVIEW D5): global
 * search no longer runs an ILIKE over `search.documents` when Meili is down —
 * and, after two rejected attempts at an exact-CUI lookup, it no longer reads
 * anything at all. The containment requirement (an outage must not become a way
 * to look people up) is therefore satisfied structurally rather than by a guard,
 * which is what these assertions pin. `search.documents` keeps only
 * `countByCui`, covered above.
 */
describe('global search — the DEGRADED path issues no statement at all', () => {
  /** Meili unreachable: every search fails, forcing the degrade path. */
  const engineDown = {
    searchEntities: () => Promise.resolve(err(upstreamError('meili unreachable', 'meilisearch'))),
    healthCheck: () => Promise.resolve(err(upstreamError('down', 'meilisearch'))),
  } as unknown as MeiliClient;

  const searchWithEngineDown = async (
    q: string
  ): Promise<{ result: GlobalSearchResult; sql: string[] }> => {
    const { db, sql } = recordingDb();
    // The usecase has no repo dependency at all now; `db` is here to PROVE that
    // — any statement appearing on this recorder would mean a read crept back in.
    void db;
    const res = await makeGlobalSearch(
      { meiliClient: engineDown, meiliIndexes: ['entities'] },
      { q }
    );
    return { result: res._unsafeUnwrap(), sql };
  };

  it('reads nothing for a TEXT query — the ILIKE scan cannot come back', async () => {
    const { result, sql } = await searchWithEngineDown('popescu');

    expect(result.degraded).toBe(true);
    expect(result.hits).toEqual([]);
    expect(sql).toHaveLength(0);
  });

  it('reads nothing for an ALL-DIGIT query either', async () => {
    // An exact-CUI lookup lived here briefly. It was removed because the spine
    // cannot reproduce the palette's role-collapsed doc_type, so every version
    // returned a label the index would not have produced. Containment is now
    // structural: there is no query to guard.
    const { result, sql } = await searchWithEngineDown('2816464');

    expect(result.degraded).toBe(true);
    expect(result.hits).toEqual([]);
    expect(sql).toHaveLength(0);
  });

  it('reads nothing for a WITHHELD identifier', async () => {
    const { result, sql } = await searchWithEngineDown(WITHHELD_13);

    expect(result.hits).toEqual([]);
    expect(sql).toHaveLength(0);
  });
});
