/**
 * The procurement presence read (entity-360, review M/M10) is ONE statement,
 * every leg an indexed CUI lookup bounded by the presence cap, canonical rows
 * only, `privacy_class = 'public'` on every leg, cancelled direct acquisitions
 * excluded — and it answers "absent"
 * (null) for a CUI with no record at all. Compiled through a driver that
 * executes nothing and records statements; the row is fed back by a stub.
 */
import {
  DummyDriver,
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
  PRESENCE_COUNT_CAP,
  makeProcurementPresenceRepo,
} from '@/modules/procurement/shell/repo/presence-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

const dbAnswering = (
  row: Record<string, string> | undefined,
  captured: Captured[]
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: row === undefined ? [] : [row as R] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('not supported');
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
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const recordingOnly = (): { db: Kysely<ProdDatabase>; sql: string[] } => {
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

const row = (over: Partial<Record<string, string>> = {}): Record<string, string> => ({
  authority_procedures: '0',
  authority_contracts: '0',
  authority_direct_acquisitions: '0',
  supplier_contracts: '0',
  supplier_direct_acquisitions: '0',
  ...over,
});

describe('procurement presence SQL', () => {
  it('is one statement with five bounded, canonical, indexed CUI legs', async () => {
    const { db, sql } = recordingOnly();
    await makeProcurementPresenceRepo(db).presenceCounts('4305857');
    expect(sql).toHaveLength(1);
    const s = sql[0] ?? '';
    expect(s.match(/limit 10001/gu)).toHaveLength(5);
    expect(s).toContain('procurement.procedures p where p.authority_cui = $1');
    expect(s).toContain(
      'procurement.contracts c where c.authority_cui = $2 and c.is_canonical = true'
    );
    expect(s).toContain(
      "procurement.direct_acquisitions d where d.authority_cui = $3 and d.is_canonical = true and d.status <> 'cancelled'"
    );
    expect(s).toContain(
      'procurement.contracts c where c.supplier_cui = $4 and c.is_canonical = true'
    );
    expect(s).toContain(
      "procurement.direct_acquisitions d where d.supplier_cui = $5 and d.is_canonical = true and d.status <> 'cancelled'"
    );
  });

  it('answers absent (null) when no leg has a record', async () => {
    const captured: Captured[] = [];
    const res = await makeProcurementPresenceRepo(dbAnswering(row(), captured)).presenceCounts('1');
    expect(res._unsafeUnwrap()).toBeNull();
    expect(captured[0]?.parameters).toEqual(['1', '1', '1', '1', '1']);
  });

  it('maps the legs and caps counts past the presence cap', async () => {
    const res = await makeProcurementPresenceRepo(
      dbAnswering(
        row({
          authority_procedures: '12',
          authority_contracts: String(PRESENCE_COUNT_CAP + 1),
          supplier_direct_acquisitions: '3',
        }),
        []
      )
    ).presenceCounts('2');
    expect(res._unsafeUnwrap()).toEqual({
      asAuthority: { procedures: 12, contracts: PRESENCE_COUNT_CAP, directAcquisitions: 0 },
      asSupplier: { contracts: 0, directAcquisitions: 3 },
      capped: true,
    });
  });
});
