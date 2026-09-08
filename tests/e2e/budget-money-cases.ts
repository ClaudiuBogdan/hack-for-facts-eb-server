/** Source-based monetary oracle on the real migrated budget fixture. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeBudgetRepo } from '@/modules/budget/shell/repo/budget-repo.js';

import type { FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;
const factors: FactorSource = {
  yearly: async (kind) =>
    ok(new Map([[2023, new Decimal(kind === 'ron_per_eur' ? '4.9465' : '1590749400000')]])),
};
const query = {
  year: 2023,
  reportType: 'EXECUTION_DETAILED' as const,
  frequency: 'YEAR' as const,
  metric: 'EXPENSE' as const,
  normalization: 'TOTAL_EURO' as const,
  limit: 50,
  offset: 0,
};
export function registerBudgetMoneyCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
): void {
  it('native ranking applies exact source FX before page selection and preserves creditor grouping', async () =>
    fixture(async (db) => {
      await sql`refresh materialized view budget.mv_execution_summary_annual`.execute(db);
      const repo = makeBudgetRepo(db, { moneyFactors: factors });
      const nominal = (
        await makeBudgetRepo(db).rankEntitiesPage({ ...query, normalization: 'TOTAL' })
      )._unsafeUnwrap();
      const page = (await repo.rankEntitiesPage(query))._unsafeUnwrap();
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.total).toBe(nominal.total);
      expect(page.items.map((r) => r.entityCui)).toEqual(nominal.items.map((r) => r.entityCui));
      for (const row of page.items) {
        const value = nominal.items.find((n) => n.entityCui === row.entityCui)!;
        expect(new Decimal(row.amount).toFixed(2)).toBe(
          new Decimal(value.amount).div('4.9465').toFixed(2)
        );
      }
      expect((await repo.rankEntities({ ...query, limit: 1 }))._unsafeUnwrap()).toEqual(
        page.items.slice(0, 1)
      );
      expect(
        (await repo.rankEntitiesPage({ ...query, offset: 999 }))._unsafeUnwrap()
      ).toMatchObject({ total: nominal.total, items: [] });
      const gdp = (
        await repo.rankEntitiesPage({ ...query, normalization: 'PERCENT_GDP' })
      )._unsafeUnwrap();
      expect(gdp.items.every((r) => r.perCapita === null)).toBe(true);
      expect(
        (
          await repo.rankEntitiesPage({
            ...query,
            normalization: 'PERCENT_GDP',
            sort: 'PER_CAPITA',
          })
        ).isErr()
      ).toBe(true);
    }));
  it('native classification bounds use converted money and both heatmaps preserve membership', async () =>
    fixture(async (db) => {
      await sql`refresh materialized view budget.mv_execution_summary_annual`.execute(db);
      const base = makeBudgetRepo(db),
        native = makeBudgetRepo(db, { moneyFactors: factors });
      const classification = {
        filter: {
          reportingYear: { eq: 2023 },
          reportType: { eq: 'EXECUTION_DETAILED' },
          accountCategory: { eq: 'EXPENSE' },
          frequency: { eq: 'YEAR' },
        },
        normalization: 'TOTAL' as const,
        limit: 50,
      };
      const nominal = (await base.aggregateByClassification(classification))._unsafeUnwrap();
      expect(nominal.length).toBeGreaterThan(0);
      const threshold = new Decimal(nominal[0]!.amount).div('4.9465').toFixed(10);
      const converted = (
        await native.aggregateByClassification({
          ...classification,
          normalization: 'TOTAL_EURO',
          minAmount: threshold,
        })
      )._unsafeUnwrap();
      expect(converted.map((r) => [r.functionalCode, r.economicCode])).toEqual(
        nominal
          .filter((r) => new Decimal(r.amount).div('4.9465').gte(threshold))
          .map((r) => [r.functionalCode, r.economicCode])
      );
      // These compatibility-shaped heatmap queries still join uat_code to CUI.
      // Seed that declared legacy contract to isolate monetary behavior; the
      // canonical native map geography is covered by the separate map suite.
      await sql`update core.territories t set uat_code=e.cui
        from core.public_entities e where e.territory_id=t.id and e.is_territorial_executive`.execute(
        db
      );
      for (const method of ['uatHeatmap', 'countyHeatmap'] as const) {
        const before = (await base[method]({ ...query, normalization: 'TOTAL' }))._unsafeUnwrap();
        const after = (await native[method](query))._unsafeUnwrap();
        expect(after.length).toBeGreaterThan(0);
        expect(after.length).toBe(before.length);
        after.forEach((row, i) => {
          expect(new Decimal(row.amount).toFixed(2)).toBe(
            new Decimal(before[i]!.amount).div('4.9465').toFixed(2)
          );
        });
        const gdp = (
          await native[method]({ ...query, normalization: 'PERCENT_GDP' })
        )._unsafeUnwrap();
        expect(gdp.every((r) => r.perCapita === null)).toBe(true);
      }
    }));
  it('native factor errors and missing years precede population discovery even beyond the last page', async () =>
    fixture(async (db) => {
      let calls = 0;
      const populationRelation = async () => {
        calls++;
        return ok(
          sql`select null::bigint territory_id,null::int as year,null::numeric population where false`
        );
      };
      for (const source of [
        factors,
        { yearly: async () => err({ type: 'ServiceUnavailable' as const, message: 'Unadmitted' }) },
      ]) {
        const repo = makeBudgetRepo(db, { moneyFactors: source, populationRelation });
        expect((await repo.rankEntitiesPage({ ...query, year: 2026, offset: 999 })).isErr()).toBe(
          true
        );
        expect((await repo.uatHeatmap({ ...query, year: 2026 })).isErr()).toBe(true);
        expect((await repo.countyHeatmap({ ...query, year: 2026 })).isErr()).toBe(true);
      }
      expect(calls).toBe(0);
    }));
}
