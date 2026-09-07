/** Annual denominators over actual budget DDL; oracle reads facts, not serving MVs. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeBudgetRepo, type BudgetRepoOptions } from '@/modules/budget/shell/repo/budget-repo.js';

import type { TimeseriesQuery } from '@/modules/budget/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;
const query: TimeseriesQuery = {
  entityCui: '111',
  reportType: 'EXECUTION_DETAILED',
  metric: 'EXPENSE',
  frequency: 'YEAR',
  normalization: 'PER_CAPITA',
  yearFrom: 2023,
  yearTo: 2024,
};

const prepare = async (db: Kysely<ProdDatabase>): Promise<number> => {
  // Two creditors, cancellation and negative amounts must survive SQL scoping.
  await sql`update budget.execution_line_items set main_creditor_cui='444', economic_code=case when account_category='ch' then '20.01.30' else null end
    where entity_cui='111' and functional_code='51.01.03'`.execute(db);
  for (const frequency of ['annual', 'quarterly', 'monthly'])
    await sql`refresh materialized view ${sql.ref('budget.mv_execution_summary_' + frequency)}`.execute(
      db
    );
  const anchor = await db
    .selectFrom('core.public_entities')
    .select('territory_id')
    .where('cui', '=', '111')
    .executeTakeFirstOrThrow();
  return anchor.territory_id!;
};

export function registerBudgetEvolutionCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
): void {
  for (const frequency of ['YEAR', 'QUARTER', 'MONTH'] as const) {
    it(`annual evolution uses the matching year and creditor at ${frequency} grain`, async () =>
      fixture(async (db) => {
        const anchor = await prepare(db);
        const selections: unknown[] = [];
        const populationRelation: NonNullable<BudgetRepoOptions['populationRelation']> = async (
          selection
        ) => {
          selections.push(selection);
          return ok(
            sql`select ${anchor}::bigint territory_id, year, population from (values (2023,100::numeric),(2024,200::numeric)) cells(year,population)`
          );
        };
        const repo = makeBudgetRepo(db, { populationRelation });
        const amountCol =
          frequency === 'YEAR'
            ? 'ytd_amount'
            : frequency === 'QUARTER'
              ? 'quarterly_amount'
              : 'monthly_amount';
        const flag =
          frequency === 'YEAR'
            ? 'is_yearly'
            : frequency === 'QUARTER'
              ? 'is_quarterly'
              : 'is_monthly';
        const period =
          frequency === 'YEAR'
            ? sql`null::int`
            : sql.ref(frequency === 'QUARTER' ? 'quarter' : 'reporting_month');
        for (const creditor of [undefined, '111', '444']) {
          const result = (
            await repo.executionTimeseries({
              ...query,
              frequency,
              ...(creditor === undefined ? {} : { mainCreditorCui: creditor }),
            })
          )._unsafeUnwrap();
          const oracle = await sql<{ year: number; period: number | null; amount: string }>`
          select reporting_year as year, ${period} as period,
            (sum(${sql.ref(amountCol)}) / case reporting_year when 2023 then 100::numeric else 200::numeric end)::text amount
          from budget.execution_line_items where entity_cui='111' and report_type='Executie bugetara detaliata'
            and account_category='ch' and ${sql.ref(flag)} and reporting_year between 2023 and 2024
            ${creditor === undefined ? sql`` : sql`and main_creditor_cui=${creditor}`}
          group by reporting_year, ${period} order by reporting_year, ${period}`.execute(db);
          expect(result.length).toBeGreaterThan(0);
          expect(result.map((r) => r.periodLabel)).toEqual(
            oracle.rows.map((r) =>
              frequency === 'YEAR'
                ? String(r.year)
                : frequency === 'QUARTER'
                  ? `${String(r.year)}-Q${String(r.period)}`
                  : `${String(r.year)}-${String(r.period).padStart(2, '0')}`
            )
          );
          result.forEach((r, i) => {
            expect(new Decimal(r.amount).eq(oracle.rows[i]!.amount)).toBe(true);
          });
        }
        expect(selections).toHaveLength(3);
        for (const selection of selections)
          expect(selection).toEqual({
            territoryIds: [anchor],
            years: expect.arrayContaining([2023, 2024]),
          });
      }));
  }
  it('annual evolution leaves missing years unavailable and never falls back to snapshot population', async () =>
    fixture(async (db) => {
      const anchor = await prepare(db);
      const repo = makeBudgetRepo(db, {
        populationRelation: async () =>
          ok(
            sql`select ${anchor}::bigint territory_id, year, population from (values (2023,100::numeric),(2024,null::numeric)) cells(year,population)`
          ),
      });
      const result = (await repo.executionTimeseries(query))._unsafeUnwrap();
      expect(result.map((r) => r.periodLabel)).toEqual(['2023']);
      const unavailable = makeBudgetRepo(db, {
        populationRelation: async () =>
          err({ type: 'ServiceUnavailable', message: 'Admission failed' }),
      });
      expect((await unavailable.executionTimeseries(query))._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: 'Admission failed',
      });
    }));
  it('annual evolution skips population reads for nominal, empty, unmatched and non-executive series', async () =>
    fixture(async (db) => {
      await prepare(db);
      let calls = 0;
      const repo = makeBudgetRepo(db, {
        populationRelation: async () => {
          calls++;
          return err({ type: 'ServiceUnavailable', message: 'Unexpected read' });
        },
      });
      expect(
        (await repo.executionTimeseries({ ...query, normalization: 'TOTAL' }))._unsafeUnwrap()
          .length
      ).toBe(2);
      for (const overrides of [
        { entityCui: '222' },
        { entityCui: '333' },
        { yearFrom: 2026, yearTo: 2026 },
        { mainCreditorCui: '999' },
      ])
        expect(
          (await repo.executionTimeseries({ ...query, ...overrides }))._unsafeUnwrap()
        ).toEqual([]);
      expect(
        (await repo.executionTimeseries({ ...query, mainCreditorCui: 'invalid' })).isErr()
      ).toBe(true);
      expect(calls).toBe(0);
    }));
  it('annual evolution preserves zero and negative scoped totals without a client ratio', async () =>
    fixture(async (db) => {
      const anchor = await prepare(db);
      await sql`update budget.execution_line_items set ytd_amount=case when main_creditor_cui='111' then 100 else -100 end
      where entity_cui='111' and account_category='ch' and is_yearly`.execute(db);
      await sql`refresh materialized view budget.mv_execution_summary_annual`.execute(db);
      const repo = makeBudgetRepo(db, {
        populationRelation: async () =>
          ok(
            sql`select ${anchor}::bigint territory_id, year, 100::numeric population from (values (2023),(2024)) y(year)`
          ),
      });
      for (const [creditor, expected] of [
        [undefined, 0],
        ['111', 1],
        ['444', -1],
      ] as const) {
        const rows = (
          await repo.executionTimeseries({
            ...query,
            ...(creditor === undefined ? {} : { mainCreditorCui: creditor }),
          })
        )._unsafeUnwrap();
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => new Decimal(r.amount).eq(expected))).toBe(true);
      }
    }));
}
