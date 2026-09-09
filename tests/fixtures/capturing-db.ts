/**
 * A Kysely instance over a driver that CAPTURES every compiled query instead of
 * running it: the compiled-SQL pin tests build a repo over it and assert on the
 * SQL text and parameters. `respond` decides what rows a query returns (or
 * throws to simulate a driver failure); the default is no rows. One fixture for
 * the fourteen copies the parliament and budget suites used to carry (T-16).
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

import type { ProdDatabase } from '@/modules/shared/index.js';

export interface CapturedQuery {
  sql: string;
  parameters: readonly unknown[];
}

export interface CapturingDbOptions {
  /** Rows for a query, keyed on its SQL / parameters; throw to fail the query. */
  readonly respond?: (sql: string, parameters: readonly unknown[]) => readonly unknown[];
}

export const makeCapturingDb = <DB = ProdDatabase>(
  captured: CapturedQuery[],
  options: CapturingDbOptions = {}
): Kysely<DB> => {
  const respond = options.respond ?? (() => []);
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      try {
        return Promise.resolve({ rows: respond(query.sql, query.parameters) as R[] });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
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
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};
