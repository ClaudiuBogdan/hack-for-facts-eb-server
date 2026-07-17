/**
 * Test helpers — compile kernel SQL conditions to a {sql, parameters} pair for
 * snapshot assertions without a live DB (Kysely + DummyDriver compiler).
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';

import { composeWhere } from '@/modules/shared/shell/filters/composer.js';

import type { SqlCondition } from '@/modules/shared/shell/filters/types.js';

const compiler = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export interface CompiledSql {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Compile a single condition to SQL + params. */
export const compileCondition = (condition: SqlCondition): CompiledSql => {
  const compiled = condition.compile(compiler);
  return { sql: compiled.sql, parameters: compiled.parameters };
};

/** Compile a list of conditions joined as a WHERE clause. */
export const compileWhere = (conditions: readonly SqlCondition[]): CompiledSql => {
  const where = composeWhere(...conditions);
  if (where === undefined) return { sql: '', parameters: [] };
  const compiled = where.compile(compiler);
  return { sql: compiled.sql, parameters: compiled.parameters };
};

export { sql };
