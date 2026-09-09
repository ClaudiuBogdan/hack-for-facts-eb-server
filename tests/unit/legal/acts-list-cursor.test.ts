/**
 * `listActs` refuses a forged cursor before binding it (review M41).
 *
 * The cursor keys are bound into typed casts (`::int` / `::date` for the
 * sort key, `::bigint` for the act id). A tampered key used to reach Postgres
 * and come back as a masked 500; `listRecentChanges` already validated its
 * keys up front. Compiled through a driver that executes nothing and records
 * statements, so a refused cursor is also proven to send no SQL.
 */
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { legalActsSpec } from '@/modules/legal/shell/filters/legal-acts.spec.js';
import { makeLegalActsRepo, validateActsCursorKeys } from '@/modules/legal/shell/repo/acts-repo.js';
import { buildNextCursor, fhashFor, type ProdDatabase } from '@/modules/shared/index.js';

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

describe('validateActsCursorKeys', () => {
  it('accepts a well-formed key pair per cast, and the null-sort sentinel', () => {
    expect(validateActsCursorKeys(['12', '5'], 'int')._unsafeUnwrap()).toEqual({
      sortKey: '12',
      actId: '5',
    });
    expect(validateActsCursorKeys(['-3', '5'], 'int').isOk()).toBe(true);
    expect(validateActsCursorKeys(['2024-01-31', '5'], 'date').isOk()).toBe(true);
    expect(validateActsCursorKeys(['Legea nr. 1/2000', '5'], 'text').isOk()).toBe(true);
    for (const cast of ['int', 'date', 'text'] as const) {
      expect(validateActsCursorKeys(['', '5'], cast).isOk()).toBe(true);
    }
  });

  it.each([
    [['abc', '5'], 'int', /non-integer sort key/u],
    [['1.5', '5'], 'int', /non-integer sort key/u],
    [['31/01/2024', '5'], 'date', /malformed date sort key/u],
    [['12', 'x'], 'int', /non-numeric act id/u],
    [['12', '5; drop table'], 'int', /non-numeric act id/u],
    [['12'], 'int', /sort key and an act id/u],
    [['12', '5', '7'], 'int', /sort key and an act id/u],
    [[], 'int', /sort key and an act id/u],
  ] as const)('refuses %j under cast %s', (keys, cast, message) => {
    const res = validateActsCursorKeys(keys, cast);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.type).toBe('InvalidInput');
      expect(res.error.message).toMatch(message);
    }
  });
});

describe('listActs with a forged cursor', () => {
  it('answers InvalidInput and sends no SQL', async () => {
    const { db, sql } = recordingDb();
    const repo = makeLegalActsRepo(db);
    const filter = {};
    const forged = buildNextCursor({
      sort: 'in_degree',
      dir: 'desc',
      fhash: fhashFor(legalActsSpec, filter),
      lastKeys: ['not-a-number', '5'],
    });
    const res = await repo.listActs({
      filter,
      sort: 'in_degree',
      dir: 'desc',
      page: { first: 10, after: forged },
    });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.type).toBe('InvalidInput');
    expect(sql).toEqual([]);
  });

  it('binds a well-formed cursor into the keyset predicate', async () => {
    const { db, sql } = recordingDb();
    const repo = makeLegalActsRepo(db);
    const filter = {};
    const cursor = buildNextCursor({
      sort: 'in_degree',
      dir: 'desc',
      fhash: fhashFor(legalActsSpec, filter),
      lastKeys: ['12', '5'],
    });
    const res = await repo.listActs({
      filter,
      sort: 'in_degree',
      dir: 'desc',
      page: { first: 10, after: cursor },
    });
    expect(res.isOk()).toBe(true);
    expect(sql.some((s) => s.includes('::int') && s.includes('::bigint'))).toBe(true);
  });
});
