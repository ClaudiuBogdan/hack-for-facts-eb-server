/**
 * `legacyExecutionSeries` over in-memory fakes: one series per input in input
 * order; first error aborts the batch; `seriesId ?? 'default'`; `[]` / null are
 * "no filter"; composites; percent_gdp exclusivity; per-capita denominators;
 * the cap is reported, never silent; the resolver's Decimal → Float boundary.
 */

import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { cleanFilter } from '../../../../src/modules/budget/core/legacy-analytics/clean.js';
import { legacyDecimal } from '../../../../src/modules/budget/core/legacy-analytics/decimal.js';
import { legacyExecutionSeries } from '../../../../src/modules/budget/core/legacy-analytics/usecase.js';
import { chainLinkCpiLevels } from '../../../../src/modules/budget/shell/factors/cpi-level.js';
import { toGraphqlSeries } from '../../../../src/modules/budget/shell/graphql/legacy/resolvers.js';

import type {
  FactorKind,
  FactorSource,
  LegacyAggregateResult,
  LegacyExecutionAggregateRepo,
  PopulationSource,
} from '../../../../src/modules/budget/core/legacy-analytics/ports.js';
import type {
  LegacyAggregateQuery,
  LegacyAnalyticsFilter,
  LegacyAnalyticsInput,
  PopulationScope,
} from '../../../../src/modules/budget/core/legacy-analytics/types.js';

const filter = (over: Partial<LegacyAnalyticsFilter> = {}): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2022', end: '2023' } } },
  ...over,
});

const rows: LegacyAggregateResult = {
  rows: [
    { year: 2022, periodValue: 2022, amount: '1000.50' },
    { year: 2023, periodValue: 2023, amount: '2001.00' },
  ],
  capped: false,
};

const makeAggregate = (
  fn: (q: LegacyAggregateQuery) => LegacyAggregateResult | Error
): { repo: LegacyExecutionAggregateRepo; calls: LegacyAggregateQuery[] } => {
  const calls: LegacyAggregateQuery[] = [];
  return {
    calls,
    repo: {
      legacyExecutionAggregate: (q) => {
        calls.push(q);
        const r = fn(q);
        return Promise.resolve(
          r instanceof Error ? err({ type: 'Database', message: r.message }) : ok(r)
        );
      },
    },
  };
};

const factors = (data: Partial<Record<FactorKind, Record<number, string>>>): FactorSource => ({
  yearly: (kind) => {
    const series = data[kind];
    if (series === undefined) return Promise.resolve(ok(null));
    return Promise.resolve(
      ok(new Map(Object.entries(series).map(([y, v]) => [Number(y), new Decimal(v)])))
    );
  },
});

const population = (
  fn: (scope: PopulationScope) => Decimal | null
): { source: PopulationSource; scopes: PopulationScope[] } => {
  const scopes: PopulationScope[] = [];
  return {
    scopes,
    source: {
      scopedPopulation: (scope) => {
        scopes.push(scope);
        return Promise.resolve(ok(fn(scope)));
      },
    },
  };
};

const noPopulation = population(() => null);

describe('legacyExecutionSeries', () => {
  it('returns one series per input, in input order, with seriesId ?? "default"', async () => {
    const agg = makeAggregate(() => rows);
    const inputs: LegacyAnalyticsInput[] = [
      { seriesId: 'b', filter: filter({ account_category: 'vn' }) },
      { filter: filter() },
      {
        seriesId: 'a',
        filter: filter({ report_period: { type: 'MONTH', selection: { dates: ['2023-01'] } } }),
      },
    ];
    const out = (
      await legacyExecutionSeries(
        { aggregate: agg.repo, factors: factors({}), population: noPopulation.source },
        inputs
      )
    )._unsafeUnwrap();
    expect(out.map((s) => s.seriesId)).toEqual(['b', 'default', 'a']);
    expect(agg.calls.map((q) => q.accountCategory)).toEqual(['vn', 'ch', 'ch']);
    expect(out[0]?.xAxis).toEqual({ name: 'Year', type: 'INTEGER', unit: 'year' });
    expect(out[2]?.xAxis).toEqual({ name: 'Month', type: 'STRING', unit: 'month' });
    expect(out[0]?.yAxis).toEqual({ name: 'Amount', type: 'FLOAT', unit: 'RON' });
    expect(out[0]?.data.map((p) => [p.x, p.y.toString()])).toEqual([
      ['2022', '1000.5'],
      ['2023', '2001'],
    ]);
  });

  it('the first error aborts the batch (no partial output)', async () => {
    let n = 0;
    const agg = makeAggregate(() => (n++ === 1 ? new Error('boom') : rows));
    const res = await legacyExecutionSeries(
      { aggregate: agg.repo, factors: factors({}), population: noPopulation.source },
      [{ filter: filter() }, { filter: filter() }, { filter: filter() }]
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'Database', message: 'boom' });
    expect(agg.calls).toHaveLength(2);
  });

  it('an invalid input aborts before any query (InvalidInput)', async () => {
    const agg = makeAggregate(() => rows);
    const res = await legacyExecutionSeries(
      { aggregate: agg.repo, factors: factors({}), population: noPopulation.source },
      [
        { filter: filter({ report_type: 'Executie - Angajamente bugetare detaliat' }) },
        { filter: filter() },
      ]
    );
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(agg.calls).toHaveLength(0);
  });

  it('reports the cap through onCapped (never silent) and keeps the rows it got', async () => {
    const agg = makeAggregate(() => ({ ...rows, capped: true }));
    const capped: string[] = [];
    const out = (
      await legacyExecutionSeries(
        {
          aggregate: agg.repo,
          factors: factors({}),
          population: noPopulation.source,
          onCapped: ({ seriesId }) => capped.push(seriesId),
        },
        [{ seriesId: 'big', filter: filter() }]
      )
    )._unsafeUnwrap();
    expect(capped).toEqual(['big']);
    expect(out[0]?.data).toHaveLength(2);
  });

  it('total_euro overrides the currency to EUR and reads the EUR rate; percent_gdp reads only GDP', async () => {
    const asked: FactorKind[] = [];
    const spy: FactorSource = {
      yearly: (kind) => {
        asked.push(kind);
        return Promise.resolve(ok(null));
      },
    };
    const agg = makeAggregate(() => rows);
    await legacyExecutionSeries(
      { aggregate: agg.repo, factors: spy, population: noPopulation.source },
      [
        {
          filter: filter({
            normalization: 'total_euro',
            currency: 'USD',
            inflation_adjusted: true,
          }),
        },
        {
          filter: filter({
            normalization: 'percent_gdp',
            currency: 'EUR',
            inflation_adjusted: true,
          }),
        },
      ]
    );
    expect(asked).toEqual(['cpi_index', 'ron_per_eur', 'gdp_ron']);
  });

  it('per_capita with no entity filter divides by the LATEST country population from the factor source', async () => {
    const agg = makeAggregate(() => rows);
    const pop = population(() => new Decimal('1'));
    const out = (
      await legacyExecutionSeries(
        {
          aggregate: agg.repo,
          factors: factors({ population_ro: { 2022: '19050000', 2023: '19000000' } }),
          population: pop.source,
        },
        [{ filter: filter({ normalization: 'per_capita', regions: ['Nord-Est'] }) }]
      )
    )._unsafeUnwrap();
    expect(pop.scopes).toEqual([]); // regions do not narrow the denominator (legacy)
    expect(out[0]?.data[0]?.y.toString()).toBe(legacyDecimal('1000.50').div('19000000').toString());
    expect(out[0]?.yAxis.unit).toBe('RON/capita');
  });

  it('per_capita with entity_cuis asks the population source with the legacy priority scope', async () => {
    const agg = makeAggregate(() => rows);
    const pop = population(() => new Decimal('250'));
    const out = (
      await legacyExecutionSeries(
        { aggregate: agg.repo, factors: factors({}), population: pop.source },
        [
          {
            filter: filter({
              normalization: 'per_capita_euro',
              entity_cuis: ['111'],
              uat_ids: ['5'],
              county_codes: ['CJ'],
            }),
          },
        ]
      )
    )._unsafeUnwrap();
    expect(pop.scopes).toEqual([{ kind: 'entities', cuis: ['111'] }]);
    // No FX dataset → EUR requested but unadjusted (legacy policy); divided by 250.
    expect(out[0]?.data[0]?.y.toString()).toBe(legacyDecimal('1000.50').div('250').toString());
    expect(out[0]?.yAxis.unit).toBe('EUR/capita');
  });

  it('a population source error aborts (DELTA: legacy silently disabled per-capita)', async () => {
    const agg = makeAggregate(() => rows);
    const failing: PopulationSource = {
      scopedPopulation: () => Promise.resolve(err({ type: 'Database', message: 'pop failed' })),
    };
    const res = await legacyExecutionSeries(
      { aggregate: agg.repo, factors: factors({}), population: failing },
      [{ filter: filter({ normalization: 'per_capita', uat_ids: ['7'] }) }]
    );
    expect(res._unsafeUnwrapErr().type).toBe('Database');
  });

  it('inflation_adjusted labels the axis with the CPI base year actually used', async () => {
    const agg = makeAggregate(() => rows);
    // The port carries the D2 LEVEL: chain-link the YoY fixture as the adapter does.
    const levels = Object.fromEntries(
      chainLinkCpiLevels(
        new Map([
          [2022, new Decimal('113.80')],
          [2023, new Decimal('110.40')],
          [2024, new Decimal('105.59')],
        ])
      )
    );
    const out = (
      await legacyExecutionSeries(
        {
          aggregate: agg.repo,
          factors: factors({ cpi_index: levels }),
          population: noPopulation.source,
        },
        [{ filter: filter({ inflation_adjusted: true }) }]
      )
    )._unsafeUnwrap();
    expect(out[0]?.yAxis.unit).toBe('RON (real 2024)');
    // 2023 → × level(2024)/level(2023) = 1.0559 exactly on this short chain.
    expect(out[0]?.data[1]?.y.toString()).toBe(new Decimal('2001.00').mul('1.0559').toString());
  });

  it('toGraphqlSeries converts y to a Float only at the boundary', () => {
    const gql = toGraphqlSeries({
      seriesId: 's',
      xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
      yAxis: { name: 'Amount', type: 'FLOAT', unit: 'RON' },
      data: [{ x: '2022', y: new Decimal('1000.5') }],
    });
    expect(gql.data).toEqual([{ x: '2022', y: 1000.5 }]);
  });
});

describe('cleanFilter — the compatibility manifest', () => {
  it('`[]` and null mean "no filter" for every list; empty exclude vanishes', () => {
    const q = cleanFilter(
      filter({
        entity_cuis: [],
        functional_codes: null,
        uat_ids: [],
        tags: [],
        exclude: { report_ids: [], tags: null, uat_ids: [] },
        search: '   ',
        report_type: null,
      })
    )._unsafeUnwrap();
    expect(q.entityCuis).toBeUndefined();
    expect(q.functionalCodes).toBeUndefined();
    expect(q.uatIds).toBeUndefined();
    expect(q.tagFacets).toBeUndefined();
    expect(q.exclude).toBeUndefined();
    expect(q.search).toBeUndefined();
    expect(q.reportType).toBeNull();
  });

  it('parses ids, carries amounts as decimal strings, groups tags by facet', () => {
    const q = cleanFilter(
      filter({
        uat_ids: ['12', ' 7 '],
        funding_source_ids: ['2'],
        budget_sector_ids: ['5'],
        item_min_amount: 0.1,
        aggregate_max_amount: 1e15,
        tags: ['kind::school', 'coverage::local', 'kind::hospital', 'kind::school'],
        exclude: { main_creditor_cui: '999', program_codes: ['P1'], tags: ['role::operator'] },
      })
    )._unsafeUnwrap();
    expect(q.uatIds).toEqual([12, 7]);
    expect(q.fundingSourceIds).toEqual([2]);
    expect(q.budgetSectorIds).toEqual([5]);
    expect(q.itemMinAmount).toBe('0.1');
    expect(q.aggregateMaxAmount).toBe('1000000000000000');
    expect(q.tagFacets).toEqual([['kind::school', 'kind::hospital'], ['coverage::local']]);
    expect(q.exclude).toEqual({
      mainCreditorCui: '999',
      programCodes: ['P1'],
      tags: ['role::operator'],
    });
  });

  it('DELTA: a non-integer id is InvalidInput (legacy dropped it and widened the filter)', () => {
    const res = cleanFilter(filter({ uat_ids: ['abc'] }));
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'uat_ids' });
  });

  it('malformed tags are rejected loudly (legacy BAD_USER_INPUT)', () => {
    expect(cleanFilter(filter({ tags: ['Kind::School'] }))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    expect(
      cleanFilter(filter({ exclude: { tags: ['nocolon'] } }))._unsafeUnwrapErr()
    ).toMatchObject({
      type: 'InvalidInput',
      field: 'exclude.tags',
    });
  });

  it('accepts an execution report literal and rejects a commitment one', () => {
    expect(
      cleanFilter(filter({ report_type: 'Executie bugetara detaliata' }))._unsafeUnwrap().reportType
    ).toBe('Executie bugetara detaliata');
    expect(
      cleanFilter(
        filter({ report_type: 'Executie - Angajamente bugetare agregat principal' })
      )._unsafeUnwrapErr().message
    ).toContain('COMMITMENT_*');
  });
});
