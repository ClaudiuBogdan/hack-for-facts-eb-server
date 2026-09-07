/** Ranking oracle uses source facts and independently supplied annual populations. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeBudgetRepo, type BudgetRepoOptions } from '@/modules/budget/shell/repo/budget-repo.js';

import type { EntityRankingPageQuery } from '@/modules/budget/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;
const query: EntityRankingPageQuery = {
  year: 2023,
  reportType: 'EXECUTION_DETAILED',
  frequency: 'YEAR',
  metric: 'EXPENSE',
  normalization: 'TOTAL',
  limit: 5,
  offset: 0,
};

export function registerBudgetRankingPopulationCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
): void {
  const prepare = async (db: Kysely<ProdDatabase>) => {
    // A second creditor must be collapsed unless explicitly selected.
    await sql`update budget.execution_line_items set main_creditor_cui='444', economic_code=case when account_category='ch' then '20.01.30' else null end
      where entity_cui='111' and functional_code='51.01.03'`.execute(db);
    await sql`update budget.execution_line_items set economic_code='20.01.30' where account_category='ch'`.execute(
      db
    );
    await sql`update budget.execution_line_items set entity_cui='444' where entity_cui='333'`.execute(
      db
    );
    for (const grain of ['annual', 'quarterly', 'monthly'])
      await sql`refresh materialized view ${sql.ref('budget.mv_execution_summary_' + grain)}`.execute(
        db
      );
    const anchors = await db
      .selectFrom('core.public_entities')
      .select(['cui', 'territory_id', 'is_territorial_executive'])
      .execute();
    const selections: Parameters<NonNullable<BudgetRepoOptions['populationRelation']>>[0][] = [];
    const populationRelation: NonNullable<BudgetRepoOptions['populationRelation']> = async (
      selection
    ) => {
      selections.push(selection);
      // Cluj's small fixture population deliberately reverses the static ordering.
      return ok(
        sql`select * from jsonb_to_recordset(${JSON.stringify(anchors.filter((a) => selection.territoryIds.includes(a.territory_id!)).map((a) => ({ territory_id: a.territory_id, year: selection.years[0], population: a.cui === '111' ? '1' : a.cui === '444' ? '1000000' : null })))}::jsonb) as p(territory_id bigint,year int,population numeric)`
      );
    };
    return { anchors, selections, repo: makeBudgetRepo(db, { populationRelation }) };
  };
  for (const frequency of ['YEAR', 'QUARTER', 'MONTH'] as const) {
    it(`annual ranking uses source money and selected-year population at ${frequency} grain`, async () =>
      fixture(async (db) => {
        const { repo, selections, anchors } = await prepare(db);
        const q = {
          ...query,
          frequency,
          ...(frequency === 'MONTH'
            ? { month: 12 }
            : frequency === 'QUARTER'
              ? { quarter: 4 }
              : {}),
          normalization: 'PER_CAPITA' as const,
          limit: 1,
        };
        for (const mainCreditorCui of [undefined, '111', '444']) {
          const page = (
            await repo.rankEntitiesPage({
              ...q,
              ...(mainCreditorCui === undefined ? {} : { mainCreditorCui }),
            })
          )._unsafeUnwrap();
          const col =
            frequency === 'YEAR'
              ? 'ytd_amount'
              : frequency === 'MONTH'
                ? 'monthly_amount'
                : 'quarterly_amount';
          const flag =
            frequency === 'YEAR'
              ? 'is_yearly'
              : frequency === 'MONTH'
                ? 'is_monthly'
                : 'is_quarterly';
          const oracle = await sql<{
            entity_cui: string;
            amount: string;
          }>`select f.entity_cui,(sum(${sql.ref(col)}) / case when f.entity_cui='111' then 1::numeric else 1000000::numeric end)::text amount
          from budget.execution_line_items f join core.public_entities e on e.cui=f.entity_cui
          where reporting_year=2023 and report_type='Executie bugetara detaliata' and account_category='ch' and ${sql.ref(flag)} and e.is_territorial_executive
          ${frequency === 'MONTH' ? sql`and reporting_month=12` : frequency === 'QUARTER' ? sql`and quarter=4` : sql``}
          ${mainCreditorCui === undefined ? sql`` : sql`and main_creditor_cui=${mainCreditorCui}`}
          group by f.entity_cui order by sum(${sql.ref(col)}) / case when f.entity_cui='111' then 1::numeric else 1000000::numeric end desc, f.entity_cui`.execute(
            db
          );
          expect(page.total).toBe(oracle.rows.length);
          expect(page.items.map((x) => x.entityCui)).toEqual(
            oracle.rows.slice(0, 1).map((x) => x.entity_cui)
          );
          if (page.items.length > 0)
            expect(new Decimal(page.items[0]!.perCapita!).eq(oracle.rows[0]!.amount)).toBe(true);
        }
        expect(selections.every((s) => s.years.length === 1 && s.years[0] === 2023)).toBe(true);
        expect([...selections[0]!.territoryIds].sort()).toEqual(
          anchors
            .filter((a) => ['111', '444'].includes(a.cui))
            .map((a) => a.territory_id)
            .sort()
        );
      }));
  }
  it('nominal ranking preserves every page and fetches only that page executive anchors', async () =>
    fixture(async (db) => {
      const { repo, selections, anchors } = await prepare(db);
      for (const sort of ['AMOUNT', 'ENTITY_NAME', 'ENTITY_TYPE', 'COUNTY'] as const) {
        for (const ascending of [true, false]) {
          const order = {
            AMOUNT: sql`sum(f.ytd_amount)`,
            ENTITY_NAME: sql`e.name`,
            ENTITY_TYPE: sql`e.entity_type`,
            COUNTY: sql`t.county_name`,
          }[sort];
          const oracle = await sql<{
            entityCui: string;
            amount: string;
          }>`select f.entity_cui as "entityCui", sum(f.ytd_amount)::text amount
          from budget.execution_line_items f left join core.public_entities e on e.cui=f.entity_cui left join core.territories t on t.id=e.territory_id
          where f.reporting_year=2023 and f.report_type='Executie bugetara detaliata' and f.account_category='ch' and f.is_yearly
          group by f.entity_cui,e.name,e.entity_type,t.county_name
          order by ${order} ${ascending ? sql`asc` : sql`desc`} nulls last, f.entity_cui asc`.execute(
            db
          );
          const all = { items: oracle.rows, total: oracle.rows.length };
          for (let offset = 0; offset <= all.total; offset++) {
            selections.length = 0;
            const response = await repo.rankEntitiesPage({
              ...query,
              sort,
              ascending,
              limit: 1,
              offset,
            });
            expect(
              response.isOk(),
              `${sort} ${String(ascending)} ${String(offset)}: ${JSON.stringify(response.isErr() ? response.error : null)}`
            ).toBe(true);
            const result = response._unsafeUnwrap();
            expect(result.total).toBe(all.total);
            expect(
              result.items.map((x) => [x.entityCui, new Decimal(x.amount).toString()])
            ).toEqual(
              all.items
                .slice(offset, offset + 1)
                .map((x) => [x.entityCui, new Decimal(x.amount).toString()])
            );
            const expected = anchors
              .filter(
                (a) =>
                  a.is_territorial_executive &&
                  a.territory_id !== null &&
                  a.cui === result.items[0]?.entityCui
              )
              .map((a) => a.territory_id);
            expect(selections).toEqual(
              expected.length > 0 ? [{ territoryIds: expected, years: [2023] }] : []
            );
            if (result.items[0]?.entityCui === '222')
              expect(result.items[0]).toMatchObject({ population: null, perCapita: null });
          }
        }
      }
    }));
  it('annual bounds and ordering precede paging and empty offsets retain the count without recursion', async () =>
    fixture(async (db) => {
      const { repo, selections } = await prepare(db);
      const cases = [
        { sort: 'POPULATION' as const },
        { sort: 'PER_CAPITA' as const },
        { minPopulation: 10 },
        { maxPopulation: 10 },
        { normalization: 'PER_CAPITA' as const },
        { normalization: 'PER_CAPITA' as const, sort: 'AMOUNT' as const },
      ];
      for (const extra of cases) {
        selections.length = 0;
        const firstResult = await repo.rankEntitiesPage({ ...query, ...extra, limit: 1 });
        if (firstResult.isErr())
          throw firstResult.error.type === 'Database'
            ? firstResult.error.cause
            : new Error(firstResult.error.message);
        const first = firstResult.value;
        expect(selections).toHaveLength(1);
        expect(selections[0]!.territoryIds).toHaveLength(2);
        selections.length = 0;
        const emptyResult = await repo.rankEntitiesPage({
          ...query,
          ...extra,
          limit: 1,
          offset: 999,
        });
        if (emptyResult.isErr())
          throw emptyResult.error.type === 'Database'
            ? emptyResult.error.cause
            : new Error(emptyResult.error.message);
        const empty = emptyResult.value;
        expect(empty).toEqual({ items: [], total: first.total });
        expect(selections).toHaveLength(1);
        if ('minPopulation' in extra) expect(first.items[0]?.entityCui).toBe('444');
        if ('maxPopulation' in extra || extra.sort === 'PER_CAPITA')
          expect(first.items[0]?.entityCui).toBe('111');
      }
      const missing = makeBudgetRepo(db, {
        populationRelation: async () =>
          ok(
            sql`select null::bigint territory_id, 2023::int as year, null::numeric population where false`
          ),
      });
      expect(
        (await missing.rankEntitiesPage({ ...query, normalization: 'PER_CAPITA' }))._unsafeUnwrap()
      ).toEqual({ items: [], total: 0 });
      expect(
        (await missing.rankEntitiesPage(query))
          ._unsafeUnwrap()
          .items.every((x) => x.population === null && x.perCapita === null)
      ).toBe(true);
    }));
}
