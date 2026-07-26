/**
 * Privacy regression for every member-speech repository path. These tests compile
 * and execute the real Kysely queries against a capturing driver so a future
 * removal of the public-row predicate fails without requiring a live database.
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (captured: Captured[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return { rows: [] };
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported in the capturing db');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

/**
 * The gate is STRICT equality, never `coalesce(privacy_class,'public')`.
 * `parliament.speeches.privacy_class` is `not null default 'public'` with a
 * 2-value CHECK (prod migration 20260701T171000), so the coalesce could never
 * fire — it only encoded a fail-open habit. Assert BOTH: the strict predicate is
 * present AND the fail-open form is gone.
 */
const expectPublicSpeechQueries = (queries: readonly Captured[]): void => {
  const reads = queries.filter((q) => !isCapabilityProbe(q));
  expect(reads.length).toBeGreaterThan(0);
  for (const query of reads) {
    expect(query.sql).toContain("s.privacy_class = 'public'");
    expect(query.sql).not.toContain('coalesce(s.privacy_class');
  }
};

/**
 * Capability probes are `limit 0` schema checks, not row reads: they prove a
 * relation/column is selectable before the repo dares emit a branch referencing it
 * (`parliament.speech_texts`, and the three additive canonical-stenogram columns on
 * `parliament.speeches`). They return no rows by construction, so they carry no
 * privacy gate — and requiring one would force the probe to reference columns it is
 * checking the existence of. Excluded here so the gate assertion below covers every
 * actual read and nothing else.
 */
const isCapabilityProbe = (query: Captured): boolean => /\blimit 0\b/u.test(query.sql);

describe('member speech repository privacy', () => {
  it('applies the public-row gate to offset rows and their total', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.listMemberSpeeches('1:2024:1', { page: 1, pageSize: 20 });

    expect(result.isOk()).toBe(true);
    expectPublicSpeechQueries(captured);
  });

  it('applies the public-row gate to cursor rows, total, and activity queries', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const cursorStart = captured.length;
    const cursor = await repo.listMemberSpeechesCursor('1:2024:1', { first: 20 }, {}, undefined);
    expect(cursor.isOk()).toBe(true);
    // `expectPublicSpeechQueries` drops the capability probes (speech_texts + the
    // canonical-stenogram columns) itself, so the whole captured slice can be asserted.
    expectPublicSpeechQueries(captured.slice(cursorStart));

    const activityStart = captured.length;
    const activity = await repo.memberSpeechActivity('1:2024:1', 2025, {}, undefined);
    expect(activity.isOk()).toBe(true);
    expectPublicSpeechQueries(captured.slice(activityStart));
  });

  it('returns full text only through a public, non-quarantined parent speech', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const result = await repo.getSpeechFullText('speech-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
    const query = captured.at(-1);
    expect(query?.sql).toContain('inner join parliament.speeches s');
    expect(query?.sql).toContain('s.quarantined = false');
    expect(query?.sql).toContain("s.privacy_class = 'public'");
    expect(query?.sql).not.toContain('coalesce(s.privacy_class');
    // The 1:1 transcript side table carries its OWN privacy_class (contract §6):
    // a restricted transcript must not be readable through a public parent.
    expect(query?.sql).toContain("t.privacy_class = 'public'");
  });
});
