import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import {
  compareInsUats,
  getInsDataset,
  getInsUatDashboard,
  listInsContexts,
  listInsDatasets,
  listInsLatestDatasetValues,
  listInsObservations,
  makeInsRepo,
} from '../src/modules/ins/index.js';

import type { InsDatabase } from '../src/infra/database/ins/types.js';

const defaultPriorityCodes = [
  'POP107D',
  'FOM104D',
  'SOM101F',
  'LOC101B',
  'SOM103A',
  'POP108D',
  'POP201D',
  'POP206D',
  'POP309E',
  'POP310E',
  'SOM101E',
  'LOC103B',
  'GOS107A',
  'GOS110A',
  'GOS116A',
  'GOS118A',
  'GOS104A',
  'GOS105A',
  'SCL101C',
  'SCL103D',
  'SAN101B',
  'SAN104B',
  'TUR101C',
  'TUR104E',
  'SOM103B',
  'POP206C',
  'POP217A',
] as const;

const sampleSirutaCodes = ['10006', '100086'] as const;
const defaultDashboardCodes = ['POP107D', 'FOM104D', 'SOM101F', 'LOC101B'] as const;

const csvEnv = (name: string, fallback: readonly string[]): string[] => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return [...fallback];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const priorityCodes = csvEnv('INS_SMOKE_MATRIX_CODES', defaultPriorityCodes);
const sampleDatasetCode = process.env['INS_SMOKE_DATASET_CODE'] ?? priorityCodes[0] ?? 'POP107D';
const sampleDashboardCodes = csvEnv('INS_SMOKE_DASHBOARD_CODES', defaultDashboardCodes);

const unwrap = <T>(label: string, result: { isErr(): boolean; value?: T; error?: unknown }): T => {
  if (result.isErr()) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
};

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const main = async (): Promise<void> => {
  const connectionString = process.env['INS_DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('INS_DATABASE_URL is required');
  }

  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    application_name: 'ins-golden-smoke',
  });
  const db = new Kysely<InsDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    const insRepo = makeInsRepo(db);

    const contexts = unwrap(
      'listInsContexts',
      await listInsContexts({ insRepo }, { filter: { level: 0 }, limit: 20, offset: 0 })
    );
    assertCondition(contexts.nodes.length > 0, 'Expected root INS contexts');

    const datasets = unwrap(
      'listInsDatasets',
      await listInsDatasets(
        { insRepo },
        { filter: { codes: [...priorityCodes] }, limit: 100, offset: 0 }
      )
    );
    const foundCodes = new Set(datasets.nodes.map((dataset) => dataset.code));
    const missingCodes = priorityCodes.filter((code) => !foundCodes.has(code));
    assertCondition(
      missingCodes.length === 0,
      `Missing priority datasets: ${missingCodes.join(', ')}`
    );

    const nonSyncedCodes = datasets.nodes
      .filter((dataset) => dataset.sync_status !== 'SYNCED')
      .map((dataset) => `${dataset.code}:${dataset.sync_status ?? 'NULL'}`);
    assertCondition(
      nonSyncedCodes.length === 0,
      `Priority datasets are not fully synced: ${nonSyncedCodes.join(', ')}`
    );

    const dataset = unwrap(
      `getInsDataset(${sampleDatasetCode})`,
      await getInsDataset({ insRepo }, sampleDatasetCode)
    );
    assertCondition(dataset !== null, `${sampleDatasetCode} dataset was not found`);
    assertCondition(dataset.dimension_count > 0, `${sampleDatasetCode} should expose dimensions`);

    const observations = unwrap(
      'listInsObservations',
      await listInsObservations(
        { insRepo },
        {
          dataset_codes: [sampleDatasetCode],
          filter: { siruta_codes: [sampleSirutaCodes[0]], has_value: true },
          limit: 25,
          offset: 0,
        }
      )
    );
    assertCondition(observations.nodes.length > 0, 'Expected POP107D observations for sample UAT');

    const latestValues = unwrap(
      'listInsLatestDatasetValues',
      await listInsLatestDatasetValues(
        { insRepo },
        {
          entity: { siruta_code: sampleSirutaCodes[0] },
          dataset_codes: [...sampleDashboardCodes],
        }
      )
    );
    assertCondition(
      latestValues.some((value) => value.has_data),
      'Expected at least one latest dashboard value for sample UAT'
    );

    const dashboard = unwrap(
      'getInsUatDashboard',
      await getInsUatDashboard({ insRepo }, { siruta_code: sampleSirutaCodes[0] })
    );
    assertCondition(dashboard.length > 0, 'Expected dashboard groups for sample UAT');

    const comparison = unwrap(
      'compareInsUats',
      await compareInsUats(
        { insRepo },
        { dataset_code: sampleDatasetCode, siruta_codes: [...sampleSirutaCodes] }
      )
    );
    assertCondition(comparison.length > 0, `Expected ${sampleDatasetCode} comparison observations`);

    const summary = {
      contexts: {
        returned: contexts.nodes.length,
        total: contexts.pageInfo.totalCount,
      },
      priorityDatasets: {
        requested: priorityCodes.length,
        returned: datasets.nodes.length,
      },
      dataset: {
        code: dataset.code,
        dimensions: dataset.dimension_count,
        sync_status: dataset.sync_status,
      },
      observations: {
        dataset_code: sampleDatasetCode,
        siruta_code: sampleSirutaCodes[0],
        returned: observations.nodes.length,
        total: observations.pageInfo.totalCount,
      },
      latestValues: {
        requested: sampleDashboardCodes.length,
        returned: latestValues.length,
        withData: latestValues.filter((value) => value.has_data).length,
      },
      dashboard: {
        siruta_code: sampleSirutaCodes[0],
        groups: dashboard.length,
        observations: dashboard.reduce((sum, group) => sum + group.observations.length, 0),
      },
      comparison: {
        dataset_code: sampleDatasetCode,
        siruta_codes: [...sampleSirutaCodes],
        observations: comparison.length,
      },
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.destroy();
  }
};

await main();
