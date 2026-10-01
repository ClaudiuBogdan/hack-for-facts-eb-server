/**
 * The registry invariant behind supplier geography, over a hand-rolled Kysely
 * driver (canned rows in, executed SQL out — no mocking library): the kernel's
 * own predicates, a NULL class counted as a violation, fail closed on error,
 * a verified answer kept for its TTL, a failed read never kept.
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

import {
  makeSupplierGeographyPolicy,
  SUPPLIER_GEOGRAPHY_POLICY_TTL_MS,
} from '@/modules/procurement/shell/repo/supplier-geography-policy.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const fakeDb = (answer: () => Record<string, unknown>[]) => {
  const sqls: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      sqls.push(compiled.sql);
      return Promise.resolve({ rows: answer() as R[] });
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
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, sqls };
};

describe('supplier geography policy', () => {
  it('holds when no servable identifier is non-public, with the kernel predicates', async () => {
    const { db, sqls } = fakeDb(() => []);
    const policy = makeSupplierGeographyPolicy(db);
    expect((await policy.supplierGeographyPublic())._unsafeUnwrap()).toBe(true);
    expect(sqls[0]).toContain('from "core"."organizations" as "o"');
    // organizationIdentifierIsServable + a NOT-public class that keeps NULL a violation.
    expect(sqls[0]).toMatch(/length\("o"\."cui"\) <= 10/u);
    expect(sqls[0]).toContain('"o"."privacy_class" = $1) is not true');
  });

  it('fails when a servable identifier is not public', async () => {
    const { db } = fakeDb(() => [{ violation: true }]);
    expect((await makeSupplierGeographyPolicy(db).supplierGeographyPublic())._unsafeUnwrap()).toBe(
      false
    );
  });

  it('keeps a verified answer for its TTL, and never keeps a failed read', async () => {
    let clock = 0;
    let fail = true;
    const { db, sqls } = fakeDb(() => {
      if (fail) throw new Error('down');
      return [];
    });
    const policy = makeSupplierGeographyPolicy(db, () => clock);
    expect((await policy.supplierGeographyPublic()).isErr()).toBe(true);
    fail = false;
    expect((await policy.supplierGeographyPublic())._unsafeUnwrap()).toBe(true);
    clock = SUPPLIER_GEOGRAPHY_POLICY_TTL_MS - 1;
    await policy.supplierGeographyPublic();
    expect(sqls).toHaveLength(2);
    clock = SUPPLIER_GEOGRAPHY_POLICY_TTL_MS + 1;
    await policy.supplierGeographyPublic();
    expect(sqls).toHaveLength(3);
  });
});
