import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { readIntervalMapSeries } from '@/modules/ins-native/core/map-interval.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { InsLatestMapRequest } from '@/modules/ins-native/core/map-series.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const input: InsLatestMapRequest = {
  datasetCode: 'POPTEST',
  nonGeographicPins: new Map([
    [1, 1],
    [2, 105],
  ]),
  unitNomItemId: 9685,
  periodicity: 'ANNUAL',
  territories: [{ code: '54975', territoryId: 931 }],
};

export const registerInsMapIntervalCases = (
  it: (name: string, fn: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>
): void => {
  it('INS maximum interval stays within PostgreSQL parameter limits for all operations', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.periods(period_id,periodicity,period_start,period_end,label_ro) overriding system value
        select 20000+y,'ANNUAL',make_date(y,1,1),make_date(y,12,31),'Anul '||y from generate_series(1000,1999) y;
        insert into ins.observations(dataset_code,dim1_member_id,dim2_member_id,dim3_member_id,dim4_member_id,
          time_nom_item_id,unit_nom_item_id,period_id,period_start,period_end,value,response_id)
        select 'POPTEST',1,105,3075,931,period_id,9685,period_id,period_start,period_end,1,1
        from ins.periods where period_id between 21000 and 21999`.execute(trx);
      const periodTokens = Array.from({ length: 1000 }, (_, index) => String(1000 + index));
      const territories = Array.from({ length: 40 }, (_, index) => ({
        code: String(index),
        territoryId: index === 0 ? 931 : 900000 + index,
      }));
      const independent = (
        await sql<{
          sum: string;
          average: string;
        }>`select sum(value)::text as sum, avg(value)::text as average
        from ins.observations where dataset_code='POPTEST' and dim1_member_id=1 and dim2_member_id=105 and dim3_member_id=3075
          and dim4_member_id=931 and unit_nom_item_id=9685 and period_id between 21000 and 21999`.execute(
          trx
        )
      ).rows[0];
      expect(independent?.sum).toBe('1000');
      for (const operation of ['sum', 'average', 'latest'] as const) {
        const result = (
          await readIntervalMapSeries(repo, { ...input, territories }, { operation, periodTokens })
        )._unsafeUnwrap();
        const cell = result.cells.get('0');
        expect(cell).toMatchObject(
          operation === 'latest'
            ? {
                status: 'OBSERVATION',
                observation: { value: '1', period: { periodStart: '1999-01-01' } },
              }
            : { status: 'VALUE', value: operation === 'sum' ? independent?.sum : '1' }
        );
        expect(result.cells.size).toBe(40);
        expect(result.cells.get('39')?.status).toBe('NO_DATA');
      }
      // All 40 winner branches also bind the full range list. Repeated facts
      // under distinct request keys are valid at this repository boundary.
      const winners = (
        await repo.readDefaultSeries(
          territories.map((territory) => ({
            key: territory.code,
            datasetCode: input.datasetCode,
            nonGeographicPins: input.nonGeographicPins,
            unitNomItemId: input.unitNomItemId,
            geoScope: { kind: 'modern' as const, territoryIds: [931] },
          })),
          1,
          {
            periodicities: ['ANNUAL'],
            periodRanges: periodTokens.map((year) => ({
              start: year + '-01-01',
              end: year + '-12-31',
            })),
          }
        )
      )._unsafeUnwrap();
      expect(winners.length).toBe(40);
      expect(winners.every((row) => row.observations[0]?.value === '1')).toBe(true);
    }));

  it('INS interval sums selected noncontiguous periods with independent SQL parity', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set value=123456789012.123456
        where dataset_code='POPTEST' and dim1_member_id=1 and dim2_member_id=105
          and dim3_member_id=3075 and dim4_member_id=931 and period_id=30`.execute(trx);
      const result = (
        await readIntervalMapSeries(repo, input, {
          operation: 'sum',
          periodTokens: ['2019', '2021'],
        })
      )._unsafeUnwrap();
      const independent = (
        await sql<{ value: string }>`select sum(value)::text value from ins.observations
        where dataset_code='POPTEST' and dim1_member_id=1 and dim2_member_id=105 and dim3_member_id=3075
          and dim4_member_id=931 and unit_nom_item_id=9685 and period_id in (28,30)`.execute(trx)
      ).rows[0]?.value;
      expect(independent).toBe('123457070117.123456');
      expect(result.cells.get('54975')).toEqual({ status: 'VALUE', value: independent });
    }));

  it('INS interval refuses partial totals and preserves geographic ambiguity', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.observations where dataset_code='POPTEST' and dim4_member_id=931 and period_id=28;
        update ins.observations set value=null,value_status='c' where dataset_code='POPTEST' and dim4_member_id=931 and period_id=30`.execute(
        trx
      );
      const interval = { operation: 'average' as const, periodTokens: ['2019', '2021'] };
      const result = (await readIntervalMapSeries(repo, input, interval))._unsafeUnwrap();
      expect(result.cells.get('54975')).toEqual({
        status: 'INCOMPLETE',
        missingPeriodCount: 1,
        nullPeriodCount: 1,
      });
      await sql`update ins.dataset_geo_tuples set territory_id=931 where dataset_code='POPTEST'
        and geo_pairs='[[2,3065],[3,113]]'`.execute(trx);
      const ambiguous = (await readIntervalMapSeries(repo, input, interval))._unsafeUnwrap();
      expect(ambiguous.cells.get('54975')?.status).toBe('AMBIGUOUS_GEOGRAPHY');
    }));

  it('INS monthly and quarterly intervals use exact calendar periods including leap February', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.periods(period_id,periodicity,period_start,period_end,label_ro) overriding system value values
        (9001,'MONTHLY','2020-02-01','2020-02-29','Februarie 2020'),
        (9002,'MONTHLY','2020-03-01','2020-03-31','Martie 2020'),
        (9003,'QUARTERLY','2020-01-01','2020-03-31','Trimestrul I 2020'),
        (9004,'QUARTERLY','2020-07-01','2020-09-30','Trimestrul III 2020');
        insert into ins.observations(dataset_code,dim1_member_id,dim2_member_id,dim3_member_id,dim4_member_id,
          time_nom_item_id,unit_nom_item_id,period_id,period_start,period_end,value,response_id)
        select 'POPTEST',1,105,3075,931,period_id,9685,period_id,period_start,period_end,
          case when period_id in (9001,9003) then 0.1 else 0.2 end,1 from ins.periods where period_id between 9001 and 9004`.execute(
        trx
      );
      for (const [periodicity, periodTokens] of [
        ['MONTHLY', ['2020-02', '2020-03']],
        ['QUARTERLY', ['2020-Q1', '2020-Q3']],
      ] as const) {
        const sum = (
          await readIntervalMapSeries(
            repo,
            { ...input, periodicity },
            { operation: 'sum', periodTokens }
          )
        )._unsafeUnwrap();
        expect(sum.cells.get('54975')).toEqual({ status: 'VALUE', value: '0.3' });
        const average = (
          await readIntervalMapSeries(
            repo,
            { ...input, periodicity },
            { operation: 'average', periodTokens }
          )
        )._unsafeUnwrap();
        expect(average.cells.get('54975')).toEqual({ status: 'VALUE', value: '0.15' });
      }
      await sql`update ins.observations set period_start='2020-02-15' where dataset_code='POPTEST' and period_id=9001`.execute(
        trx
      );
      expect(
        (
          await readIntervalMapSeries(
            repo,
            { ...input, periodicity: 'MONTHLY' },
            { operation: 'sum', periodTokens: ['2020-02'] }
          )
        ).isErr()
      ).toBe(true);
    }));
};
