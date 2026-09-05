import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { listObservations } from '@/modules/ins-native/core/usecases.js';
import { makeInsLegacyResolvers } from '@/modules/ins-native/shell/graphql/legacy/resolvers.js';
import { makeInsMcpTools } from '@/modules/ins-native/shell/mcp/tools.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { InsDefaultSeriesRequest } from '@/modules/ins-native/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type RegisterCase = (name: string, fn: () => Promise<void>) => void;
const request = (key: string, territoryId: number): InsDefaultSeriesRequest => ({
  key,
  datasetCode: 'POPTEST',
  nonGeographicPins: new Map([
    [1, 1],
    [2, 105],
  ]),
  unitNomItemId: 9685,
  geoScope: { kind: 'modern', territoryIds: [territoryId] },
});

export const registerInsDefaultSeriesCases = (
  it: RegisterCase,
  database: () => Kysely<ProdDatabase>
): void => {
  it('source integer boundaries survive list input, default pins and hydrated cells', () =>
    inInsFixture(database(), async (trx, repo) => {
      let previous = 1;
      for (const member of [-2147483648, -1, 0, 1000000000, 2147483647]) {
        await sql`insert into ins.nomenclature_items(nom_item_id,label_ro,label_normalised,first_seen_generation)
          values(${member},'Boundary member','boundary member',1)`.execute(trx);
        await sql`insert into ins.dataset_dimension_members(dataset_code,dim_index,nom_item_id,ordinal,member_role,role_signals)
          values('POPTEST',0,${member},10,'LEAF','{}')`.execute(trx);
        await sql`update ins.observations set dim1_member_id=${member}
          where dataset_code='POPTEST' and dim1_member_id=${previous}`.execute(trx);
        const selected = {
          ...request('cluj', 931),
          nonGeographicPins: new Map([
            [1, member],
            [2, 105],
          ]),
        };
        const result = (await repo.readDefaultSeries([selected], 1))._unsafeUnwrap()[0];
        expect(result?.status).toBe('SERIES');
        expect(result?.observations[0]?.members[0]?.nomItemId).toBe(member);
        const listed = (
          await listObservations(
            repo,
            'POPTEST',
            {
              sirutaCodes: ['54975'],
              classificationTypeCodes: ['D0', 'D1'],
              classificationValueCodes: [String(member), '105'],
            },
            1,
            0
          )
        )._unsafeUnwrap();
        expect(listed.nodes[0]?.members[0]?.nomItemId).toBe(member);
        previous = member;
      }
    }));
  it('default source selection counts source tuples rather than observations', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const result = (await repo.readDefaultSeries([request('cluj', 931)], 2))._unsafeUnwrap();
      expect(result[0]?.status).toBe('SERIES');
      expect(result[0]?.observations.map((row) => row.period.periodStart)).toEqual([
        '2021-01-01',
        '2020-01-01',
      ]);
      expect(result[0]?.observations.every((row) => row.territory?.code === '54975')).toBe(true);
    }));
  it('default source selection preserves healthy, ambiguous and absent siblings', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set territory_id=931
      where dataset_code='POPTEST' and geo_pairs='[[2,3065],[3,113]]'`.execute(trx);
      const result = (
        await repo.readDefaultSeries(
          [request('national', 1), request('cluj', 931), request('absent', 999999)],
          1
        )
      )._unsafeUnwrap();
      expect(result.map((row) => [row.seriesKey, row.status])).toEqual([
        ['national', 'SERIES'],
        ['cluj', 'AMBIGUOUS_GEOGRAPHY'],
        ['absent', 'NO_DATA'],
      ]);
      expect(result[0]?.observations).toHaveLength(1);
      expect(result[1]?.observations).toEqual([]);
      expect(result[1]?.witnesses).toHaveLength(2);
    }));
  it('default source selection does not choose the newest tuple, while a period can disambiguate', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set territory_id=931
      where dataset_code='POPTEST' and geo_pairs='[[2,3065],[3,113]]';
      insert into ins.geo_tuple_rules(dataset_code,geo_pairs,rule_id,applies_from,applies_to,
        flag,kind,evidence_url,rationale,contract_version,custody_sha256)
      values('POPTEST','[[2,3065],[3,113]]','test-new-period','2021-01-01','2021-12-31',
        'includes_ilfov_historical','coverage','https://statistici.insse.ro/test',
        'Test qualification','ins-geography-v1',repeat('b',64));
      update ins.dataset_coverage set geo_rule_count=1 where dataset_code='POPTEST'`.execute(trx);
      expect(
        (await repo.readDefaultSeries([request('cluj', 931)], 1))._unsafeUnwrap()[0]?.status
      ).toBe('AMBIGUOUS_GEOGRAPHY');
      const current = (
        await repo.readDefaultSeries([request('cluj', 931)], 1, {
          periodStart: '2021-01-01',
          periodEnd: '2021-12-31',
          periodicities: ['ANNUAL'],
        })
      )._unsafeUnwrap()[0];
      expect(current?.status).toBe('SERIES');
      expect(current?.observations[0]?.geography?.pairs).toEqual([
        [2, 3075],
        [3, 931],
      ]);
    }));
  it('default source selection applies qualification to candidate existence and winner cells identically', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.geo_tuple_rules(dataset_code,geo_pairs,rule_id,applies_from,applies_to,
        flag,kind,evidence_url,rationale,contract_version,custody_sha256)
      values('POPTEST','[[2,3075],[3,931]]','test-boundary','2020-12-31','2021-01-01',
        'includes_ilfov_historical','coverage','https://statistici.insse.ro/test',
        'Test qualification','ins-geography-v1',repeat('b',64));
      update ins.dataset_coverage set geo_rule_count=1 where dataset_code='POPTEST'`.execute(trx);
      const result = (await repo.readDefaultSeries([request('cluj', 931)], 3))._unsafeUnwrap()[0];
      expect(result?.status).toBe('SERIES');
      expect(result?.observations.map((row) => row.period.periodStart)).toEqual(['2019-01-01']);
      expect(
        (
          await repo.readDefaultSeries([request('cluj', 931)], 1, { periodStart: '2020-01-01' })
        )._unsafeUnwrap()[0]?.status
      ).toBe('NO_DATA');
    }));
  it('default source selection includes confidential cells as source existence', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.observations set value=null,value_status='c' where dataset_code='POPTEST'`.execute(
        trx
      );
      const result = (await repo.readDefaultSeries([request('cluj', 931)], 1))._unsafeUnwrap()[0];
      expect(result?.status).toBe('SERIES');
      expect(result?.observations[0]?.value).toBeNull();
      expect(result?.observations[0]?.valueStatus).toBe('c');
    }));
  it('default source selection preserves certified non-geographic national data without a tuple', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.dataset_geo_tuples where dataset_code='CNTTEST';
      delete from ins.dataset_geo_dimensions where dataset_code='CNTTEST';
      update ins.dataset_coverage set geo_dimension_count=0,geo_tuple_count=0 where dataset_code='CNTTEST'`.execute(
        trx
      );
      expect((await repo.datasetsForTerritory(1))._unsafeUnwrap()).toEqual(['CNTTEST', 'POPTEST']);
      expect((await repo.datasetsForTerritory(931))._unsafeUnwrap()).toEqual(['POPTEST']);
      const nonGeo: InsDefaultSeriesRequest = {
        key: 'nongeo',
        datasetCode: 'CNTTEST',
        nonGeographicPins: new Map([[1, 8000]]),
        unitNomItemId: 9507,
        geoScope: { kind: 'nonGeographic' },
      };
      const result = (await repo.readDefaultSeries([nonGeo], 3))._unsafeUnwrap()[0];
      expect(result?.status).toBe('SERIES');
      expect(result?.observations).toHaveLength(2);
      expect(
        result?.observations.every((row) => row.geography === null && row.territory === null)
      ).toBe(true);
      expect(
        (
          await repo.readDefaultSeries([nonGeo], 1, { periodStart: '2030-01-01' })
        )._unsafeUnwrap()[0]?.status
      ).toBe('NO_DATA');
    }));
  it('default source selection rejects duplicate request keys', () =>
    inInsFixture(database(), async (_trx, repo) => {
      expect(
        (
          await repo.readDefaultSeries([request('same', 1), request('same', 931)], 1)
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }));
  it('default source selection rejects incomplete or extra non-geographic slot pins', () =>
    inInsFixture(database(), async (_trx, repo) => {
      for (const pins of [
        new Map([[1, 1]]),
        new Map([
          [1, 1],
          [2, 105],
          [3, 3075],
        ]),
        new Map([
          [1, 1],
          [2, 105],
          [5, 1],
        ]),
      ]) {
        expect(
          (
            await repo.readDefaultSeries([{ ...request('cluj', 931), nonGeographicPins: pins }], 1)
          )._unsafeUnwrapErr().type
        ).toBe('ServiceUnavailable');
      }
    }));
  it('default source selection fails a missing measure before interpreting missing data', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`delete from ins.measures where dataset_code='POPTEST'`.execute(trx);
      expect(
        (await repo.readDefaultSeries([request('absent', 999999)], 1))._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }));
  it('default source selection excludes permanently qualified tuples without hiding explicit source availability', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set flags='{includes_sai}' where dataset_code='POPTEST' and territory_id=931`.execute(
        trx
      );
      expect(
        (await repo.readDefaultSeries([request('cluj', 931)], 1))._unsafeUnwrap()[0]?.status
      ).toBe('NO_DATA');
    }));
  it('default source selection preserves request and period ordering across the 40-request boundary', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const requests = Array.from({ length: 83 }, (_, index) =>
        request(`request-${String(83 - index)}`, index % 2 === 0 ? 931 : 1)
      );
      const result = (await repo.readDefaultSeries(requests, 3))._unsafeUnwrap();
      expect(result.map((row) => row.seriesKey)).toEqual(requests.map((row) => row.key));
      for (const [index, row] of result.entries()) {
        expect(row.status).toBe('SERIES');
        expect(row.observations.map((observation) => observation.period.periodStart)).toEqual([
          '2021-01-01',
          '2020-01-01',
          '2019-01-01',
        ]);
        expect(
          row.observations.every(
            (observation) => observation.territory?.territoryId === (index % 2 === 0 ? 931 : 1)
          )
        ).toBe(true);
      }
    }));
  it('territory dataset presence uses the exact modern node and recursive context membership', () =>
    inInsFixture(database(), async (_trx, repo) => {
      expect((await repo.datasetsForTerritory(931))._unsafeUnwrap()).toEqual(['POPTEST']);
      expect((await repo.datasetsForTerritory(999999))._unsafeUnwrap()).toEqual([]);
      expect((await repo.datasetsForTerritory(931, 'missing'))._unsafeUnwrap()).toEqual([]);
      expect((await repo.datasetsForTerritory(931, '1'))._unsafeUnwrap()).toEqual(['POPTEST']);
      expect((await repo.datasetsForTerritory(931, '10'))._unsafeUnwrap()).toEqual(['POPTEST']);
    }));
  it('default source GraphQL and MCP witnesses agree while a healthy dataset survives', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set territory_id=25 where dataset_code='POPTEST' and territory_id=14;
      insert into ins.default_series(dataset_code,dim_index,nom_item_id,policy,manifest_version,rationale) values('CNTTEST',2,9507,'MANIFEST','test','Synthetic fixture chooses RON explicitly')`.execute(
        trx
      );
      const roots = makeInsLegacyResolvers({ repo })['Query'] as Record<
        string,
        (
          parent: unknown,
          args: unknown,
          context: unknown
        ) => Promise<readonly Record<string, unknown>[]>
      >;
      const gql = await roots['insLatestDatasetValues']!(
        null,
        {
          entity: { territoryCode: 'CJ', territoryLevel: 'NUTS3' },
          datasetCodes: ['POPTEST', 'CNTTEST'],
        },
        {}
      );
      const tool = makeInsMcpTools({ repo, clientBaseUrl: 'https://example.test' }).find(
        (tool) => tool.name === 'get_ins_territory_snapshot'
      )!;
      const mcp = await tool.handler({
        territoryCode: 'CJ',
        territoryLevel: 'NUTS3',
        datasetCodes: ['POPTEST', 'CNTTEST'],
      });
      expect(mcp.ok).toBe(true);
      const items = mcp.items as readonly Record<string, unknown>[];
      expect(items.map((item) => item['geographicWitnesses'])).toEqual(
        gql.map((item) => item['geographicWitnesses'])
      );
      expect(gql.map((item) => item['matchStrategy'])).toEqual([
        'AMBIGUOUS_GEOGRAPHY',
        'TOTAL_FALLBACK',
      ]);
      expect(gql[0]).toMatchObject({ observation: null, latestPeriod: null, hasData: false });
      expect(gql[1]?.['hasData']).toBe(true);
      expect(items[1]?.['value']).toBe('6');
    }));
  it('batch hydration isolates identical source member and unit ids by dataset and fails missing references', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.dataset_dimension_members(dataset_code,dim_index,nom_item_id,ordinal,member_role,role_signals)
      values('CNTTEST',0,1,4,'LEAF','{}'),('CNTTEST',2,9685,3,'UNKNOWN','{}');
      insert into ins.measures(dataset_code,unit_nom_item_id,unit_label_ro,scale_factor,base_unit,unit_kind)
      values('CNTTEST',9685,'Thousands of people',1000,'persons','non-monetary');
      update ins.observations set dim1_member_id=1,unit_nom_item_id=9685 where dataset_code='CNTTEST' and dim1_member_id=8000 and unit_nom_item_id=9507;
      update ins.dataset_geo_tuples set geo_pairs='[[0,1]]' where dataset_code='CNTTEST' and geo_pairs='[[0,8000]]'`.execute(
        trx
      );
      const count: InsDefaultSeriesRequest = {
        key: 'count',
        datasetCode: 'CNTTEST',
        nonGeographicPins: new Map(),
        unitNomItemId: 9685,
        geoScope: { kind: 'modern', territoryIds: [1] },
      };
      const results = (
        await repo.readDefaultSeries([request('population', 1), count], 1)
      )._unsafeUnwrap();
      expect(results[0]?.observations[0]?.unit.scaleFactor).toBe('1');
      expect(results[1]?.observations[0]?.unit.scaleFactor).toBe('1000');
      expect(results[0]?.observations[0]?.members[0]?.memberRole).toBe('TOTAL');
      expect(results[1]?.observations[0]?.members[0]?.memberRole).toBe('LEAF');
      expect(results[1]?.observations[0]?.coordinate.datasetCode).toBe('CNTTEST');
      await sql`delete from ins.dataset_dimension_members where dataset_code='CNTTEST' and dim_index=0 and nom_item_id=1`.execute(
        trx
      );
      expect(
        (await repo.readDefaultSeries([request('population', 1), count], 1))._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
      expect(
        (await repo.readDefaultSeries([request('population', 1)], 1))._unsafeUnwrap()[0]?.status
      ).toBe('SERIES');
    }));
};
