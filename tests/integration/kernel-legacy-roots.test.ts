/**
 * The legacy client roots served by the KERNEL endpoint, replayed from the
 * golden-master corpus through the real request path (Fastify + mercurius +
 * the kernel security hooks) over fakes. Closes review T-05 and turns the
 * corpus into a CI asset (tests-ci.md improvement 1):
 *
 *  - every non-dead corpus document whose roots are all on the kernel
 *    (`BUDGET_LEGACY_ROOTS`, `BUDGET_GROUPED_ROOTS`, `INS_LEGACY_ROOTS`) is
 *    sent as the client sends it (40 live, 2 invalid-today today): `live`
 *    documents answer 200 with `data` and
 *    no `errors[]`; `invalid-today` documents fail GraphQL validation on the
 *    argument the corpus notes as gone;
 *  - the documented `InvalidInput` envelopes (design 13 §7 rows 11–13) come
 *    back kernel-style: `extensions.code` / `type` / `field`, no stack.
 *
 * The budget module runs its REAL core usecases (`nativeExecutionSeries`,
 * `groupedEntityAnalytics`, `groupedClassificationAnalytics`, the dimension
 * resolvers) over fake PORTS — the aggregate repo, the grouped repo, the
 * factor source, the population sources and the dimension repo — so argument
 * coercion, `PeriodDate` parsing, period planning and the error mapping are
 * exercised; only SQL is faked. The INS module runs over the shared in-memory
 * repository with the corpus identifiers mapped onto its world
 * (`fixtures/ins-native/corpus-world.ts`). No database is reached: the kernel
 * pool points at a closed port and the capturing driver records any query a
 * fake failed to intercept (asserted empty).
 */

import { Decimal } from 'decimal.js';
import { Kind, parse } from 'graphql';
import { ok, type Result } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp, deepMergeResolvers } from '@/app/build-redesign-app.js';
import {
  groupedClassificationAnalytics,
  groupedEntityAnalytics,
} from '@/modules/budget/core/legacy-analytics/grouped-usecase.js';
import { nativeExecutionSeries } from '@/modules/budget/core/legacy-analytics/native-usecase.js';
import { makeBudgetModule } from '@/modules/budget/index.js';
import { BUDGET_GROUPED_ROOTS } from '@/modules/budget/shell/graphql/legacy/grouped-typedefs.js';
import { BUDGET_LEGACY_ROOTS } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { INS_LEGACY_ROOTS, makeInsNativeModule } from '@/modules/ins-native/index.js';
import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/core/errors.js';

import { makeCapturingDb, type CapturedQuery } from '../fixtures/capturing-db.js';
import { toFakeInsVariables, toFakeInsWorld } from '../fixtures/ins-native/corpus-world.js';
import { makeFakeRepo } from '../fixtures/ins-native/fake-repo.js';
import { loadCorpus, type CorpusCase } from '../golden-master/corpus.js';

import type {
  GroupedAnalyticsRepo,
  GroupedClassification,
  GroupedEntity,
  GroupedPage,
} from '@/modules/budget/core/legacy-analytics/grouped-types.js';
import type {
  FactorKind,
  FactorSource,
  LegacyAggregateRow,
  LegacyExecutionAggregateRepo,
  PopulationSource,
} from '@/modules/budget/core/legacy-analytics/ports.js';
import type {
  LegacyAggregateQuery,
  YearlySeries,
} from '@/modules/budget/core/legacy-analytics/types.js';
import type {
  LegacyClassificationRow,
  LegacyDimensionRepo,
  LegacyDimensionRows,
  LegacyFundingSourceRow,
  LegacySectorRow,
} from '@/modules/budget/core/legacy-dimensions/ports.js';
import type { ContributorRegistry, SourceContributor } from '@/modules/shared/core/ports.js';
import type { FastifyInstance } from 'fastify';

// ── fake ports (the budget core runs for real over these) ─────────────────────

const YEARS = Array.from({ length: 10 }, (_, i) => 2016 + i);
const yearly = (value: string): YearlySeries => new Map(YEARS.map((y) => [y, new Decimal(value)]));
const FACTOR_VALUES: Record<FactorKind, YearlySeries> = {
  cpi_index: yearly('1'),
  ron_per_eur: yearly('5'),
  ron_per_usd: yearly('4.5'),
  gdp_ron: yearly('1000000000000'),
  population_ro: yearly('19000000'),
};
const factors: FactorSource = { yearly: (kind) => Promise.resolve(ok(FACTOR_VALUES[kind])) };

const population: PopulationSource = {
  scopedPopulation: () => Promise.resolve(ok(new Decimal('100000'))),
};
const annualPopulation = (
  _scope: unknown,
  years: readonly number[]
): Promise<Result<YearlySeries, ApiError>> =>
  Promise.resolve(ok(new Map(years.map((y) => [y, new Decimal('19000000')]))));

/** One row per selected period, so every series has data in every planned bucket. */
const rowsFor = (q: LegacyAggregateQuery): LegacyAggregateRow[] => {
  const planned = q.period.years;
  const years =
    'in' in planned
      ? [...planned.in]
      : Array.from({ length: planned.to - planned.from + 1 }, (_, i) => planned.from + i);
  const subs = q.frequency === 'MONTH' ? 12 : q.frequency === 'QUARTER' ? 4 : 1;
  return years.flatMap((year) =>
    Array.from({ length: subs }, (_, i) => ({
      year,
      periodValue: q.frequency === 'YEAR' ? year : i + 1,
      amount: '1000.00',
    }))
  );
};
const aggregate: LegacyExecutionAggregateRepo = {
  legacyExecutionAggregate: (q) => Promise.resolve(ok({ rows: rowsFor(q), capped: false })),
};

const pageOf = <T>(nodes: readonly T[]): GroupedPage<T> => ({
  nodes,
  pageInfo: { totalCount: nodes.length, hasNextPage: false, hasPreviousPage: false },
});
const ENTITIES: readonly GroupedEntity[] = [
  {
    entity_cui: '4305857',
    entity_name: 'MUNICIPIUL CLUJ-NAPOCA',
    entity_type: 'uat',
    uat_id: '931',
    county_code: 'CJ',
    county_name: 'Cluj',
    population: 286_598,
    amount: new Decimal('1000.00'),
    total_amount: new Decimal('1000.00'),
    per_capita_amount: new Decimal('0.0035'),
  },
  {
    entity_cui: '4270740',
    entity_name: 'MUNICIPIUL SIBIU',
    entity_type: 'uat',
    uat_id: '2001',
    county_code: 'SB',
    county_name: 'Sibiu',
    population: 134_308,
    amount: new Decimal('500.00'),
    total_amount: new Decimal('500.00'),
    per_capita_amount: new Decimal('0.0037'),
  },
];
const CLASSIFICATIONS: readonly GroupedClassification[] = [
  {
    functional_code: '65.02',
    functional_name: 'Invatamant',
    economic_code: '10.01',
    economic_name: 'Cheltuieli salariale in bani',
    amount: new Decimal('1000.00'),
    count: 2,
  },
  {
    functional_code: '51.02',
    functional_name: 'Autoritati publice',
    economic_code: null,
    economic_name: null,
    amount: new Decimal('500.00'),
    count: 1,
  },
];
const grouped: GroupedAnalyticsRepo = {
  entities: () => Promise.resolve(ok(pageOf(ENTITIES))),
  classifications: () => Promise.resolve(ok(pageOf(CLASSIFICATIONS))),
};

const SECTORS: readonly LegacySectorRow[] = [
  { sectorId: 1, sectorDescription: 'Bugetul de stat' },
  { sectorId: 2, sectorDescription: 'Bugetele locale' },
];
const FUNDING_SOURCES: readonly LegacyFundingSourceRow[] = [
  { sourceId: 1, sourceDescription: 'Integral de la buget' },
  { sourceId: 4, sourceDescription: 'Fonduri externe nerambursabile' },
];
const FUNCTIONAL: readonly LegacyClassificationRow[] = [
  { code: '51.02', name: 'Autoritati publice si actiuni externe' },
  { code: '65.02', name: 'Invatamant' },
];
const ECONOMIC: readonly LegacyClassificationRow[] = [
  { code: '10.01', name: 'Cheltuieli salariale in bani' },
  { code: '20.01', name: 'Bunuri si servicii' },
];
const rowsPage = <T>(
  all: readonly T[],
  keep: (row: T) => boolean,
  limit: number,
  offset: number
): LegacyDimensionRows<T> => {
  const rows = all.filter(keep);
  return { rows: rows.slice(offset, offset + limit), totalCount: rows.length };
};
const dimensions: LegacyDimensionRepo = {
  listSectors: (q) =>
    Promise.resolve(
      ok(
        rowsPage(
          SECTORS,
          (r) => q.ids === undefined || q.ids.includes(r.sectorId),
          q.limit,
          q.offset
        )
      )
    ),
  listFundingSources: (q) =>
    Promise.resolve(
      ok(
        rowsPage(
          FUNDING_SOURCES,
          (r) => q.ids === undefined || q.ids.includes(r.sourceId),
          q.limit,
          q.offset
        )
      )
    ),
  listClassifications: (kind, q) =>
    Promise.resolve(
      ok(
        rowsPage(
          kind === 'functional' ? FUNCTIONAL : ECONOMIC,
          (r) =>
            (q.codes === undefined || q.codes.includes(r.code)) &&
            (q.search === undefined || r.code.startsWith(q.search)),
          q.limit,
          q.offset
        )
      )
    ),
};

const makeRegistry = (): ContributorRegistry => {
  const contributors = new Map<string, SourceContributor>();
  return {
    register: (c) => contributors.set(c.source, c),
    list: () => [...contributors.values()],
    get: (source) => contributors.get(source),
  };
};

// ── the corpus, restricted to documents whose roots are all on the kernel ─────

const KERNEL_ROOTS: ReadonlySet<string> = new Set<string>([
  ...BUDGET_LEGACY_ROOTS,
  ...BUDGET_GROUPED_ROOTS,
  ...INS_LEGACY_ROOTS,
]);
const INS_ROOTS: ReadonlySet<string> = new Set<string>(INS_LEGACY_ROOTS);

const rootsOf = (document: string): string[] => {
  const roots: string[] = [];
  for (const definition of parse(document).definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind === Kind.FIELD) roots.push(selection.name.value);
    }
  }
  return roots;
};

interface KernelCase {
  readonly entry: CorpusCase;
  readonly roots: readonly string[];
  readonly ins: boolean;
}
const kernelCases: KernelCase[] = loadCorpus()
  .filter((entry) => entry.status !== 'dead')
  .map((entry) => ({ entry, roots: rootsOf(entry.document) }))
  .filter(({ roots }) => roots.length > 0 && roots.every((root) => KERNEL_ROOTS.has(root)))
  .map(({ entry, roots }) => ({ entry, roots, ins: roots.every((root) => INS_ROOTS.has(root)) }));

interface Envelope {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

describe('legacy client roots on the kernel endpoint (corpus replay over fakes)', () => {
  let app: FastifyInstance | undefined;
  const captured: CapturedQuery[] = [];

  beforeAll(async () => {
    const db = makeCapturingDb(captured);
    const budget = makeBudgetModule({
      db,
      registry: makeRegistry(),
      legacyFactors: factors,
      legacyDimensions: dimensions,
      executionSeries: (inputs) =>
        nativeExecutionSeries({ aggregate, factors, annualPopulation }, inputs),
      entityAnalytics: (input) =>
        groupedEntityAnalytics(
          { grouped, factors, population, annualScopePopulation: annualPopulation },
          input
        ),
      classificationAnalytics: (input) =>
        groupedClassificationAnalytics(
          { grouped, factors, population, annualScopePopulation: annualPopulation },
          input
        ),
    });
    const ins = makeInsNativeModule({ db, repo: makeFakeRepo() });
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules: [],
      kernelConfig: {
        prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
      graphqlSlices: [budget.graphqlSlice, ins.graphqlSlice],
      graphqlResolvers: deepMergeResolvers(budget.graphqlResolvers, ins.graphqlResolvers),
    });
    app = built.app;
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const post = async (
    query: string,
    variables: Record<string, unknown>,
    operationName: string | null = null
  ): Promise<{ status: number; body: Envelope }> => {
    if (app === undefined) throw new Error('app not built');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        query,
        variables,
        ...(operationName === null ? {} : { operationName }),
      }),
    });
    return { status: res.statusCode, body: res.json<Envelope>() };
  };

  it('selects the kernel-rooted corpus (a broken root filter cannot pass vacuously)', () => {
    const live = kernelCases.filter((c) => c.entry.status === 'live');
    const invalid = kernelCases.filter((c) => c.entry.status === 'invalid-today');
    expect(live.length).toBeGreaterThanOrEqual(38);
    expect(invalid.map((c) => c.entry.id).sort()).toEqual([
      'budget-sector-names-invalid',
      'funding-source-names-invalid',
    ]);
    // Every kernel root has at least one corpus document, so a regenerated corpus
    // that silently drops a root's documents fails here rather than shrinking coverage.
    const roots = new Set(kernelCases.flatMap((c) => c.roots));
    for (const root of KERNEL_ROOTS)
      expect(roots, `no corpus document for ${root}`).toContain(root);
  });

  for (const { entry, ins } of kernelCases.filter((c) => c.entry.status === 'live')) {
    it(`${entry.id} answers without errors`, async () => {
      const { status, body } = await post(
        ins ? toFakeInsWorld(entry.document) : entry.document,
        ins ? toFakeInsVariables(entry.variables) : entry.variables,
        entry.operationName
      );
      expect(body.errors ?? []).toEqual([]);
      expect(status).toBe(200);
      expect(body.data).toBeDefined();
      expect(body.data).not.toBeNull();
    });
  }

  for (const { entry } of kernelCases.filter((c) => c.entry.status === 'invalid-today')) {
    it(`${entry.id} fails validation on the variable the corpus marks as invalid`, async () => {
      const { status, body } = await post(entry.document, entry.variables, entry.operationName);
      expect(status).toBe(400);
      // The client still declares `$ids: [String!]` where the schema takes `[ID!]`.
      expect(
        body.errors?.some((error) =>
          error.message.startsWith('Variable "$ids" of type "[String!]"')
        )
      ).toBe(true);
      expect(body.data ?? null).toBeNull();
    });
  }

  // ── design 13 §7 rows 11–13: the documented InvalidInput envelopes ──────────

  const PERIOD_2023 = {
    type: 'YEAR',
    selection: { interval: { start: '2023', end: '2023' } },
  };

  it('row 11: a non-integer [ID!] value is InvalidInput on its field, not "no filter"', async () => {
    const { status, body } = await post(
      `query($filter: AnalyticsFilterInput!) {
        entityAnalytics(filter: $filter, limit: 5) { nodes { entity_cui } pageInfo { totalCount } }
      }`,
      { filter: { account_category: 'ch', report_period: PERIOD_2023, uat_ids: ['abc'] } }
    );
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    const [error] = body.errors ?? [];
    expect(error?.message).toContain("uat_ids must contain integer ids; got 'abc'");
    expect(error?.extensions).toEqual({
      code: GRAPHQL_ERROR_CODE.InvalidInput,
      type: 'InvalidInput',
      field: 'uat_ids',
    });
  });

  it('row 12: an unbounded period selection is InvalidInput on report_period', async () => {
    const { status, body } = await post(
      `query($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) { seriesId data { x y } }
      }`,
      {
        inputs: [
          {
            seriesId: 'unbounded',
            filter: {
              account_category: 'ch',
              report_period: { type: 'YEAR', selection: { dates: ['nope'] } },
            },
          },
        ],
      }
    );
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    const [error] = body.errors ?? [];
    expect(error?.message).toMatch(/^unbounded budget scan: report_period\.selection/u);
    expect(error?.extensions).toEqual({
      code: GRAPHQL_ERROR_CODE.InvalidInput,
      type: 'InvalidInput',
      field: 'report_period',
    });
  });

  it('row 13: the envelope carries code/type/field and nothing else (no stack, no exception)', async () => {
    const { body } = await post(
      `query($filter: AnalyticsFilterInput!) {
        aggregatedLineItems(filter: $filter, limit: 5) { nodes { functional_code } }
      }`,
      { filter: { account_category: 'ch', report_period: PERIOD_2023, budget_sector_ids: ['x'] } }
    );
    const [error] = body.errors ?? [];
    expect(Object.keys(error?.extensions ?? {}).sort()).toEqual(['code', 'field', 'type']);
    expect(JSON.stringify(body)).not.toMatch(/stacktrace|exception/u);
  });

  it('a well-formed executionAnalytics document is served from the fake aggregate, per period', async () => {
    const { body } = await post(
      `query($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) { seriesId missingPeriods data { x y } }
      }`,
      {
        inputs: [
          {
            seriesId: 'q',
            filter: {
              account_category: 'ch',
              report_period: {
                type: 'QUARTER',
                selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
              },
            },
          },
        ],
      }
    );
    expect(body.errors ?? []).toEqual([]);
    const series = (
      body.data?.['executionAnalytics'] as { seriesId: string; data: { x: string; y: number }[] }[]
    )[0];
    expect(series?.seriesId).toBe('q');
    expect(series?.data.map((p) => p.x)).toEqual(['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4']);
    expect(series?.data.every((p) => p.y === 1000)).toBe(true);
  });
  // Last on purpose: vitest runs the blocks above in definition order, so this
  // covers every request the file made, corpus and hand-written alike.
  it('no fake let a query through to the (closed) serving database', () => {
    expect(captured).toEqual([]);
  });
});
