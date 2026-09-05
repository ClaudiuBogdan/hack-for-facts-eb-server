/**
 * The aggregate SQL shape (capturing Kysely, no DB): pruning triple first,
 * `report_type IN (<3 execution literals>)` when omitted, the frequency flag + amount column, tuple
 * predicates, joins only when needed, NULL-safe exclusions, the compat
 * translation of funding-source ids, HAVING, `limit 10001`, the 30 s timeout,
 * and the cap flag when 10,001 rows come back.
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

import { cleanFilter } from '../../../../src/modules/budget/core/legacy-analytics/clean.js';
import { LEGACY_ANALYTICS_MAX_POINTS } from '../../../../src/modules/budget/core/legacy-analytics/ports.js';
import { buildFundingSourceMap } from '../../../../src/modules/budget/shell/repo/funding-source-map.js';
import {
  ALL_EXECUTION_REPORT_TYPE_LITERALS,
  legacyJoinNeeds,
  makeLegacyAnalyticsRepo,
} from '../../../../src/modules/budget/shell/repo/legacy-analytics-repo.js';

import type { LegacyAnalyticsFilter } from '../../../../src/modules/budget/core/legacy-analytics/types.js';
import type { ProdDatabase } from '../../../../src/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (
  captured: Captured[],
  rowsFor: (sql: string) => unknown[] = () => []
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: rowsFor(query.sql) as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
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

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

// Phoenix ordinal 2 (B) maps to STORED id 7 (the live prod shape).
const COMPAT = buildFundingSourceMap([
  { sourceId: 0, sourceCode: null, sourceDescription: 'Unknown', internalSourceId: 0 },
  { sourceId: 1, sourceCode: 'A', sourceDescription: 'A', internalSourceId: 1 },
  { sourceId: 2, sourceCode: 'B', sourceDescription: 'B', internalSourceId: 7 },
]);

const filter = (over: Partial<LegacyAnalyticsFilter> = {}): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2022', end: '2023' } } },
  ...over,
});

const run = async (
  f: LegacyAnalyticsFilter,
  rowsFor?: (sql: string) => unknown[]
): Promise<{
  captured: Captured[];
  aggregate: Captured;
  result: Awaited<
    ReturnType<ReturnType<typeof makeLegacyAnalyticsRepo>['legacyExecutionAggregate']>
  >;
}> => {
  const captured: Captured[] = [];
  const repo = makeLegacyAnalyticsRepo(makeCapturingDb(captured, rowsFor), {
    fundingSourceMap: { load: () => Promise.resolve(COMPAT) },
  });
  const result = await repo.legacyExecutionAggregate(cleanFilter(f)._unsafeUnwrap());
  const aggregate = captured.find((c) => c.sql.includes('from budget.execution_line_items'));
  if (aggregate === undefined) throw new Error('aggregate statement not captured');
  return { captured, aggregate, result };
};

describe('legacy executionAnalytics aggregate SQL', () => {
  it('prunes on (year, report_type, account_category) first, flags the frequency, sums the frequency column', async () => {
    const { captured, aggregate } = await run(
      filter({ report_type: 'Executie bugetara detaliata' })
    );
    expect(captured.map((c) => flat(c.sql))).toContain('set local statement_timeout = 30000');
    const sql = flat(aggregate.sql);
    expect(sql).toContain(
      'where "eli"."reporting_year" between $1 and $2 AND "eli"."report_type" = $3 AND "eli"."account_category" = $4 AND "eli"."is_yearly" = true group by'
    );
    expect(aggregate.parameters.slice(0, 4)).toEqual([
      2022,
      2023,
      'Executie bugetara detaliata',
      'ch',
    ]);
    expect(sql).toContain('coalesce(sum("eli"."ytd_amount"), 0)::text as amount');
    expect(sql).toContain('group by "eli"."reporting_year" order by "eli"."reporting_year" asc');
    expect(sql).toContain(`limit $${String(aggregate.parameters.length)}`);
    expect(aggregate.parameters.at(-1)).toBe(LEGACY_ANALYTICS_MAX_POINTS + 1);
    expect(sql).not.toContain('join');
  });

  it('omitted report_type → a parameterized IN over the three supported execution literals (never a bare scan)', async () => {
    const { aggregate } = await run(filter());
    const sql = flat(aggregate.sql);
    expect(sql).toContain(
      'where "eli"."reporting_year" between $1 and $2 AND "eli"."report_type" in ($3, $4, $5) AND "eli"."account_category" = $6 AND "eli"."is_yearly" = true group by'
    );
    expect(aggregate.parameters.slice(2, 5)).toEqual([...ALL_EXECUTION_REPORT_TYPE_LITERALS]);
    expect(ALL_EXECUTION_REPORT_TYPE_LITERALS).toEqual([
      'Executie bugetara detaliata',
      'Executie bugetara agregata la nivel de ordonator principal',
      'Executie bugetara agregata la nivel de ordonator secundar',
    ]);
    // The literals are bound parameters, never inlined text.
    for (const literal of ALL_EXECUTION_REPORT_TYPE_LITERALS) expect(sql).not.toContain(literal);
  });

  it('MONTH: is_monthly + monthly_amount + (year, month) tuple bounds', async () => {
    const { aggregate } = await run(
      filter({
        report_period: {
          type: 'MONTH',
          selection: { interval: { start: '2022-11', end: '2023-02' } },
        },
      })
    );
    const sql = flat(aggregate.sql);
    expect(sql).toContain('"eli"."is_monthly" = true');
    expect(sql).toContain('sum("eli"."monthly_amount")');
    expect(sql).toContain('("eli"."reporting_year", "eli"."reporting_month") >= ($7, $8)');
    expect(sql).toContain('("eli"."reporting_year", "eli"."reporting_month") <= ($9, $10)');
    expect(aggregate.parameters.slice(6, 10)).toEqual([2022, 11, 2023, 2]);
    expect(sql).toContain('order by "eli"."reporting_year" asc, "eli"."reporting_month" asc');
  });

  it('QUARTER dates: is_quarterly + quarterly_amount + an OR of (year, quarter) pairs; years IN', async () => {
    const { aggregate } = await run(
      filter({ report_period: { type: 'QUARTER', selection: { dates: ['2022-Q4', '2023-Q1'] } } })
    );
    const sql = flat(aggregate.sql);
    expect(sql).toContain('"eli"."reporting_year" in ($1, $2)');
    expect(sql).toContain('"eli"."report_type" in ($3, $4, $5)');
    expect(sql).toContain('"eli"."is_quarterly" = true');
    expect(sql).toContain(
      '(("eli"."reporting_year" = $7 and "eli"."quarter" = $8) or ("eli"."reporting_year" = $9 and "eli"."quarter" = $10))'
    );
  });

  it('`[]` lists produce NO predicate (never `in ()` / false)', async () => {
    const { aggregate } = await run(
      filter({
        entity_cuis: [],
        functional_codes: [],
        uat_ids: [],
        tags: [],
        exclude: { regions: [] },
      })
    );
    const sql = flat(aggregate.sql);
    expect(sql).not.toContain('in ()');
    expect(sql).not.toContain('false');
    expect(sql).not.toContain('join');
  });

  it('joins core.public_entities / core.territories only when a predicate needs them', () => {
    expect(legacyJoinNeeds(cleanFilter(filter())._unsafeUnwrap())).toEqual({
      entity: false,
      territory: false,
    });
    expect(legacyJoinNeeds(cleanFilter(filter({ is_uat: true }))._unsafeUnwrap())).toEqual({
      entity: true,
      territory: false,
    });
    expect(
      legacyJoinNeeds(cleanFilter(filter({ exclude: { regions: ['Nord-Est'] } }))._unsafeUnwrap())
    ).toEqual({ entity: true, territory: true });
    expect(legacyJoinNeeds(cleanFilter(filter({ min_population: 1 }))._unsafeUnwrap())).toEqual({
      entity: true,
      territory: true,
    });
  });

  it('entity + territory scope: joins, ILIKE search (escaped), faceted tags, uat_ids on t.id', async () => {
    const { aggregate } = await run(
      filter({
        search: '50%_x',
        tags: ['kind::school', 'kind::hospital', 'coverage::local'],
        uat_ids: ['12'],
        county_codes: ['CJ'],
        regions: ['Nord-Vest'],
        min_population: 1000,
        max_population: 50000,
        entity_types: ['uat'],
        is_uat: true,
      })
    );
    const sql = flat(aggregate.sql);
    expect(sql).toContain('left join core.public_entities as e on e.cui = eli.entity_cui');
    expect(sql).toContain('left join core.territories as t on t.id = e.territory_id');
    expect(sql).toContain('"e"."name" ilike');
    expect(aggregate.parameters).toContain('%50\\%\\_x%');
    expect(sql).toContain('("e"."tags" @> $');
    expect(sql).toContain('::jsonb or "e"."tags" @> $');
    expect(aggregate.parameters).toContain('[{"tag":"kind::school"}]');
    expect(aggregate.parameters).toContain('[{"tag":"coverage::local"}]');
    expect(sql).toContain('"t"."id" in ($');
    expect(sql).toContain('"t"."county_code" in ($');
    expect(sql).toContain('"t"."region" in ($');
    expect(sql).toContain('"t"."population" >= $');
    expect(sql).toContain('"t"."population" <= $');
    expect(sql).toContain('"e"."entity_type" in ($');
    expect(sql).toContain('"e"."is_uat" = $');
  });

  it('translates funding_source_ids through the compat map (phoenix 2 → stored 7; unknown → -1)', async () => {
    const { aggregate } = await run(filter({ funding_source_ids: ['2', '9'] }));
    expect(flat(aggregate.sql)).toContain('"eli"."funding_source_id" in ($');
    expect(aggregate.parameters).toContain(7);
    expect(aggregate.parameters).toContain(-1);
  });

  it('applies every exclusion, NULL-safe on nullable columns; economic ones only on the expense side', async () => {
    const exclude = {
      report_ids: ['r1'],
      entity_cuis: ['111'],
      main_creditor_cui: '999',
      functional_codes: ['51.02'],
      functional_prefixes: ['65'],
      economic_codes: ['10.01'],
      economic_prefixes: ['51'],
      funding_source_ids: ['2', '9'],
      budget_sector_ids: ['3'],
      expense_types: ['dezvoltare' as const],
      program_codes: ['P1'],
      county_codes: ['B'],
      regions: ['Bucuresti-Ilfov'],
      uat_ids: ['5'],
      entity_types: ['uat'],
      tags: ['role::operator'],
    };
    const ch = flat((await run(filter({ exclude }))).aggregate.sql);
    expect(ch).toContain('"eli"."report_id" not in ($');
    expect(ch).toContain('"eli"."entity_cui" not in ($');
    expect(ch).toContain('("eli"."main_creditor_cui" is null or "eli"."main_creditor_cui" <> $');
    expect(ch).toContain('"eli"."functional_code" not in ($');
    expect(ch).toContain('("eli"."functional_code" not like $');
    expect(ch).toContain('("eli"."economic_code" is null or "eli"."economic_code" not in ($');
    expect(ch).toContain('("eli"."economic_code" is null or ("eli"."economic_code" not like $');
    expect(ch).toContain('"eli"."funding_source_id" not in ($');
    expect(ch).toContain('"eli"."budget_sector_id" not in ($');
    expect(ch).toContain('("eli"."expense_type" is null or "eli"."expense_type" not in ($');
    expect(ch).toContain('("eli"."program_code" is null or "eli"."program_code" not in ($');
    expect(ch).toContain('("t"."county_code" is null or "t"."county_code" not in ($');
    expect(ch).toContain('("t"."region" is null or "t"."region" not in ($');
    expect(ch).toContain('("t"."id" is null or "t"."id" not in ($');
    expect(ch).toContain('("e"."entity_type" is null or "e"."entity_type" not in ($');
    expect(ch).toContain('("e"."tags" is null or not ("e"."tags" @> $');

    const vn = flat((await run(filter({ account_category: 'vn', exclude }))).aggregate.sql);
    expect(vn).not.toContain('"eli"."economic_code"');
  });

  it('row thresholds compare numeric to numeric; aggregate thresholds become HAVING (DELTA: legacy ignored)', async () => {
    const { aggregate } = await run(
      filter({
        item_min_amount: 10.5,
        item_max_amount: 1e6,
        aggregate_min_amount: 100,
        aggregate_max_amount: 1e9,
      })
    );
    const sql = flat(aggregate.sql);
    expect(sql).toContain('"eli"."ytd_amount" >= $');
    expect(sql).toContain('::numeric');
    expect(sql).toContain('having coalesce(sum("eli"."ytd_amount"), 0) >= $');
    expect(sql).toContain('and coalesce(sum("eli"."ytd_amount"), 0) <= $');
    expect(aggregate.parameters).toContain('10.5');
    expect(aggregate.parameters).toContain('1000000');
    expect(aggregate.parameters).toContain('100');
    expect(aggregate.parameters).toContain('1000000000');
  });

  it('reports the cap when 10,001 rows come back and trims to 10,000', async () => {
    const many = Array.from({ length: LEGACY_ANALYTICS_MAX_POINTS + 1 }, (_, i) => ({
      year: 2000 + Math.floor(i / 12),
      period_value: (i % 12) + 1,
      amount: '1',
    }));
    const { result } = await run(
      filter({
        report_period: {
          type: 'MONTH',
          selection: { interval: { start: '2000-01', end: '2999-12' } },
        },
      }),
      (sql) => (sql.includes('from budget.execution_line_items') ? many : [])
    );
    const value = result._unsafeUnwrap();
    expect(value.capped).toBe(true);
    expect(value.rows).toHaveLength(LEGACY_ANALYTICS_MAX_POINTS);
  });
});
