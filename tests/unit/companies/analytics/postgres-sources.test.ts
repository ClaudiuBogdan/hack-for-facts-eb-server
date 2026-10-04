/**
 * Companies analytics PostgreSQL reads over a hand-rolled Kysely driver
 * (canned rows in, executed SQL out): the privacy epoch and the current ONRC
 * publication are ONE fresh statement per call — never cached — that also
 * reports recovery and isolation; the release rows carry their captured epoch
 * (active view column, historical manifest key) and stay micro-cached;
 * failures never forward driver text; no label reads `registrations`.
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

import { companyAnalysisRecords } from '@/modules/companies/core/analytics-usecases.js';
import {
  makeAnalyticsLabelSource,
  makeAnalyticsReleaseSource,
} from '@/modules/companies/shell/analytics/postgres-sources.js';

import {
  DATASET,
  fakePrivacy,
  fakeReleases,
  makeInMemoryEngine,
  releaseRow as analyticsReleaseRow,
} from './analytics-fixtures.js';

import type { Logger, ProdDatabase } from '@/modules/shared/index.js';

interface Recorder {
  readonly queries: string[];
  readonly parameters?: (readonly unknown[])[];
  rowsFor: (sql: string) => Record<string, unknown>[];
}

const makeFakeDb = (recorder: Recorder): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.queries.push(compiled.sql);
      recorder.parameters?.push(compiled.parameters);
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

/** One current-state row as the statement returns it (envelope of edition 42). */
const stateRow = (over: Record<string, unknown> = {}) => ({
  epoch: '4',
  in_recovery: false,
  isolation: 'read committed',
  publication_state: 'published',
  listed: true,
  edition_id: '42',
  publication_epoch: '3',
  source_snapshot_id: 'onrc:2026-07-08',
  source_published_at: '2026-07-08',
  interpretation_version: 'onrc-edition-v1',
  dimension_policy_version: 'onrc-dimensions-v1',
  privacy_policy_version: 'onrc-privacy-v1',
  ...over,
});

describe('companies analytics PostgreSQL sources', () => {
  it('reads the privacy epoch and the current ONRC publication in ONE fresh statement per call', async () => {
    let epoch = '4';
    const recorder: Recorder = { queries: [], rowsFor: () => [stateRow({ epoch })] };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    expect((await source.currentState())._unsafeUnwrap()).toEqual({
      epoch: '4',
      inRecovery: false,
      isolation: 'read committed',
      onrc: {
        publicationState: 'published',
        listed: true,
        editionId: '42',
        publicationEpoch: '3',
        sourceSnapshotId: 'onrc:2026-07-08',
        sourcePublishedAt: '2026-07-08',
        interpretationVersion: 'onrc-edition-v1',
        dimensionPolicyVersion: 'onrc-dimensions-v1',
        privacyPolicyVersion: 'onrc-privacy-v1',
      },
    });
    epoch = '5';
    expect((await source.currentState())._unsafeUnwrap().epoch).toBe('5');
    expect(recorder.queries).toHaveLength(2);
    const sql = recorder.queries[0] ?? '';
    expect(sql).toContain('s.epoch::text as epoch');
    expect(sql).toContain('pg_is_in_recovery() as in_recovery');
    expect(sql).toContain("current_setting('transaction_isolation') as isolation");
    expect(sql).toContain('from companies_analytics.privacy_state s');
    expect(sql).toContain('cross join companies_v2.onrc_current_publication c');
    expect(sql).toContain(
      'left join companies_v2.onrc_published_editions e on e.edition_id = c.edition_id'
    );
    expect(sql).toContain('where s.singleton');
    // The exporter's DateStyle-independent rendering, out-of-domain → a sentinel.
    expect(sql).toContain("between date '0001-01-01' and date '9999-12-31'");
    expect(sql).toContain('to_char("c"."source_published_at", \'YYYY-MM-DD\')');
    expect(sql).toContain("else 'out-of-range' end");
    // A plain read: no lock, no write, no legacy registry rows.
    expect(sql).not.toMatch(/for (update|share)|insert|update |delete/iu);
    expect(sql).not.toContain('registrations');
  });

  it.each([
    ['no row', []],
    ['two rows', [stateRow(), stateRow()]],
    ['a malformed epoch', [stateRow({ epoch: 4 })]],
    ['a malformed recovery flag', [stateRow({ in_recovery: 'f' })]],
    ['a missing envelope', [{ epoch: '4', in_recovery: false, isolation: 'read committed' }]],
    ['a non-boolean listed flag', [stateRow({ listed: 'true' })]],
  ])('reports the state as unreadable on %s', async (_label, rows) => {
    const recorder: Recorder = { queries: [], rowsFor: () => rows as Record<string, unknown>[] };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder));
    expect((await source.currentState())._unsafeUnwrapErr()).toMatchObject({
      type: 'Database',
      message: 'companies analytics privacy state is unreadable',
    });
  });

  it('never forwards or logs driver text when the read fails', async () => {
    const lines: string[] = [];
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        throw new Error(
          'permission denied for view onrc_current_publication; host primary:5432 pw=x'
        );
      },
    };
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder), silentLogger(lines));
    const error = (await source.currentState())._unsafeUnwrapErr();
    expect(error.message).toBe('companies analytics privacy state is unreadable');
    expect(lines.join('\n')).not.toContain('permission denied');
    expect(lines.join('\n')).toContain('currentState');
  });

  it('carries the captured epoch on the active row, which stays micro-cached', async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: (sql) => (sql.includes('privacy_state') ? [stateRow()] : [releaseRow()]),
    };
    const now = 1_000;
    const source = makeAnalyticsReleaseSource(makeFakeDb(recorder), undefined, () => now);
    const first = (await source.activeRelease())._unsafeUnwrap();
    expect(first).toMatchObject({ releaseId: '7', active: true, privacyEpoch: '4' });
    await source.activeRelease();
    await source.currentState();
    await source.currentState();
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

/**
 * A fake primary whose label rows honour publicity: a withdrawn row simply
 * stops matching, as the real public predicates make it. Any query that
 * touches `companies_v2.registrations` would answer a registry label — and
 * the assertions below require that none is ever sent.
 */
const labelWorld = () => {
  const state = { territory: true, organization: true };
  const recorder: Recorder = {
    queries: [],
    parameters: [],
    rowsFor: (sql) => {
      if (sql.includes('"core"."organizations"'))
        return state.organization ? [{ cui: '100', name: 'ALFA SRL' }] : [];
      if (sql.includes('t.county_code as key'))
        return state.territory ? [{ key: 'CJ', label: 'Cluj' }] : [];
      if (sql.includes('t.siruta_code as key'))
        return state.territory ? [{ key: '54975', label: 'Cluj-Napoca' }] : [];
      if (sql.includes('registrations')) return [{ key: '1048', label: 'REGISTRY FUNCTIONARE' }];
      return [];
    },
  };
  const withdraw = () => {
    state.territory = false;
    state.organization = false;
  };
  return { recorder, withdraw, labels: makeAnalyticsLabelSource(makeFakeDb(recorder)) };
};

describe('companies analytics labels', () => {
  it('reads every label fresh, each with its public predicate (no cache to outlive a withdrawal)', async () => {
    const { recorder, withdraw, labels } = labelWorld();
    const readAll = async () => ({
      names: (await labels.companyNames(['100']))._unsafeUnwrap(),
      counties: (await labels.countyLabels(['CJ']))._unsafeUnwrap(),
      uats: (await labels.uatLabels(['54975']))._unsafeUnwrap(),
    });
    const before = await readAll();
    expect(before.names.get('100')).toBe('ALFA SRL');
    expect(before.counties.get('CJ')).toBe('Cluj');
    expect(before.uats.get('54975')).toBe('Cluj-Napoca');

    withdraw();
    const after = await readAll();
    expect(after.names.has('100')).toBe(false);
    expect(after.counties.has('CJ')).toBe(false);
    expect(after.uats.has('54975')).toBe(false);
    // Every read went to the database: nothing was served from memory.
    expect(recorder.queries).toHaveLength(6);

    const [names, county, uat] = recorder.queries;
    expect(names).toContain('"o"."privacy_class" = $');
    expect(recorder.parameters?.[0]).toContain('public');
    expect(county).toContain("t.privacy_class = 'public'");
    expect(uat).toContain("t.privacy_class = 'public'");
    // The label source has no status read and never queries registrations.
    expect(labels).not.toHaveProperty('statusLabels');
    expect(recorder.queries.some((q) => q.includes('registrations'))).toBe(false);
  });

  it('a new release after a withdrawal never shows the withdrawn territory or name labels; status is the nomenclature', async () => {
    const { withdraw, labels } = labelWorld();
    const engine = makeInMemoryEngine(DATASET.companies, DATASET.statements, [7, 8]);
    const deps = (active: ReturnType<typeof analyticsReleaseRow>, epoch: string) => ({
      engine,
      labels,
      releases: fakeReleases(active, [], fakePrivacy({ epoch })),
      database: 'companies_analytics',
    });
    const nodeOf = async (ctx: ReturnType<typeof deps>) => {
      const page = (await companyAnalysisRecords(ctx, { first: 6 }))._unsafeUnwrap();
      return page.edges.find((edge) => edge.node.cui === '100')?.node;
    };

    const first = await nodeOf(
      deps(analyticsReleaseRow(7, DATASET.companies, DATASET.statements), '0')
    );
    expect(first).toMatchObject({
      currentName: 'ALFA SRL',
      county: { code: 'CJ', label: 'Cluj', labelSource: 'territory_hub' },
      uat: { code: '54975', label: 'Cluj-Napoca', labelSource: 'territory_hub' },
      // The API nomenclature, attributed — never a source-observed registry label.
      observedStatus: { code: '1048', label: 'funcțiune', labelSource: 'api_nomenclature' },
    });

    // The withdrawal commits (epoch 0 → 1) and a fresh release is published.
    withdraw();
    const refreshed = analyticsReleaseRow(8, DATASET.companies, DATASET.statements, {
      privacyEpoch: '1',
    });
    const second = await nodeOf(deps(refreshed, '1'));
    expect(second).toMatchObject({
      currentName: null,
      county: { code: 'CJ', label: null, labelSource: null },
      uat: { code: '54975', label: null, labelSource: null },
      observedStatus: { code: '1048', label: 'funcțiune', labelSource: 'api_nomenclature' },
    });
  });
});
