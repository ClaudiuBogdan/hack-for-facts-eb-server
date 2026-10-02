/**
 * Companies analytics PostgreSQL reads over a hand-rolled Kysely driver
 * (canned rows in, executed SQL out): the privacy epoch is one fresh statement
 * per call — never cached — that also reports recovery and isolation; the
 * release rows carry their captured epoch (active view column, historical
 * manifest key) and stay micro-cached; failures never forward driver text.
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

import { makeAnalyticsReleaseSource } from '@/modules/companies/shell/analytics/postgres-sources.js';

import type { Logger, ProdDatabase } from '@/modules/shared/index.js';

interface Recorder {
  readonly queries: string[];
  rowsFor: (sql: string) => Record<string, unknown>[];
}

const makeFakeDb = (recorder: Recorder): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.queries.push(compiled.sql);
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

const releaseRow = (over: Record<string, unknown> = {}) => ({
  release_id: '7',
  publication_id: '107',
  published_at: '2026-10-02T18:00:00.000Z',
  schema_version: 'companies-analytics-ch-v1',
  population_policy_version: 'public-legal-person-v1',
  admission_policy_version: 'q1',
  admission_policy_sha256: 'a'.repeat(64),
  clickhouse_database: 'companies_analytics',
  company_table: 'company_r7',
  company_year_table: 'company_year_r7',
  input_snapshot_at: null,
  companies: '6',
  company_years: '9',
  privacy_epoch: '4',
  coverage: {},
  inputs: {},
  ...over,
});

const silentLogger = (lines: string[]): Logger => {
  const log = (obj: unknown, msg?: string) => {
    lines.push(JSON.stringify(obj) + (msg ?? ''));
  };
  return { info: log, warn: log, error: log, debug: log };
};

describe('companies analytics PostgreSQL sources', () => {
  it('reads the privacy epoch with a fresh statement on every call', async () => {
    let epoch = '4';
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => [{ epoch, in_recovery: false, isolation: 'read committed' }],
    };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    expect((await source.currentPrivacyEpoch())._unsafeUnwrap()).toEqual({
      epoch: '4',
      inRecovery: false,
      isolation: 'read committed',
    });
    epoch = '5';
    expect((await source.currentPrivacyEpoch())._unsafeUnwrap().epoch).toBe('5');
    expect(recorder.queries).toHaveLength(2);
    const sql = recorder.queries[0] ?? '';
    expect(sql).toContain('epoch::text as epoch');
    expect(sql).toContain('pg_is_in_recovery() as in_recovery');
    expect(sql).toContain("current_setting('transaction_isolation') as isolation");
    expect(sql).toContain('from companies_analytics.privacy_state');
    expect(sql).toContain('where singleton');
    // A plain read: no lock, no write.
    expect(sql).not.toMatch(/for (update|share)|insert|update |delete/iu);
  });

  it.each([
    ['no row', []],
    ['two rows', [{}, {}]],
    ['a malformed row', [{ epoch: 4, in_recovery: 'f', isolation: 'read committed' }]],
  ])('reports the privacy state as unreadable on %s', async (_label, rows) => {
    const recorder: Recorder = { queries: [], rowsFor: () => rows as Record<string, unknown>[] };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    expect((await source.currentPrivacyEpoch())._unsafeUnwrapErr()).toMatchObject({
      type: 'Database',
      message: 'companies analytics privacy state is unreadable',
    });
  });

  it('never forwards or logs driver text when the read fails', async () => {
    const lines: string[] = [];
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        throw new Error('permission denied for table privacy_state; host primary:5432 pw=x');
      },
    };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder), silentLogger(lines));
    const error = (await source.currentPrivacyEpoch())._unsafeUnwrapErr();
    expect(error.message).toBe('companies analytics privacy state is unreadable');
    expect(lines.join('\n')).not.toContain('permission denied');
    expect(lines.join('\n')).toContain('currentPrivacyEpoch');
  });

  it('carries the captured epoch on the active row, which stays micro-cached', async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: (sql) =>
        sql.includes('privacy_state')
          ? [{ epoch: '4', in_recovery: false, isolation: 'read committed' }]
          : [releaseRow()],
    };
    const now = 1_000;
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder), undefined, () => now);
    const first = (await source.activeRelease())._unsafeUnwrap();
    expect(first).toMatchObject({ releaseId: '7', active: true, privacyEpoch: '4' });
    await source.activeRelease();
    await source.currentPrivacyEpoch();
    await source.currentPrivacyEpoch();
    const releaseQueries = recorder.queries.filter((q) => q.includes('active_release'));
    expect(releaseQueries).toHaveLength(1);
    expect(releaseQueries[0]).toContain('privacy_epoch');
    expect(recorder.queries.filter((q) => q.includes('privacy_state'))).toHaveLength(2);
  });

  it('reads a historical release epoch from its manifest', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => [releaseRow({ release_id: '6' })] };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    const row = (await source.publishedRelease(6))._unsafeUnwrap();
    expect(row).toMatchObject({ releaseId: '6', active: false, privacyEpoch: '4' });
    expect(recorder.queries[0]).toContain("r.export_manifest ->> 'privacyEpoch' as privacy_epoch");
  });

  it('passes a missing epoch through as null for the parser to refuse', async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => [releaseRow({ privacy_epoch: null })],
    };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    expect((await source.activeRelease())._unsafeUnwrap()?.privacyEpoch).toBeNull();
  });
});
