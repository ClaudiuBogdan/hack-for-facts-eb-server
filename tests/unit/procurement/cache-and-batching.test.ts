/**
 * Two review findings, pinned against regression, with no live DB and no mocking
 * library — a hand-rolled Kysely driver returns canned rows and records the SQL it
 * was asked to run.
 *
 *  1. The scope cache must key on `spendGrains` (it decides whether money is summed
 *     or nulled), and must NOT memoize at all when the gate watermark is unreadable
 *     — a null watermark collapses distinct gate snapshots onto one key.
 *  2. `modificationsForContracts` must cap PER CONTRACT. A single global
 *     `limit CAP * ids.length` lets one modification-heavy parent eat the whole
 *     budget and starve the later parents in the batch.
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

import { makeProcurementAggregateRepo } from '@/modules/procurement/shell/repo/aggregate-repo.js';
import { makeProcurementDetailRepo } from '@/modules/procurement/shell/repo/detail-repo.js';
import { makeScopeCache } from '@/modules/procurement/shell/scope-cache.js';

import type { ProcurementGrain } from '@/modules/procurement/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

// ── an in-memory Kysely: canned rows in, executed SQL out ─────────────────────

interface Recorder {
  readonly sql: string[];
  /** Rows to return, chosen by a substring match on the compiled SQL. */
  rowsFor: (sql: string) => Record<string, unknown>[];
}

const makeFakeDb = (recorder: Recorder): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.sql.push(compiled.sql);
      return Promise.resolve({ rows: recorder.rowsFor(compiled.sql) as R[] });
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

const BOTH_GRAINS: readonly ProcurementGrain[] = ['direct_acquisition', 'procurement_contract'];
const DA_ONLY: readonly ProcurementGrain[] = ['direct_acquisition'];

/** Rows for the three statements `scopeStats` issues, plus the gate watermark. */
const statsRows =
  (watermark: string | null) =>
  (sql: string): Record<string, unknown>[] => {
    if (sql.includes('refreshed_at')) {
      return watermark === null ? [] : [{ refreshed_at: watermark }];
    }
    if (sql.includes('count(distinct')) return [{ n: '5' }];
    if (sql.includes('group by source_grain')) {
      return [
        {
          source_grain: 'direct_acquisition',
          flow_count: '10',
          amount_ron_sum: '100.00',
          first_flow_date: '2020-01-01',
          last_flow_date: '2024-01-01',
        },
      ];
    }
    return [];
  };

const countStatsQueries = (sql: readonly string[]): number =>
  sql.filter((s) => s.includes('group by source_grain')).length;

describe('scope cache: the gate watermark and spendGrains are load-bearing key parts', () => {
  it('caches when the watermark reads, serving the second call without re-querying', async () => {
    const recorder: Recorder = { sql: [], rowsFor: statsRows('2026-06-29 07:26:59+00') };
    const repo = makeProcurementAggregateRepo(makeFakeDb(recorder), makeScopeCache());

    const first = await repo.scopeStats({}, BOTH_GRAINS, DA_ONLY);
    const second = await repo.scopeStats({}, BOTH_GRAINS, DA_ONLY);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(countStatsQueries(recorder.sql)).toBe(1);
  });

  it('does NOT cache when the watermark is unreadable — an unkeyable snapshot is served live', async () => {
    const cache = makeScopeCache();
    const recorder: Recorder = { sql: [], rowsFor: statsRows(null) };
    const repo = makeProcurementAggregateRepo(makeFakeDb(recorder), cache);

    await repo.scopeStats({}, BOTH_GRAINS, DA_ONLY);
    await repo.scopeStats({}, BOTH_GRAINS, DA_ONLY);
    // Both calls hit the DB, and nothing was memoized under a null key.
    expect(countStatsQueries(recorder.sql)).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('a different spendGrains set is a DIFFERENT entry — a spend-allowed sum never outlives its gate', async () => {
    const recorder: Recorder = { sql: [], rowsFor: statsRows('2026-06-29 07:26:59+00') };
    const repo = makeProcurementAggregateRepo(makeFakeDb(recorder), makeScopeCache());

    // Same query, same scope, same grains — only the gate's spend verdict differs.
    await repo.scopeStats({}, BOTH_GRAINS, DA_ONLY);
    await repo.scopeStats({}, BOTH_GRAINS, []);
    expect(countStatsQueries(recorder.sql)).toBe(2);
  });

  it('an entity scope is never cached (unbounded key space)', async () => {
    const cache = makeScopeCache();
    const recorder: Recorder = { sql: [], rowsFor: statsRows('2026-06-29 07:26:59+00') };
    const repo = makeProcurementAggregateRepo(makeFakeDb(recorder), cache);

    await repo.scopeStats({ supplierCui: '11805367' }, BOTH_GRAINS, DA_ONLY);
    await repo.scopeStats({ supplierCui: '11805367' }, BOTH_GRAINS, DA_ONLY);
    expect(countStatsQueries(recorder.sql)).toBe(2);
    expect(cache.size()).toBe(0);
  });
});

describe('modificationsForContracts caps PER CONTRACT, not across the batch', () => {
  const compileBatch = async (ids: readonly string[]): Promise<string> => {
    const recorder: Recorder = { sql: [], rowsFor: () => [] };
    const repo = makeProcurementDetailRepo(makeFakeDb(recorder));
    const result = await repo.modificationsForContracts(ids);
    expect(result.isOk()).toBe(true);
    return recorder.sql[0] ?? '';
  };

  it('ranks within each parent with a window function', async () => {
    const sql = await compileBatch(['1592679', '1593075']);
    expect(sql).toMatch(/row_number\(\)\s*over\s*\(/iu);
    expect(sql).toMatch(/partition by\s+m\.contract_id/iu);
  });

  it('orders the trail chronologically inside each parent', async () => {
    const sql = await compileBatch(['1592679']);
    expect(sql).toMatch(
      /order by\s+m\.modification_date\s+asc\s+nulls\s+last,\s+m\.modification_id\s+asc/iu
    );
  });

  it('never emits a single global row budget scaled by the batch size', async () => {
    // The old form was `order by contract_id ... limit CAP * ids.length`, which let
    // contract 1592679 (390 modifications live) consume the batch and starve 1593075.
    const sql = await compileBatch(['191354', '204043', '1592679', '1593075']);
    expect(sql).not.toMatch(/limit\s+\$?\d*800/iu);
    // The only bound is the per-parent rank predicate.
    expect(sql).toMatch(/"rn"\s*<=/iu);
  });

  it('an empty batch issues no query at all', async () => {
    const recorder: Recorder = { sql: [], rowsFor: () => [] };
    const repo = makeProcurementDetailRepo(makeFakeDb(recorder));
    const result = await repo.modificationsForContracts([]);
    expect(result._unsafeUnwrap().size).toBe(0);
    expect(recorder.sql).toHaveLength(0);
  });
});
