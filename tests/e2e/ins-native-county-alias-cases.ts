import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { resolveInsTerritoryInputs } from '@/modules/ins-native/core/territory-inputs.js';
import {
  listDimensionValues,
  listObservations,
  listTerritories,
  resolveTerritoryNodes,
} from '@/modules/ins-native/core/usecases.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

type RegisterCase = (name: string, fn: () => Promise<void>) => void;
export const registerInsCountyAliasCases = (
  it: RegisterCase,
  database: () => Kysely<ProdDatabase>
): void => {
  it('county SIRUTA aliases use actual canonical rows and preserve source values', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const aliases = (await repo.countyAliases())._unsafeUnwrap();
      expect(aliases.map((a) => [a.sirutaCode, a.node.code]).sort()).toEqual([
        ['10', 'AB'],
        ['127', 'CJ'],
      ]);
      const letter = (
        await listObservations(repo, 'POPTEST', { territoryCodes: ['CJ'] }, 10)
      )._unsafeUnwrap();
      const numeric = (
        await listObservations(repo, 'POPTEST', { sirutaCodes: ['127'] }, 10)
      )._unsafeUnwrap();
      expect(numeric).toEqual(letter);
      expect(numeric.nodes.length).toBeGreaterThan(0);
      expect(
        (await resolveInsTerritoryInputs(repo, ['CJ', '127'], 'code'))._unsafeUnwrap().nodes
      ).toHaveLength(1);
      expect(
        (
          await resolveTerritoryNodes(repo, { territoryCodes: ['CJ'], sirutaCodes: ['10'] })
        )._unsafeUnwrap()
      ).toEqual([]);
    }));
  it('catalog county aliases filter before counting and pagination', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const page = (
        await listTerritories(repo, { sirutaCodes: ['127', '10'] }, 1, 1)
      )._unsafeUnwrap();
      expect(page.totalCount).toBe(2);
      expect(page.nodes).toHaveLength(1);
      expect(page.nodes[0]).toMatchObject({
        code: 'CJ',
        canonicalSirutaCode: '127',
        sirutaCode: null,
      });
      expect((await listTerritories(repo, { sirutaCodes: ['999'] }))._unsafeUnwrap().nodes).toEqual(
        []
      );
    }));
  it('canonical parent filters preserve child levels and unknown parent constraints', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const old = (
        await listTerritories(repo, { parentCode: 'CJ', levels: ['LAU'] })
      )._unsafeUnwrap();
      const canonical = (
        await listTerritories(repo, { parentCode: '127', levels: ['LAU'] })
      )._unsafeUnwrap();
      expect(canonical).toEqual(old);
      expect(canonical.nodes.length).toBeGreaterThan(0);
      expect(
        (await listTerritories(repo, { parentCode: 'unknown', levels: ['LAU'] }))._unsafeUnwrap()
          .nodes
      ).toEqual([]);
    }));
  it('dimension catalogs enrich county identity without changing source members', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const original = (await repo.listMembers('POPTEST', 2, undefined, 200, 0))._unsafeUnwrap();
      const enriched = (
        await listDimensionValues(repo, 'POPTEST', 2, undefined, 200)
      )._unsafeUnwrap();
      expect(
        enriched.nodes.map(({ territory, ...member }) => ({
          ...member,
          territory: territory === null ? null : { ...territory, canonicalSirutaCode: undefined },
        }))
      ).toEqual(
        original.nodes.map(({ territory, ...member }) => ({
          ...member,
          territory: territory === null ? null : { ...territory, canonicalSirutaCode: undefined },
        }))
      );
      expect(
        enriched.nodes.find((member) => member.territory?.code === 'CJ')?.territory
          ?.canonicalSirutaCode
      ).toBe('127');
    }));
  it('county alias reads refuse conflicting canonical and reverse links', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update core.territories set siruta_code='VL' where id=7002`.execute(trx);
      expect((await repo.countyAliases())._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      await sql`update core.territories set siruta_code='CJ' where id=7002`.execute(trx);
      await sql`update ins.territory_nodes set core_territory_id=7002 where territory_id=931`.execute(
        trx
      );
      expect((await repo.countyAliases())._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    }));
  it('county alias reads do not hide duplicate core rows or forward links', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update core.territories set county_code='CJ',siruta_code='CJ' where id=7003`.execute(
        trx
      );
      expect((await repo.countyAliases()).isErr()).toBe(true);
      await sql`update core.territories set county_code='AB',siruta_code='AB' where id=7003`.execute(
        trx
      );
      await sql`update ins.territory_nodes set core_territory_id=9999 where code='CJ' and level='NUTS3'`.execute(
        trx
      );
      expect((await repo.countyAliases()).isErr()).toBe(true);
    }));
  it('source-only Bucharest keeps B without inventing a county or sector alias', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`insert into ins.territory_nodes (territory_id,code,level,name_ro,name_search,source_url,parent_id) values(3000000000,'B','NUTS3','Bucuresti','bucuresti','https://statistici.insse.ro/',1)`.execute(
        trx
      );
      const old = (await resolveInsTerritoryInputs(repo, ['B'], 'siruta'))._unsafeUnwrap();
      expect(old.nodes[0]?.code).toBe('B');
      expect(
        (
          await resolveInsTerritoryInputs(repo, ['403', '179132', '179141'], 'code', ['NUTS3'])
        )._unsafeUnwrap().nodes
      ).toEqual([]);
      const catalog = (await listTerritories(repo, { sirutaCodes: ['B'] }))._unsafeUnwrap();
      expect(catalog.nodes[0]?.canonicalSirutaCode).toBeNull();
      expect(catalog.nodes[0]?.territoryId).toBe(3000000000);
    }));
};
