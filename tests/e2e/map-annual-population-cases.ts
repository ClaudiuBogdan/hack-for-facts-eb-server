import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { mapAnalyticsSql } from '@/modules/budget/shell/repo/map-analytics-repo.js';
import { readCuratedPopulation } from '@/modules/shared/shell/population/curated-annual-population.js';
import { readMapAnnualPopulation } from '@/modules/shared/shell/population/map-annual-population.js';

import type { AnnualPopulationPort, ProdDatabase } from '@/modules/shared/index.js';

type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;
export function registerMapAnnualPopulationCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
) {
  it('annual map uses real publication DDL, source years and canonical county/sector identity', async () =>
    fixture(async (db) => {
      const port: AnnualPopulationPort = {
        withSnapshot: async (fn) =>
          fn({ trx: db, cells: (ids, years) => readCuratedPopulation(db, ids, years) }),
      };
      await sql`update core.population_annual set population=264698 where territory_id=(select id from core.territories where territorial_siruta_code='179141') and applied_year=2024`.execute(
        db
      );
      await sql`update core.territories set population=1 where territorial_siruta_code='179141'`.execute(
        db
      );
      const uats = (await readMapAnnualPopulation(port, 2024, 'UAT'))._unsafeUnwrap();
      expect(uats.find((cell) => cell.territoryCode === '179141')?.population).toBe('264698');
      expect(uats.some((cell) => cell.territoryCode === '179132')).toBe(false);
      const counties = (await readMapAnnualPopulation(port, 2024, 'County'))._unsafeUnwrap();
      expect(counties.map((cell) => cell.territoryCode)).toEqual(['B', 'CJ', 'IS']);
      expect(
        (await readMapAnnualPopulation(port, 2025, 'UAT'))
          ._unsafeUnwrap()
          .every((cell) => cell.population === null)
      ).toBe(true);
      await sql`update etl.load_runs set status='failed' where source_id='core_reference_population_annual'`.execute(
        db
      );
      expect(
        (await readMapAnnualPopulation(port, 2024, 'UAT'))
          ._unsafeUnwrap()
          .every((cell) => cell.population === null)
      ).toBe(true);
    }));
  it('annual map filters use the latest selected year and preserve exact financial values', async () =>
    fixture(async (db) => {
      await sql`update core.population_annual set population=case applied_year when 2023 then 100 else 300 end
      where territory_id=(select territory_id from core.public_entities where cui='111')`.execute(
        db
      );
      await sql`update core.territories set population=1 where id=(select territory_id from core.public_entities where cui='111')`.execute(
        db
      );
      const query = cleanFilter({
        account_category: 'ch',
        entity_cuis: ['111'],
        report_period: { type: 'YEAR', selection: { dates: ['2023', '2024'] } },
      })._unsafeUnwrap();
      const read = async (minPopulation?: number) =>
        (
          await mapAnalyticsSql(
            { ...query, ...(minPopulation === undefined ? {} : { minPopulation }) },
            'UAT',
            () => undefined
          ).execute(db)
        ).rows;
      const all = await read();
      expect(all.length).toBeGreaterThan(0);
      expect(await read(250)).toEqual(all);
      expect(await read(350)).toEqual([]);
      const earlier = { ...query, period: { years: { in: [2023] } } };
      expect(
        (
          await mapAnalyticsSql({ ...earlier, minPopulation: 250 }, 'UAT', () => undefined).execute(
            db
          )
        ).rows
      ).toEqual([]);
      await sql`update etl.load_runs set status='failed' where source_id='core_reference_population_annual'`.execute(
        db
      );
      expect(await read(250)).toEqual([]);
    }));
}
