/** Actual grouped SQL against migration DDL, with independent annual population fixtures. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import { makeGroupedAnalyticsRepo } from '@/modules/budget/shell/repo/grouped-analytics-repo.js';

import type { GroupedQuery } from '@/modules/budget/core/legacy-analytics/grouped-types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;
const query = (extra: Partial<GroupedQuery> = {}): GroupedQuery => ({
  filter: cleanFilter({
    account_category: 'ch',
    report_type: 'Executie bugetara detaliata',
    report_period: { type: 'YEAR', selection: { dates: ['2023', '2024'] } },
  })._unsafeUnwrap(),
  moneyMultipliers: new Map([
    [2023, legacyDecimal(2)],
    [2024, legacyDecimal(3)],
  ]),
  mode: 'total',
  requirePopulation: false,
  limit: 50,
  offset: 0,
  sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
  ...extra,
});

export function registerBudgetAnnualTableCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
) {
  const prepare = async (db: Kysely<ProdDatabase>, missing?: string) => {
    await sql`update budget.execution_line_items set entity_cui='444' where entity_cui='333'`.execute(
      db
    );
    const anchors = await db
      .selectFrom('core.public_entities')
      .select(['cui', 'territory_id'])
      .where('cui', 'in', ['111', '444'])
      .execute();
    const selected: { territoryIds: readonly number[]; years: readonly number[] }[] = [];
    const populations = new Map(
      anchors.map((a) => [
        a.territory_id!,
        new Map([
          [2023, a.cui === '111' ? '100' : '1000'],
          [2024, a.cui === '111' ? '200' : '50'],
        ]),
      ])
    );
    const repo = makeGroupedAnalyticsRepo(db, {
      annualPopulationRelation: async (selection) => {
        selected.push(selection);
        return ok(
          sql`select * from jsonb_to_recordset(${JSON.stringify(selection.territoryIds.flatMap((id) => selection.years.map((year) => ({ territory_id: id, year, population: missing === `${String(id)}:${String(year)}` ? null : (populations.get(id)?.get(year) ?? null) }))))}::jsonb) as p(territory_id bigint,year int,population numeric)`
        );
      },
    });
    return { repo, selected, anchors, populations };
  };
  it('annual entity table uses yearly divisors and latest metadata after creditor collapse', async () =>
    fixture(async (db) => {
      const { repo, selected, anchors, populations } = await prepare(db);
      const q = query();
      const result = (await repo.entities(q))._unsafeUnwrap();
      const facts = await sql<{
        cui: string;
        year: number;
        amount: string;
      }>`select entity_cui as cui,reporting_year as year,sum(ytd_amount)::text amount from budget.execution_line_items where is_yearly and account_category='ch' and report_type='Executie bugetara detaliata' and reporting_year in (2023,2024) group by entity_cui,reporting_year`.execute(
        db
      );
      for (const row of result.nodes) {
        const anchor = anchors.find((a) => a.cui === row.entity_cui);
        const cells = anchor !== undefined ? populations.get(anchor.territory_id!) : undefined;
        const values = facts.rows.filter((f) => f.cui === row.entity_cui);
        const expected = values.reduce(
          (n, f) => n.plus(new Decimal(f.amount).mul(f.year === 2023 ? 2 : 3)),
          new Decimal(0)
        );
        expect(row.total_amount.toString()).toBe(expected.toString());
        expect(row.population).toBe(cells !== undefined ? Number(cells.get(2024)) : null);
        if (cells !== undefined) {
          const per = values.reduce(
            (n, f) =>
              n.plus(new Decimal(f.amount).mul(f.year === 2023 ? 2 : 3).div(cells.get(f.year)!)),
            new Decimal(0)
          );
          expect(row.per_capita_amount!.minus(per).abs().lt('1e-12')).toBe(true);
        } else expect(row.per_capita_amount).toBeNull();
      }
      expect(selected).toHaveLength(1);
      expect(selected[0]!.years).toEqual([2023, 2024]);
      const creditor = (
        await repo.entities({ ...q, filter: { ...q.filter, mainCreditorCui: '111' } })
      )._unsafeUnwrap();
      const oracle = await sql<{
        amount: string;
      }>`select sum(ytd_amount*case when reporting_year=2023 then 2 else 3 end)::text amount from budget.execution_line_items where is_yearly and account_category='ch' and report_type='Executie bugetara detaliata' and reporting_year in (2023,2024) and main_creditor_cui='111'`.execute(
        db
      );
      expect(
        creditor.nodes.reduce((n, r) => n.plus(r.total_amount), legacyDecimal(0)).toString()
      ).toBe(
        oracle.rows[0]!.amount === null ? '0' : legacyDecimal(oracle.rows[0]!.amount).toString()
      );
    }));
  it('annual table reference population is independent of latest-year fact presence', async () =>
    fixture(async (db) => {
      const { repo } = await prepare(db);
      await sql`delete from budget.execution_line_items where entity_cui='111' and reporting_year=2024`.execute(
        db
      );
      const q = query();
      const row = (
        await repo.entities({ ...q, filter: { ...q.filter, entityCuis: ['111'] } })
      )._unsafeUnwrap().nodes[0]!;
      expect(row.population).toBe(200);
      expect(row.per_capita_amount!.eq(row.total_amount.div(100))).toBe(true);
    }));
  it('annual table earlier gap preserves latest metadata but withholds interval per capita', async () =>
    fixture(async (db) => {
      const id = (
        await db
          .selectFrom('core.public_entities')
          .select('territory_id')
          .where('cui', '=', '111')
          .executeTakeFirstOrThrow()
      ).territory_id!;
      const { repo } = await prepare(db, `${String(id)}:2023`);
      const q = query();
      const row = (
        await repo.entities({ ...q, filter: { ...q.filter, entityCuis: ['111'] } })
      )._unsafeUnwrap().nodes[0]!;
      expect(row.population).toBe(200);
      expect(row.per_capita_amount).toBeNull();
      for (const page of [{ limit: 0 }, { offset: 999 }, { limit: 1 }])
        expect(
          (
            await repo.entities({
              ...q,
              ...page,
              mode: 'per_capita',
              requirePopulation: true,
              filter: { ...q.filter, aggregateMinAmount: '1000000000', minPopulation: 10000000 },
            })
          )._unsafeUnwrapErr().type
        ).toBe('ServiceUnavailable');
    }));
  it('annual table checks selected years without facts before required bounds and pages', async () =>
    fixture(async (db) => {
      const { repo } = await prepare(db);
      const q = query();
      await sql`delete from budget.execution_line_items where reporting_year=2024`.execute(db);
      const result = await repo.entities({
        ...q,
        moneyMultipliers: new Map([...q.moneyMultipliers, [2025, legacyDecimal(4)]]),
        filter: { ...q.filter, period: { years: { in: [2023, 2024, 2025] } } },
        mode: 'per_capita',
        requirePopulation: true,
        limit: 0,
      });
      expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    }));
  it('annual table uses latest population bounds and nulls last in both sort directions', async () =>
    fixture(async (db) => {
      const { repo } = await prepare(db);
      const q = query();
      for (const order of ['ASC', 'DESC'] as const) {
        const rows = (
          await repo.entities({ ...q, sort: { by: 'POPULATION', order } })
        )._unsafeUnwrap().nodes;
        expect(rows.map((r) => r.entity_cui)).toEqual(
          order === 'ASC' ? ['444', '111', '222'] : ['111', '444', '222']
        );
      }
      const bounded = (
        await repo.entities({
          ...q,
          filter: { ...q.filter, minPopulation: 100, maxPopulation: 300 },
          limit: 0,
        })
      )._unsafeUnwrap();
      expect(bounded.pageInfo.totalCount).toBe(1);
      expect(bounded.nodes).toEqual([]);
      const beyond = (
        await repo.entities({
          ...q,
          filter: { ...q.filter, minPopulation: 100, maxPopulation: 300 },
          offset: 99,
        })
      )._unsafeUnwrap();
      expect(beyond.pageInfo.totalCount).toBe(1);
    }));
  it('annual table ordinary institutions occupy nominal page slots without population reads', async () =>
    fixture(async (db) => {
      const { repo, selected } = await prepare(db);
      await sql`update budget.execution_line_items set ytd_amount=1000000000 where entity_cui='222'`.execute(
        db
      );
      const q = query();
      const page = (await repo.entities({ ...q, limit: 1 }))._unsafeUnwrap();
      expect(page.nodes.map((r) => r.entity_cui)).toEqual(['222']);
      expect(page.nodes[0]!.population).toBeNull();
      expect(selected).toEqual([]);
      await repo.entities({ ...q, limit: 1, sort: { by: 'POPULATION', order: 'ASC' } });
      expect(selected).toHaveLength(1);
      expect(selected[0]!.territoryIds).toHaveLength(2);
    }));
  it('annual table missing latest population stays null and verified zero stays zero', async () =>
    fixture(async (db) => {
      const id = (
        await db
          .selectFrom('core.public_entities')
          .select('territory_id')
          .where('cui', '=', '111')
          .executeTakeFirstOrThrow()
      ).territory_id!;
      const missing = await prepare(db, `${String(id)}:2024`);
      const q = query();
      const row = (
        await missing.repo.entities({ ...q, filter: { ...q.filter, entityCuis: ['111'] } })
      )._unsafeUnwrap().nodes[0]!;
      expect(row.population).toBeNull();
      expect(row.per_capita_amount).toBeNull();
      const zero = await prepare(db);
      zero.populations.get(id)!.set(2024, '0');
      const z = (
        await zero.repo.entities({ ...q, filter: { ...q.filter, entityCuis: ['111'] } })
      )._unsafeUnwrap().nodes[0]!;
      expect(z.population).toBe(0);
      expect(z.per_capita_amount).toBeNull();
    }));
  it('annual table GDP reads only reference population and never returns per-capita GDP', async () =>
    fixture(async (db) => {
      const { repo, selected } = await prepare(db);
      const rows = (await repo.entities(query({ mode: 'percent_gdp' })))._unsafeUnwrap().nodes;
      expect(selected).toHaveLength(1);
      expect(selected[0]!.years).toEqual([2024]);
      expect(rows.every((r) => r.per_capita_amount === null)).toBe(true);
      expect(rows.find((r) => r.entity_cui === '111')!.population).toBe(200);
    }));
}
