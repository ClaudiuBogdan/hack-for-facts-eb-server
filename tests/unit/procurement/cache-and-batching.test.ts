/**
 * A review finding pinned against regression, with no live DB and no mocking
 * library — a hand-rolled Kysely driver returns canned rows and records the SQL it
 * was asked to run: `modificationsForContracts` must cap PER CONTRACT. A single
 * global `limit CAP * ids.length` lets one modification-heavy parent eat the whole
 * budget and starve the later parents in the batch.
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

import { makeProcurementDetailRepo } from '@/modules/procurement/shell/repo/detail-repo.js';

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
