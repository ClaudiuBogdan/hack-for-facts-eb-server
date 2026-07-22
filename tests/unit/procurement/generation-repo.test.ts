/**
 * Generation ledger reader over a hand-rolled Kysely driver (canned rows in,
 * executed SQL out — no mocking library):
 *
 *  - the `quality` jsonb is parsed grain by grain, fail-safe (unknown classes
 *    dropped so the grain abstains), with the spend-class widening;
 *  - single-flight micro-cache: a concurrent burst issues ONE statement,
 *    TTL-driven via an injected clock, follows the authoritative active pointer
 *    for intentional rollback, errors never cached.
 *
 * The analytics reads themselves live in ClickHouse now (see
 * clickhouse-analysis-repo.ts); Postgres keeps only the generation ledger.
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

import { makeProcurementGenerationRepo } from '@/modules/procurement/shell/repo/generation-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

// ── the recording fake driver ───────────────────────────────────────────────────

interface Recorded {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

interface Recorder {
  readonly queries: Recorded[];
  /** Rows to return, chosen by a substring match on the compiled SQL. May throw. */
  rowsFor: (sql: string) => Record<string, unknown>[];
}

const makeFakeDb = (recorder: Recorder): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      // A microtask hop so concurrent callers genuinely overlap.
      await Promise.resolve();
      return { rows: recorder.rowsFor(compiled.sql) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] };
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

const generationRow = (buildId: string): Record<string, unknown> => ({
  build_id: buildId,
  published_at: '2026-07-12T00:00:00Z',
  quality: {},
  matrix_hash: 'h',
});

const generationQueries = (recorder: Recorder): Recorded[] =>
  recorder.queries.filter((q) => q.sql.includes('analysis_generations'));

describe('raw quality jsonb parsing (fail-safe, spend-class widening)', () => {
  const rawVerdict = (spend: string): Record<string, unknown> => ({
    coverage: { date: 0.97, value: 0.99, geo: 0.9, cpv: 0.95 },
    classes: { spend, time: 'allow', geo: 'allow' },
  });

  it("accepts 'allow' AND 'allow_disclosed'; DROPS an unknown spend class", async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => [
        {
          ...generationRow('50'),
          quality: {
            direct_acquisition: rawVerdict('allow'),
            procedure: rawVerdict('allow_disclosed'),
            // a future/unknown class must be dropped, not admitted — the
            // grain then abstains ('no quality verdict'), the fail-safe.
            contract: rawVerdict('partial'),
          },
        },
      ],
    };
    const repo = makeProcurementGenerationRepo(makeFakeDb(recorder), () => 0);
    const gen = (await repo.activeGeneration())._unsafeUnwrap();
    expect(gen?.quality.direct_acquisition?.classes.spend).toBe('allow');
    expect(gen?.quality.procedure?.classes.spend).toBe('allow_disclosed');
    expect(gen?.quality.contract).toBeUndefined();
    // matrix_hash rides through as informational passthrough.
    expect(gen?.matrixHash).toBe('h');
  });
});

describe('generation micro-cache', () => {
  it('single-flights a concurrent burst into ONE statement and caches the result', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => [generationRow('42')] };
    const repo = makeProcurementGenerationRepo(makeFakeDb(recorder), () => 0);

    const results = await Promise.all([
      repo.activeGeneration(),
      repo.activeGeneration(),
      repo.activeGeneration(),
    ]);
    for (const r of results) expect(r._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(1);

    // Within the TTL: served from cache, still one statement.
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(1);
  });

  it('refreshes after the TTL and follows an intentional active-generation rollback', async () => {
    let clock = 0;
    let nextBuild = '43';
    const recorder: Recorder = { queries: [], rowsFor: () => [generationRow(nextBuild)] };
    const repo = makeProcurementGenerationRepo(makeFakeDb(recorder), () => clock);

    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('43');

    // The active row is authoritative: operators retain N-1 specifically so
    // they can reactivate it when the current generation must be rolled back.
    clock = 10_000;
    nextBuild = '42';
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(2);

    // A genuinely newer build wins.
    clock = 20_000;
    nextBuild = '44';
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('44');
  });

  it('serves ok(null) when unpublished and never caches an errored refresh', async () => {
    let fail = true;
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        if (fail) throw new Error('boom');
        return [];
      },
    };
    const repo = makeProcurementGenerationRepo(makeFakeDb(recorder), () => 0);

    expect((await repo.activeGeneration()).isErr()).toBe(true);
    fail = false;
    expect((await repo.activeGeneration())._unsafeUnwrap()).toBeNull();
    // Both calls hit the DB — the error was not memoized.
    expect(generationQueries(recorder)).toHaveLength(2);
  });
});
