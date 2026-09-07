import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeNativeMapPopulation, readNativeMapPopulation } from '@/app/native-map-population.js';
import {
  withInsReadSnapshot,
  type AnnualPopulationAdmission,
  type InsRepo,
} from '@/modules/ins-native/index.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { SectorPopulationAdmission } from '@/app/native-sector-population.js';
import type { BudgetMapYear } from '@/modules/budget/index.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

const admit = async (repo: InsRepo): Promise<AnnualPopulationAdmission> => {
  const dataset = (await repo.getDataset('POPTEST'))._unsafeUnwrap()!;
  return {
    datasetCode: dataset.code,
    revisionId: dataset.revisionId!,
    custodySha256: dataset.custodySha256!,
    transformContractSha256: dataset.transformContractSha256!,
    ageDimension: 0,
    allAgesMember: 1,
    sexDimension: 1,
    allSexesMember: 105,
    personsUnit: 9685,
  };
};
const row = (
  territoryCode: string,
  territoryIds: readonly number[],
  year = 2019
): BudgetMapYear => ({
  territoryCode,
  territoryIds,
  year,
  coverage: 'mapped',
  nominalAmount: '10',
  observationCount: '1',
});
const seedAnchors = async (db: Kysely<ProdDatabase>): Promise<void> => {
  await sql`insert into core.territories
    (id, territorial_siruta_code, siruta_code, county_siruta_code, name, county_code,
     county_name, level, kind, territory_key, parent_id)
    overriding system value values
    (7001,'54975','54975','127','Cluj-Napoca','CJ','Cluj','uat','municipality','siruta:54975',7002),
    (7004,'1213','1213','10','Aiud','AB','Alba','uat','municipality','siruta:1213',7003)`.execute(
    db
  );
};

const seedSectors = async (
  trx: Kysely<ProdDatabase>,
  repo: InsRepo
): Promise<SectorPopulationAdmission> => {
  await sql`insert into core.territories
    (id,territorial_siruta_code,siruta_code,name,county_code,level,kind,territory_key,parent_id)
    overriding system value values(8100,'179132','179132','Bucharest','B','uat','municipality','siruta:179132',null)`.execute(
    trx
  );
  const codes = ['179141', '179150', '179169', '179178', '179187', '179196'];
  const tuples: (string | number)[][] = [];
  for (const [index, code] of codes.entries()) {
    const id = 8101 + index;
    await sql`insert into core.territories
      (id,territorial_siruta_code,siruta_code,name,county_code,level,kind,territory_key,parent_id)
      overriding system value values(${id},${code},${code},${'Sector ' + String(index + 1)},'B','locality','sector',${'siruta:' + code},8100)`.execute(
      trx
    );
    await sql`insert into core.territory_identifiers(territory_id,scheme,value) values(${id},'siruta',${code})`.execute(
      trx
    );
    for (const year of [2024, 2025]) {
      const population = (index + 1) * 100 + (year - 2024) * 10,
        source = 'fixture-sector-' + String(year),
        url = 'https://fixture.test/' + String(year) + '?version=1';
      await sql`insert into core.territory_population(territory_id,year,population,source,source_url)
        values(${id},${year},${population},${source},${url})`.execute(trx);
      tuples.push([code, year, population, source, url]);
    }
  }
  // Independently retained expected source tuple encoding, synthetic populations.
  tuples.sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    ins: await admit(repo),
    sources: ['fixture-sector-2024', 'fixture-sector-2025'],
    rowsSha256: createHash('sha256').update(JSON.stringify(tuples)).digest('hex'),
  };
};

export function registerInsMapPopulationCases(
  it: (name: string, fn: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>
): void {
  it('map population: exact years and independent canonical unions avoid parent double counting', () =>
    inInsFixture(database(), async (trx, repo) => {
      await seedAnchors(trx);
      const result = await readNativeMapPopulation({ trx, repo }, await admit(repo), [
        row('parent', [7001, 7002, 7001]),
        row('child', [7001]),
        row('union', [7002, 7003]),
        row('parent', [7002, 7001], 2020),
        row('missing-year', [7002], 1992),
        row('partial', [7001, 7004]),
        row('empty', []),
        row('missing-anchor', [7002, 999999]),
        { ...row('unmapped', [7001]), coverage: 'outside_view' },
      ]);
      expect(result._unsafeUnwrap()).toEqual([
        { territoryCode: 'parent', year: 2019, population: '281105' },
        { territoryCode: 'child', year: 2019, population: '281105' },
        { territoryCode: 'union', year: 2019, population: '562210' },
        { territoryCode: 'parent', year: 2020, population: '291105' },
        ...['missing-year', 'partial', 'empty', 'missing-anchor'].map((territoryCode) => ({
          territoryCode,
          year: territoryCode === 'missing-year' ? 1992 : 2019,
          population: null,
        })),
      ]);
    }));

  it('map population: restricted, cyclic and orphaned anchors never produce partial totals', () =>
    inInsFixture(database(), async (trx, repo) => {
      await seedAnchors(trx);
      const admission = await admit(repo);
      await sql`update core.territories set privacy_class='restricted' where id=7001`.execute(trx);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('restricted', [7001, 7002])])
        )._unsafeUnwrap()[0]?.population
      ).toBeNull();
      await sql`update core.territories set privacy_class='public', parent_id=7001 where id=7001`.execute(
        trx
      );
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('cycle', [7001])])
        )._unsafeUnwrap()[0]?.population
      ).toBeNull();
      await sql`update core.territories set parent_id=null where id=7001`.execute(trx);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('orphan', [7001])])
        )._unsafeUnwrap()[0]?.population
      ).toBeNull();
    }));

  it('map population: zero components are retained and identity conflicts reject the union', () =>
    inInsFixture(database(), async (trx, repo) => {
      await seedAnchors(trx);
      const admission = await admit(repo);
      await sql`update ins.observations set value=0 where dataset_code='POPTEST'
        and dim1_member_id=1 and dim2_member_id=105 and dim3_member_id=3075
        and dim4_member_id=112`.execute(trx);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [
            row('zero', [7002]),
            row('union', [7002, 7003]),
          ])
        )
          ._unsafeUnwrap()
          .map((cell) => cell.population)
      ).toEqual([null, '281105']);
      await sql`update ins.territory_nodes set core_territory_id=7001 where territory_id in (931,56)`.execute(
        trx
      );
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('conflict', [7001])])
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }));

  it('map population: changed publication and malformed anchors fail closed', () =>
    inInsFixture(database(), async (trx, repo) => {
      const admission = await admit(repo);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, { ...admission, revisionId: '-1' }, [
            row('CJ', [7002]),
          ])
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('CJ', [1.5])])
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }));

  it('map population: sector admission uses exact years, deduplicates unions and prunes children', () =>
    inInsFixture(database(), async (trx, repo) => {
      const sectors = await seedSectors(trx, repo),
        admission = await admit(repo);
      const result = await readNativeMapPopulation(
        { trx, repo },
        admission,
        [
          row('sector', [8101], 2024),
          row('sector', [8101], 2025),
          row('gap', [8101], 2023),
          row('union', [8101, 8102, 8101], 2024),
          row('city', [8100, 8101, 8102], 2024),
          row('all', [8101, 8102, 8103, 8104, 8105, 8106], 2025),
          row('partial', [8101, 7002], 2024),
        ],
        sectors
      );
      expect(result._unsafeUnwrap().map((cell) => cell.population)).toEqual([
        '100',
        '110',
        null,
        '300',
        null,
        '2160',
        null,
      ]);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [
            row('unconfigured', [8101], 2024),
          ])
        )._unsafeUnwrap()[0]?.population
      ).toBeNull();
    }));

  for (const [name, change] of [
    ['missing row', 'delete from core.territory_population where territory_id=8106 and year=2025'],
    [
      'changed provenance',
      "update core.territory_population set source_url='different' where territory_id=8106",
    ],
    [
      'changed population',
      'update core.territory_population set population=population+1 where territory_id=8106',
    ],
    [
      'conflicting legacy SIRUTA',
      "update core.territories set siruta_code='999' where id=8106; update ins.territory_nodes set core_territory_id=8106 where territory_id=931",
    ],
    ['wrong parent', 'update core.territories set parent_id=7002 where id=8106'],
    ['restricted sector', "update core.territories set privacy_class='restricted' where id=8106"],
    [
      'competing native identity',
      'update ins.territory_nodes set core_territory_id=8106 where territory_id=931',
    ],
  ] as const) {
    it(
      'map population: sector-only request rejects ' + name + ' anywhere in the admitted source',
      () =>
        inInsFixture(database(), async (trx, repo) => {
          const sectors = await seedSectors(trx, repo),
            admission = await admit(repo);
          await sql.raw(change).execute(trx);
          expect(
            (
              await readNativeMapPopulation(
                { trx, repo },
                admission,
                [row('sector', [8101], 2024)],
                sectors
              )
            )._unsafeUnwrapErr().type
          ).toBe('ServiceUnavailable');
        })
    );
  }
  it('map population: sector-only request still validates active INS publication and matching admission', () =>
    inInsFixture(database(), async (trx, repo) => {
      const sectors = await seedSectors(trx, repo),
        admission = await admit(repo);
      expect(
        (
          await readNativeMapPopulation({ trx, repo }, admission, [row('sector', [8101], 2024)], {
            ...sectors,
            ins: { ...sectors.ins, revisionId: '-1' },
          })
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
      await sql`update ins.dataset_revisions set transform_contract_sha256=repeat('e',64) where dataset_code='POPTEST'`.execute(
        trx
      );
      expect(
        (
          await readNativeMapPopulation(
            { trx, repo },
            admission,
            [row('sector', [8101], 2024)],
            sectors
          )
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }));

  it('map population: factory uses a read-only repeatable snapshot with real INS values', async () => {
    const admitted = await withInsReadSnapshot(database(), async ({ trx, repo }) => {
      const settings = await sql<{ readonly: string; isolation: string; timeout: string }>`select
        current_setting('transaction_read_only') as readonly,
        current_setting('transaction_isolation') as isolation, current_setting('transaction_timeout') as timeout`.execute(
        trx
      );
      return ok({ admission: await admit(repo), settings: settings.rows[0] });
    });
    expect(admitted._unsafeUnwrap().settings).toEqual({
      readonly: 'on',
      isolation: 'repeatable read',
      timeout: '35s',
    });
    const adapter = makeNativeMapPopulation(database(), admitted._unsafeUnwrap().admission);
    expect((await adapter.annualUnions([row('CJ', [7002], 2021)]))._unsafeUnwrap()).toEqual([
      { territoryCode: 'CJ', year: 2021, population: '301105' },
    ]);
  });
}
