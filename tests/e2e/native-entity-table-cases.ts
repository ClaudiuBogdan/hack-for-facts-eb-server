/** Native composition acceptance against original INS fixture cells and migration DDL. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeNativeGroupedEntities } from '@/app/native-grouped-entities.js';

import { nativeBudgetAdmission } from './native-budget-cases.js';

import type { GroupedInput } from '@/modules/budget/index.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

export function registerNativeEntityTableCases(
  it: (name: string, run: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>
) {
  it('native annual entity table admits real INS cells with cold factors and a one-connection pool', async () => {
    const db = database();
    try {
      const admission = await nativeBudgetAdmission(db);
      const loaded: string[] = [];
      const factors = {
        yearly: async (kind: string) => {
          loaded.push(kind);
          await sql`select 1`.execute(db);
          return ok(
            new Map([
              [2019, new Decimal(2)],
              [2020, new Decimal(4)],
            ])
          );
        },
      };
      const run = makeNativeGroupedEntities(db, admission, undefined, factors);
      const input: GroupedInput = {
        filter: {
          account_category: 'ch',
          report_type: 'Executie bugetara detaliata',
          report_period: { type: 'YEAR', selection: { dates: ['2019', '2020'] } },
          entity_cuis: ['991'],
          normalization: 'per_capita',
          currency: 'EUR',
        },
      };
      const start = performance.now();
      const row = (await run(input))._unsafeUnwrap().nodes[0]!;
      const ms = performance.now() - start;
      expect(row.entity_cui).toBe('991');
      expect(row.population).toBe(291105);
      expect(row.total_amount.toString()).toBe('225');
      expect(
        row
          .per_capita_amount!.minus(new Decimal(150).div(281105).plus(new Decimal(75).div(291105)))
          .abs()
          .lt('1e-15')
      ).toBe(true);
      expect(row.amount.eq(row.per_capita_amount!)).toBe(true);
      expect(loaded).toEqual(['ron_per_eur']);
      const creditor = (
        await run({ filter: { ...input.filter, main_creditor_cui: '992' } })
      )._unsafeUnwrap().nodes[0]!;
      expect(creditor.total_amount.toString()).toBe('150');
      const bad = makeNativeGroupedEntities(
        db,
        { ...admission, custodySha256: '0'.repeat(64) },
        undefined,
        factors
      );
      expect((await bad({ ...input, limit: 0 }))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
      const gap = {
        ...input,
        filter: {
          ...input.filter,
          currency: 'RON' as const,
          report_period: { type: 'YEAR' as const, selection: { dates: ['2018', '2019', '2020'] } },
        },
      };
      expect((await run({ ...gap, limit: 0 }))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      const total = (
        await run({ ...gap, filter: { ...gap.filter, normalization: 'total' } })
      )._unsafeUnwrap().nodes[0]!;
      expect(total.population).toBe(291105);
      expect(total.per_capita_amount).toBeNull();
      // Only December 2019 survives both date predicates: use its population.
      await sql`update budget.execution_line_items set is_monthly=true, monthly_amount=ytd_amount
        where entity_cui='991'`.execute(db);
      try {
        const intersected = (
          await run({
            filter: {
              ...input.filter,
              report_period: {
                type: 'MONTH',
                selection: {
                  interval: { start: '2019-12', end: '2020-01' },
                  dates: ['2019-12', '2020-02'],
                },
              },
            },
          })
        )._unsafeUnwrap().nodes[0]!;
        expect(intersected.population).toBe(281105);
        expect(intersected.total_amount.toString()).toBe('150');
        expect(
          intersected.per_capita_amount!.minus(new Decimal(150).div(281105)).abs().lt('1e-15')
        ).toBe(true);
      } finally {
        await sql`update budget.execution_line_items set is_monthly=false, monthly_amount=0
          where entity_cui='991'`.execute(db);
      }
      process.stdout.write(
        JSON.stringify({
          nativeEntityTable: {
            pool: 1,
            ms,
            years: [2019, 2020],
            population: 291105,
            totalEuro: 225,
          },
        }) + '\n'
      );
    } finally {
      await db.destroy();
    }
  });
}
