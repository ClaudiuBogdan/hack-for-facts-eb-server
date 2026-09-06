import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { readDefaultSeries } from '@/modules/ins-native/shell/repo/default-series.js';

import { inInsFixture } from './ins-native-fixture.js';

import type {
  InsDefaultSeriesRequest,
  InsObservationView,
} from '@/modules/ins-native/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const request = (key: string): InsDefaultSeriesRequest => ({
  key,
  datasetCode: 'POPTEST',
  nonGeographicPins: new Map([
    [1, 1],
    [2, 105],
  ]),
  unitNomItemId: 9685,
  geoScope: { kind: 'modern', territoryIds: [931] },
});

export const registerInsBatchHydrationCases = (
  it: (name: string, fn: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>
): void => {
  it('batched INS hydration preserves shuffled keys, repeated facts, mixed datasets and missing series', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const requests = Array.from({ length: 81 }, (_, i) =>
        i % 3 === 0
          ? {
              ...request(String(81 - i)),
              datasetCode: 'CNTTEST',
              nonGeographicPins: new Map<number, number>(),
              unitNomItemId: 9507,
              geoScope: { kind: 'modern' as const, territoryIds: [25] as const },
            }
          : i % 3 === 1
            ? request(String(81 - i))
            : {
                ...request(String(81 - i)),
                geoScope: { kind: 'modern' as const, territoryIds: [999999] as const },
              }
      );
      const rows = (await repo.readDefaultSeries(requests, 2))._unsafeUnwrap();
      expect(rows.map((row) => row.seriesKey)).toEqual(requests.map((r) => r.key));
      rows.forEach((row, i) => {
        expect(row.status).toBe(i % 3 === 2 ? 'NO_DATA' : 'SERIES');
        expect(row.observations.map((o) => o.value)).toEqual(
          i % 3 === 0 ? ['6', '5'] : i % 3 === 1 ? ['301105', '291105'] : []
        );
      });
    }));

  it('INS hydration flushes at the previously supported batch size and refuses a late hydration failure', () =>
    inInsFixture(database(), async (trx, repo) => {
      const original = (await repo.readDefaultSeries([request('seed')], 1))._unsafeUnwrap()[0]
        ?.observations[0];
      if (original === undefined) throw new Error('Missing test seed');
      // Source time keys are value-free. The low-level reader may return >1
      // source member for a natural period; map-series independently rejects it.
      await sql`insert into ins.observations(dataset_code,dim1_member_id,dim2_member_id,dim3_member_id,
        dim4_member_id,time_nom_item_id,unit_nom_item_id,period_id,period_start,period_end,value,response_id)
        select 'POPTEST',1,105,3075,931,id,9685,30,'2021-01-01'::date,'2021-12-31'::date,301105,1
        from generate_series(10000,11000) id`.execute(trx);
      const requests = Array.from({ length: 41 }, (_, i) => request(String(41 - i)));
      const batches: number[] = [];
      const rows = await readDefaultSeries(trx, requests, 1001, undefined, async (facts) => {
        batches.push(facts.length);
        return facts.map((fact) => ({
          ...original,
          coordinate: { ...original.coordinate, timeNomItemId: fact.time_nom_item_id },
        }));
      });
      expect(batches).toEqual([40040, 1001]);
      expect(rows.map((row) => row.seriesKey)).toEqual(requests.map((r) => r.key));
      expect(rows.every((row) => row.observations.length === 1001)).toBe(true);
      expect(new Set(rows[40]?.observations.map((o) => o.coordinate.timeNomItemId)).size).toBe(
        1001
      );
      let calls = 0;
      await expect(
        readDefaultSeries(trx, requests, 1001, undefined, async (facts) => {
          calls++;
          if (calls === 2) return [];
          return facts.map((): InsObservationView => original);
        })
      ).rejects.toThrow('INS dataset publication is unavailable');
      expect(calls).toBe(2);
    }));
};
