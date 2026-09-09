/**
 * Privacy gate of the kernel territory repo, pinned at the SQL layer.
 *
 * Five of the six `core.territories` reads carried no `privacy_class`
 * predicate (only the raw-SQL map anchor read did). All rows are public today,
 * but the platform gates on class, not on the current distribution: a
 * restricted territory must not surface as a filter anchor, a county/region
 * list entry, or a search hit. Compiled through a driver that executes nothing.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  makeTerritoryRepo,
  readPublicTerritoriesByIds,
} from '@/modules/shared/shell/repo/territory-repo.js';

import type { ProdDatabase } from '@/modules/shared/shell/db/types.js';

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
      if (event.level === 'query') captured.push(event.query.sql.replace(/\s+/gu, ' '));
    },
  });
  return { db, sql: captured };
};

const GATE = '"privacy_class" = $';

describe('territory repo — every read pins privacy_class = public', () => {
  it.each([
    [
      'byTerritorialSiruta',
      (db: Kysely<ProdDatabase>) => makeTerritoryRepo(db).byTerritorialSiruta('54975'),
    ],
    ['byCounty', (db: Kysely<ProdDatabase>) => makeTerritoryRepo(db).byCounty('CJ')],
    ['searchUat', (db: Kysely<ProdDatabase>) => makeTerritoryRepo(db).searchUat('cluj', 10)],
    ['listCounties', (db: Kysely<ProdDatabase>) => makeTerritoryRepo(db).listCounties()],
    ['listRegions', (db: Kysely<ProdDatabase>) => makeTerritoryRepo(db).listRegions()],
    [
      'readPublicTerritoriesByIds',
      (db: Kysely<ProdDatabase>) => readPublicTerritoriesByIds(db, [1, 2]),
    ],
  ])('%s', async (_name, run) => {
    const { db, sql } = recordingDb();
    const res = await run(db);
    expect(res.isOk()).toBe(true);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('"core"."territories"');
    expect(sql[0]).toContain(GATE);
  });

  it('searchUat issues no statement for an empty query', async () => {
    const { db, sql } = recordingDb();
    const res = await makeTerritoryRepo(db).searchUat('   ', 10);
    expect(res._unsafeUnwrap()).toEqual([]);
    expect(sql).toHaveLength(0);
  });
});
