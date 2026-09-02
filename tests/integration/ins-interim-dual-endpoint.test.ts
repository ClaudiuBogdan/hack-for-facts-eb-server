/**
 * S1-7 interim (src/app/ins-interim-surface.ts): the legacy INS roots answer
 * BYTE-IDENTICALLY on the legacy `/graphql` and on the kernel `/api/v1/graphql`
 * when both are backed by the same resolvers and one fake repository. This is
 * the in-process twin of the golden-master cutover replay: it covers what the
 * corpus documents select (every INS/statistics corpus document is replayed)
 * plus the legacy-SDL features the corpus does not exercise — a fragment spread
 * on `PageInfo`, `__typename`, `totalCount` / `hasPreviousPage`, a JS `Date`
 * behind `last_sync_at`, and a resolver failure (error path uses
 * `context.reply.log`, which only Mercurius provides).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Decimal } from 'decimal.js';
import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeInsInterimSurface } from '@/app/ins-interim-surface.js';
import { deserialize } from '@/infra/cache/serialization.js';
import { CommonGraphQLSchema, commonGraphQLResolvers } from '@/infra/graphql/common/index.js';
import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { BaseSchema } from '@/infra/graphql/schema.js';
import { createTestAuthProvider } from '@/modules/auth/index.js';
import { ExecutionAnalyticsSchema } from '@/modules/execution-analytics/shell/graphql/schema.js';
import { InsSchema, makeInsResolvers, type InsRepository } from '@/modules/ins/index.js';

const dataset = {
  id: 1,
  code: 'POP107D',
  name_ro: 'Populatia dupa domiciliu',
  name_en: null,
  definition_ro: null,
  definition_en: null,
  periodicity: ['ANNUAL'],
  year_range: [2020, 2025],
  dimension_count: 2,
  has_uat_data: true,
  has_county_data: true,
  has_siruta: true,
  sync_status: 'SYNCED',
  data_status: 'AVAILABLE',
  last_sync_at: new Date('2026-09-02T12:34:56.789Z'),
  context_code: 'POP',
  context_name_ro: 'Populatie',
  context_name_en: null,
  context_path: 'POP',
  metadata: { source: 'TEMPO', refreshed: new Date('2026-09-01T00:00:00.000Z') },
};

const territory = {
  id: 10,
  code: '54975',
  siruta_code: '54975',
  level: 'LAU',
  name_ro: 'MUNICIPIUL CLUJ-NAPOCA',
  path: 'RO.RO1.RO11.CJ.54975',
  parent_id: 5,
  parent_code: 'CJ',
  parent_name_ro: 'Cluj',
};

/** Dates in `period_start` / `period_end` exercise the legacy `Date` scalar. */
const timePeriod = {
  id: 2025,
  year: 2025,
  quarter: null,
  month: null,
  periodicity: 'ANNUAL',
  period_start: new Date('2025-01-01T00:00:00.000Z'),
  period_end: new Date('2025-12-31T00:00:00.000Z'),
  label_ro: '2025',
  label_en: '2025',
  iso_period: '2025',
};

const unit = { id: 1, code: 'PERS', symbol: null, name_ro: 'Numar persoane', name_en: 'Persons' };

const classification = {
  id: 7,
  type_id: 3,
  type_code: 'SEX',
  type_name_ro: 'Sexe',
  type_name_en: null,
  code: 'T',
  name_ro: 'Total',
  name_en: null,
  level: 0,
  parent_id: null,
  sort_order: 1,
};

/** A Decimal value and a Date inside the `dimensions` JSON, as the repo emits them. */
const observation = {
  id: 'obs-1',
  dataset_code: 'POP107D',
  matrix_id: 1,
  territory,
  time_period: timePeriod,
  unit,
  value: new Decimal('325353.5'),
  value_status: null,
  classifications: [classification],
  dimensions: { sex: 'T', loaded_at: new Date('2026-08-18T00:00:00.000Z') },
};

const dimension = {
  matrix_id: 1,
  index: 0,
  type: 'CLASSIFICATION',
  label_ro: 'Sexe',
  label_en: null,
  classification_type: null,
  is_hierarchical: false,
  option_count: 3,
};

const dimensionValue = {
  matrix_id: 1,
  dim_index: 0,
  nom_item_id: 100,
  dimension_type: 'CLASSIFICATION',
  label_ro: 'Total',
  label_en: null,
  parent_nom_item_id: null,
  offset_order: 1,
  territory: null,
  time_period: null,
  classification_value: classification,
  unit: null,
};

const context = {
  id: 3,
  code: 'POP',
  name_ro: 'Populatie',
  name_en: null,
  name_ro_markdown: null,
  name_en_markdown: null,
  level: 1,
  path: 'POP',
  parent_id: null,
  parent_code: null,
  parent_name_ro: null,
  matrix_count: 12,
};

const connection = <T>(nodes: T[]) => ({
  nodes,
  pageInfo: { totalCount: nodes.length, hasNextPage: false, hasPreviousPage: false },
});

/** One fake repository for BOTH endpoints; `code: "FAIL"` forces the error path. */
const fakeRepo = {
  listDatasets: async () => ok(connection([dataset])),
  listContexts: async () => ok(connection([context])),
  listTerritories: async () => ok(connection([territory])),
  getDatasetByCode: async (code: string) =>
    code === 'FAIL' ? err({ type: 'DatabaseError', message: 'forced failure' }) : ok(dataset),
  listDimensions: async () => ok([dimension]),
  listDimensionValues: async () => ok(connection([dimensionValue])),
  listObservations: async () => ok(connection([observation])),
  listLatestDatasetValues: async () =>
    ok([{ dataset, observation, latest_period: '2025', match_strategy: 'EXACT', has_data: true }]),
  listUatDatasetsWithObservations: async () =>
    ok([{ dataset, observations: [observation], latest_period: '2025' }]),
} as unknown as InsRepository;

interface CorpusEntry {
  id: string;
  status: string;
  document: string;
  variables: Record<string, unknown>;
}

const corpusEntries = (): CorpusEntry[] => {
  const file = path.resolve(process.cwd(), 'tests/golden-master/corpus/client-documents.json');
  const decoded = deserialize(readFileSync(file, 'utf8'));
  if (!decoded.ok) throw new Error('golden-master corpus is not valid JSON');
  return (decoded.value as { entries: CorpusEntry[] }).entries.filter(
    (e) => e.status === 'live' && (e.id.startsWith('ins-') || e.id.startsWith('statistics-'))
  );
};

describe('S1-7 interim INS roots — legacy /graphql vs kernel /api/v1/graphql', () => {
  let legacyApp: FastifyInstance;
  let kernelApp: FastifyInstance;

  beforeAll(async () => {
    const insResolvers = makeInsResolvers({ insRepo: fakeRepo });

    // A REDUCED legacy twin: the production legacy app composes many more module
    // schemas and an execution-analytics `PeriodDate` passthrough scalar; here
    // only the schemas the INS SDL references are mounted and `PeriodDate` runs
    // graphql-js default scalar behaviour. Equivalent for these documents
    // (periods travel as strings either way); the live legacy endpoint is
    // compared by the golden-master cutover replay, not by this file.
    legacyApp = fastifyLib({ logger: false });
    await legacyApp.register(
      makeGraphQLPlugin({
        schema: [BaseSchema, CommonGraphQLSchema, ExecutionAnalyticsSchema, InsSchema],
        resolvers: [commonGraphQLResolvers, insResolvers],
        isProduction: false,
        enableGraphiQL: false,
      })
    );

    // The unified mount's shape: budget module (ReportPeriodInput / PeriodDate),
    // auth context, and the interim surface. The kernel pg pool is lazy, so the
    // bogus endpoint never connects for these documents.
    const built = await buildRedesignApp({
      kernelConfig: {
        prodDatabaseUrl: 'postgres://test:test@127.0.0.1:1/test',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
      modules: ['budget'],
      enableGraphiQL: false,
      logLevel: 'silent',
      authProvider: createTestAuthProvider().provider,
      ...makeInsInterimSurface(insResolvers),
    });
    kernelApp = built.app;
  });

  afterAll(async () => {
    await kernelApp.close();
    await legacyApp.close();
  });

  const both = async (query: string, variables?: Record<string, unknown>) => {
    const payload = variables === undefined ? { query } : { query, variables };
    const legacy = await legacyApp.inject({ method: 'POST', url: '/graphql', payload });
    const kernel = await kernelApp.inject({ method: 'POST', url: '/api/v1/graphql', payload });
    return { legacy, kernel };
  };

  const featureDocuments: Record<string, string> = {
    'legacy PageInfo fields':
      '{ insDatasets { pageInfo { totalCount hasNextPage hasPreviousPage } } }',
    'fragment spread on PageInfo':
      'query { insDatasets { pageInfo { ...F } } } fragment F on PageInfo { hasNextPage endCursor totalCount }',
    '__typename on PageInfo': '{ insDatasets { pageInfo { __typename hasNextPage } } }',
    'JS Date behind DateTime': '{ insDataset(code: "POP107D") { code last_sync_at } }',
    'JS Dates behind Date (period_start / period_end) and a Decimal value':
      '{ insObservations(datasetCode: "POP107D", limit: 1) { nodes { value time_period { period_start period_end iso_period } dimensions } } }',
    'resolver failure (context.reply.log path)': '{ insDataset(code: "FAIL") { code } }',
    'insUatIndicators with an inline PeriodDate literal':
      '{ insUatIndicators(sirutaCode: "54975", period: "2025", datasetCodes: ["POP107D"]) { id value time_period { iso_period } territory { code parent_code } } }',
    'insCompare (list root, no connection)':
      '{ insCompare(sirutaCodes: ["54975", "54984"], datasetCode: "POP107D") { id value classifications { code } } }',
    'insObservations with an inline ReportPeriodInput literal':
      '{ insObservations(datasetCode: "POP107D", filter: { period: { type: YEAR, date: "2025" } }, limit: 1) { pageInfo { totalCount } nodes { id } } }',
  };

  for (const [name, query] of Object.entries(featureDocuments)) {
    it(`answers identically: ${name}`, async () => {
      const { legacy, kernel } = await both(query);
      expect(legacy.statusCode).toBe(200);
      expect(kernel.statusCode).toBe(legacy.statusCode);
      expect(kernel.body).toBe(legacy.body);
    });
  }

  it('serializes the JS Dates as ISO toJSON strings on both endpoints', async () => {
    const dateTime = await both(featureDocuments['JS Date behind DateTime'] ?? '');
    expect(dateTime.legacy.body).toContain('"last_sync_at":"2026-09-02T12:34:56.789Z"');
    expect(dateTime.kernel.body).toBe(dateTime.legacy.body);

    const date = await both(
      featureDocuments['JS Dates behind Date (period_start / period_end) and a Decimal value'] ?? ''
    );
    expect(date.legacy.body).toContain('"period_start":"2025-01-01T00:00:00.000Z"');
    expect(date.legacy.body).toContain('"value":"325353.5"');
    expect(date.legacy.body).toContain('"loaded_at":"2026-08-18T00:00:00.000Z"');
    expect(date.kernel.body).toBe(date.legacy.body);
  });

  it('replays every live INS/statistics corpus document byte-identically', async () => {
    const entries = corpusEntries();
    expect(entries.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    const bodies: string[] = [];
    for (const entry of entries) {
      const { legacy, kernel } = await both(entry.document, entry.variables);
      if (legacy.statusCode !== 200)
        mismatches.push(`${entry.id}: legacy ${String(legacy.statusCode)}`);
      else if (kernel.statusCode !== 200 || kernel.body !== legacy.body) {
        mismatches.push(
          `${entry.id}: kernel ${String(kernel.statusCode)} ${kernel.body.slice(0, 160)}`
        );
      }
      bodies.push(kernel.body);
    }
    expect(mismatches).toEqual([]);
    // The corpus really reaches the typed fields it selects: a Decimal value, the
    // DateTime behind last_sync_at, and totalCount. The legacy `Date` scalar and
    // the Date nested in `JSON` are covered by the feature documents above — no
    // corpus document selects period_start / period_end / dimensions.
    const all = bodies.join('\n');
    expect(all).toContain('"value":"325353.5"');
    expect(all).toContain('"last_sync_at":"2026-09-02T12:34:56.789Z"');
    expect(all).toContain('"totalCount":1');
  });
});
