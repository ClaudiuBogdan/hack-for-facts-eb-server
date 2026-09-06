import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import {
  readLatestMapSeries,
  type InsLatestMapRequest,
} from '@/modules/ins-native/core/map-series.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const input: InsLatestMapRequest = {
  datasetCode: 'POPTEST',
  nonGeographicPins: new Map([
    [1, 1],
    [2, 105],
  ]),
  unitNomItemId: 9685,
  periodicity: 'ANNUAL',
  territories: [
    { code: '54975', territoryId: 931 },
    { code: '1017', territoryId: 56 },
  ],
};

export const registerInsMapSeriesCases = (
  it: (name: string, fn: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>
): void => {
  it('INS latest map uses the shared date even when its only current cell is confidential', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.observations where dataset_code='POPTEST'
        and dim4_member_id=113 and period_id=30;
        update ins.observations set value=null,value_status='c' where dataset_code='POPTEST'
        and dim4_member_id=931 and period_id=30`.execute(trx);
      const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
      expect(result.referencePeriod?.periodStart).toBe('2021-01-01');
      expect(result.cells.get('1017')).toEqual({ status: 'MISSING_REFERENCE_PERIOD' });
      const cluj = result.cells.get('54975');
      expect(cluj?.status).toBe('OBSERVATION');
      if (cluj?.status === 'OBSERVATION') {
        expect(cluj.observation.value).toBeNull();
        expect(cluj.observation.valueStatus).toBe('c');
      }
    }));

  it('INS latest map keeps source ambiguity that a latest-period filter could hide', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.observations where dataset_code='POPTEST'
        and dim4_member_id=113 and period_id=30;
        update ins.dataset_geo_tuples set territory_id=931 where dataset_code='POPTEST'
        and geo_pairs='[[2,3065],[3,113]]'`.execute(trx);
      const result = (await readLatestMapSeries(repo, input))._unsafeUnwrap();
      expect(result.referencePeriod).toBeNull();
      expect(result.cells.get('54975')).toEqual({
        status: 'AMBIGUOUS_GEOGRAPHY',
        witnesses: [
          [
            [2, 3065],
            [3, 113],
          ],
          [
            [2, 3075],
            [3, 931],
          ],
        ],
      });
    }));

  it('INS latest map refuses duplicate source time identities for one natural period', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.nomenclature_items(nom_item_id,label_ro,label_normalised,first_seen_generation)
        values(9999,'Anul 2021 duplicate','anul 2021 duplicate',1);
        insert into ins.dataset_dimension_members(dataset_code,dim_index,nom_item_id,ordinal,member_role,role_signals)
        values('POPTEST',4,9999,4,'UNKNOWN','{}');
        insert into ins.observations(dataset_code,dim1_member_id,dim2_member_id,dim3_member_id,
          dim4_member_id,time_nom_item_id,unit_nom_item_id,period_id,period_start,period_end,value,response_id)
        values('POPTEST',1,105,3075,931,9999,9685,30,'2021-01-01','2021-12-31',301105,1)`.execute(
        trx
      );
      const result = await readLatestMapSeries(repo, input);
      expect(result.isErr() && result.error.type).toBe('ServiceUnavailable');
    }));

  it('INS latest county map reads county source observations directly and preserves exact values', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set value=123456789012.123456
        where dataset_code='CNTTEST' and dim1_member_id=8002 and period_id=29 and unit_nom_item_id=9507`.execute(
        trx
      );
      const result = (
        await readLatestMapSeries(repo, {
          datasetCode: 'CNTTEST',
          nonGeographicPins: new Map(),
          unitNomItemId: 9507,
          periodicity: 'ANNUAL',
          territories: [
            { code: 'CJ', territoryId: 25 },
            { code: 'AB', territoryId: 14 },
          ],
        })
      )._unsafeUnwrap();
      const cluj = result.cells.get('CJ');
      expect(cluj?.status === 'OBSERVATION' ? cluj.observation.value : null).toBe(
        '123456789012.123456'
      );
      expect(result.cells.get('AB')).toEqual({ status: 'NO_DATA' });
    }));
};
