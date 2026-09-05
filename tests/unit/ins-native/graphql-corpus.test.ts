/**
 * The golden-master INS corpus documents, executed against the native slice
 * over the in-memory fake repository. Proves the frozen SDL + the thin
 * resolvers answer every client document without a GraphQL error and with the
 * legacy leaf shapes (snake_case fields, pageInfo with totalCount, iso periods,
 * D<n>/nomItemId classification codes).
 *
 * The schema is assembled the way the kernel does it: base typedefs + the
 * budget legacy slice (PeriodDate, ReportPeriodInput) + the native slice. The
 * `PageInfo` extension is added here because the budget legacy collision slice
 * owns it on the kernel; this test only needs the fields to exist.
 *
 * Built with `buildSchema` from THIS graphql instance and the resolver map
 * attached by hand: under vitest `@graphql-tools/schema` and a direct `graphql`
 * import are different module instances (dual-package interop), so
 * `makeExecutableSchema` + `graphql()` throws "another module or realm".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildSchema,
  graphql,
  isObjectType,
  isScalarType,
  type ExecutionResult,
  type GraphQLFieldResolver,
  type GraphQLScalarType,
  type GraphQLSchema,
} from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { PeriodDateScalar } from '@/modules/budget/shell/graphql/legacy/resolvers.js';
import { budgetLegacyTypeDefs } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { makeInsNativeModule } from '@/modules/ins-native/index.js';
import { makeInsLegacyResolvers } from '@/modules/ins-native/shell/graphql/legacy/resolvers.js';
import { baseTypeDefs, scalarResolvers } from '@/modules/shared/index.js';

import { makeFakeRepo } from './fake-repo.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';

interface CorpusEntry {
  id: string;
  status: string;
  query?: string;
  document?: string;
  variables?: Record<string, unknown>;
}

const corpus = (): CorpusEntry[] => {
  const file = path.resolve(process.cwd(), 'tests/golden-master/corpus/client-documents.json');
  // eslint-disable-next-line no-restricted-syntax -- test utility, the golden-master corpus file from the repo
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries: CorpusEntry[] };
  return parsed.entries.filter((e) => /^(ins-|statistics-)/u.test(e.id) && e.status === 'live');
};

/** Attach a `{ Type: { field: resolver } | ScalarType }` map onto a schema built by buildSchema. */
const attachResolvers = (
  schema: GraphQLSchema,
  maps: readonly Record<string, unknown>[]
): GraphQLSchema => {
  for (const map of maps) {
    for (const [typeName, value] of Object.entries(map)) {
      const type = schema.getType(typeName);
      if (type === undefined) continue;
      if (
        isScalarType(type) &&
        typeof value === 'object' &&
        value !== null &&
        'serialize' in value
      ) {
        const scalar = value as GraphQLScalarType;
        type.serialize = (v: unknown): unknown => scalar.serialize(v);
        type.parseValue = (v: unknown): unknown => scalar.parseValue(v);
        type.parseLiteral = (ast, vars): unknown => scalar.parseLiteral(ast, vars);
        continue;
      }
      if (!isObjectType(type) || typeof value !== 'object' || value === null) continue;
      const fields = type.getFields();
      for (const [fieldName, resolver] of Object.entries(value as Record<string, unknown>)) {
        const field = fields[fieldName];
        if (field !== undefined && typeof resolver === 'function') {
          field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
        }
      }
    }
  }
  return schema;
};

const PAGE_INFO_EXTENSION = /* GraphQL */ `
  extend type PageInfo {
    totalCount: Int
    hasPreviousPage: Boolean
    startCursor: String
  }
`;

const buildTestSchema = (
  repoForContext?: (context: unknown) => Promise<InsRepo>
): GraphQLSchema => {
  const module = makeInsNativeModule({
    db: {} as never,
    registry: { register: () => undefined, list: () => [], get: () => undefined },
    repo: makeFakeRepo(),
  });
  const schema = buildSchema(
    [baseTypeDefs, budgetLegacyTypeDefs, PAGE_INFO_EXTENSION, module.graphqlSlice.typeDefs].join(
      '\n'
    )
  );
  return attachResolvers(schema, [
    scalarResolvers,
    { PeriodDate: PeriodDateScalar },
    repoForContext === undefined
      ? module.graphqlResolvers
      : makeInsLegacyResolvers({
          // Any accidental pool-backed resolver path must fail this test.
          repo: new Proxy({} as InsRepo, {
            get: () => {
              throw new Error('unscoped INS repository');
            },
          }),
          repoForContext,
        }),
  ]);
};

/**
 * Map the corpus's real-world identifiers onto the fake world: dataset codes,
 * the legacy classification type slugs the landing document still embeds
 * (`SEX`/`AGE_GROUP` → `D1`/`D0`, the client change of plan §5), and the
 * measured decade years.
 */
const toFakeWorld = (text: string): string =>
  text
    .replaceAll('POP107D', 'POPTEST')
    .replaceAll('FOM104D', 'CNTTEST')
    .replaceAll('SOM101F', 'EMPTYTEST')
    .replaceAll('LOC101B', 'POPTEST')
    .replaceAll('"SEX"', '"D1"')
    .replaceAll('"AGE_GROUP"', '"D0"')
    .replaceAll('"2016"', '"2019"')
    .replaceAll('"2025"', '"2021"');

const adapt = (vars: Record<string, unknown> | undefined): Record<string, unknown> => {
  // eslint-disable-next-line no-restricted-syntax -- re-parsing a JSON.stringify of test variables
  const parsed: unknown = JSON.parse(toFakeWorld(JSON.stringify(vars ?? {})));
  return parsed as Record<string, unknown>;
};

const run = async (schema: GraphQLSchema, entry: CorpusEntry): Promise<ExecutionResult> =>
  graphql({
    schema,
    source: toFakeWorld(entry.query ?? entry.document ?? ''),
    variableValues: adapt(entry.variables),
  });

describe('golden-master INS corpus over the native slice (fake repository)', () => {
  const schema = buildTestSchema();
  const entries = corpus();

  it('finds the live INS corpus documents', () => {
    expect(entries.length).toBeGreaterThanOrEqual(14);
  });

  for (const entry of entries) {
    it(`${entry.id} answers without errors`, async () => {
      const result = await run(schema, entry);
      expect(result.errors ?? []).toEqual([]);
      expect(result.data).toBeDefined();
    });
  }

  it('all client documents resolve roots and nested fields through their operation context', async () => {
    const context = { operation: 'one-publication' };
    const scopedRepo = makeFakeRepo();
    const accessor = vi.fn(async (received: unknown) => {
      expect(received).toBe(context);
      return scopedRepo;
    });
    const scopedSchema = buildTestSchema(accessor);
    for (const entry of entries) {
      accessor.mockClear();
      const result = await graphql({
        schema: scopedSchema,
        source: toFakeWorld(entry.query ?? entry.document ?? ''),
        variableValues: adapt(entry.variables),
        contextValue: context,
      });
      expect(result.errors ?? [], entry.id).toEqual([]);
      expect(accessor, entry.id).toHaveBeenCalled();
    }
  });

  it('statistics-landing-data: latest tiles + decade + example carry the legacy leaf shapes', async () => {
    const entry = entries.find((e) => e.id === 'statistics-landing-data');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = await run(schema, entry);
    const data = result.data as {
      latest: {
        matchStrategy: string;
        hasData: boolean;
        latestPeriod: string | null;
        observation: {
          value: string;
          unit: { symbol: string };
          time_period: { iso_period: string };
        } | null;
      }[];
      decade: {
        nodes: { territory: { code: string }; time_period: { year: number }; value: string }[];
        pageInfo: { totalCount: number };
      };
      example: { nodes: { territory: { code: string } }[] };
    };
    expect(data.latest.map((l) => [l.matchStrategy, l.hasData])).toEqual([
      ['TOTAL_FALLBACK', true],
      ['NO_DATA', false],
      ['NO_DATA', false],
      ['TOTAL_FALLBACK', true],
    ]);
    expect(data.latest[0]?.latestPeriod).toBe('2021');
    expect(data.latest[0]?.observation?.time_period.iso_period).toBe('2021');
    // territoryLevels: [NUTS3] with TOTAL on age/sex → the two county rows per year, nothing else
    expect(new Set(data.decade.nodes.map((n) => n.territory.code))).toEqual(new Set(['CJ', 'AB']));
    expect(new Set(data.decade.nodes.map((n) => n.time_period.year))).toEqual(
      new Set([2019, 2021])
    );
    expect(data.decade.pageInfo.totalCount).toBeGreaterThan(0);
    expect(new Set(data.example.nodes.map((n) => n.territory.code))).toEqual(new Set(['RO', 'CJ']));
  });

  it('statistics-dataset-series: classification codes are D<n> + nomItemId and pageInfo carries totalCount', async () => {
    const entry = entries.find((e) => e.id === 'statistics-dataset-series-pop107d-national');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const result = await run(schema, entry);
    const series = (
      result.data as {
        series: {
          pageInfo: { totalCount: number; hasNextPage: boolean };
          nodes: {
            classifications: { type_code: string; code: string }[];
            territory: { code: string } | null;
          }[];
        };
      }
    ).series;
    expect(series.pageInfo).toEqual({ totalCount: 3, hasNextPage: false, hasPreviousPage: false });
    expect(series.nodes[0]?.classifications.map((c) => `${c.type_code}=${c.code}`)).toEqual([
      'D0=1',
      'D1=105',
      'D2=3064',
      'D3=112',
    ]);
  });

  it('ins-territories-counties: parent_code / parent_name_ro are populated (the legacy null is gone)', async () => {
    const entry = entries.find((e) => e.id === 'ins-territories-counties');
    if (entry === undefined) return;
    const result = await run(schema, entry);
    const nodes = (
      result.data as {
        insTerritories: {
          nodes: { code: string; parent_code: string | null; parent_name_ro: string | null }[];
        };
      }
    ).insTerritories.nodes;
    expect(nodes.map((n) => [n.code, n.parent_code, n.parent_name_ro])).toEqual([
      ['CJ', 'RO11', 'Nord-Vest'],
      ['AB', 'RO11', 'Nord-Vest'],
    ]);
  });

  it('statistics-territory-hub: the dashboard groups carry latestPeriod and the dataset envelope', async () => {
    const entry = entries.find((e) => e.id === 'statistics-territory-hub-cluj-napoca');
    if (entry === undefined) return;
    const result = await run(schema, entry);
    const dash = (
      result.data as {
        dashboard: {
          latestPeriod: string;
          dataset: { code: string; data_status: string; year_range: number[] };
          observations: unknown[];
        }[];
      }
    ).dashboard;
    expect(
      dash.map((g) => [
        g.dataset.code,
        g.latestPeriod,
        g.dataset.data_status,
        g.dataset.year_range,
        g.observations.length,
      ])
    ).toEqual([['POPTEST', '2021', 'AVAILABLE', [2019, 2021], 3]]);
  });
});
