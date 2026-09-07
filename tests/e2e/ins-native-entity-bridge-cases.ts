import { sql, type Kysely } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { resolveInsTerritories } from '@/modules/ins-native/core/entity-territory.js';
import { makeInsContributor } from '@/modules/ins-native/shell/contributor.js';

import { inInsFixture } from './ins-native-fixture.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { ProdDatabase, Territory } from '@/modules/shared/index.js';

const anchor: Territory = {
  id: 7001,
  level: 'uat',
  kind: 'municipality',
  territoryKey: 'siruta:54975',
  parentId: null,
  nutsCode: null,
  territorialSirutaCode: '54975',
  sirutaCode: '54975',
  countySirutaCode: '54984',
  uatCode: null,
  name: 'Cluj-Napoca',
  countyCode: 'CJ',
  countyName: 'Cluj',
  region: null,
  population: null,
};
const presence = (repo: InsRepo, territory: Territory = anchor) =>
  makeInsContributor(repo, { territoryForCui: async () => ok(territory) }).presenceFor('123');
type RegisterCase = (name: string, fn: () => Promise<void>) => void;

export const registerInsEntityBridgeCases = (
  it: RegisterCase,
  database: () => Kysely<ProdDatabase>
): void => {
  it('batch identity resolves exact nodes and preserves duplicate reverse links', () =>
    inInsFixture(database(), async (trx, repo) => {
      expect((await repo.territoriesByCoreIds([]))._unsafeUnwrap()).toEqual([]);
      const county = {
        ...anchor,
        id: 7002,
        level: 'county',
        kind: 'county',
        territorialSirutaCode: '54984',
        sirutaCode: 'CJ',
        countySirutaCode: '54984',
        territoryKey: 'siruta:54984',
      };
      expect((await resolveInsTerritories(repo, [county]))._unsafeUnwrap().get(7002)?.code).toBe(
        'CJ'
      );
      expect(
        (await resolveInsTerritories(repo, [anchor]))._unsafeUnwrap().get(7001)?.territoryId
      ).toBe(931);
      await sql`update ins.territory_nodes set core_territory_id=7001 where territory_id in (931,56)`.execute(
        trx
      );
      expect((await repo.territoriesByCoreIds([7001, 9999]))._unsafeUnwrap()).toHaveLength(2);
      expect((await resolveInsTerritories(repo, [anchor]))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
    }));
  it('entity bridge resolves exact coverage without equating core and INS surrogate IDs', () =>
    inInsFixture(database(), async (trx, repo) => {
      expect((await repo.territoriesByCoreId(7001))._unsafeUnwrap()).toEqual([]);
      expect((await presence(repo))._unsafeUnwrap()?.attrs).toEqual({
        territoryCode: '54975',
        territoryName: 'MUNICIPIUL CLUJ-NAPOCA',
        territoryLevel: 'LAU',
        sirutaCode: '54975',
      });
      await sql`update ins.territory_nodes set core_territory_id=7001 where territory_id=931`.execute(
        trx
      );
      const linked = (await repo.territoriesByCoreId(7001))._unsafeUnwrap();
      expect(
        linked.map((node) => [node.territoryId, node.parentCode, node.coreTerritoryId])
      ).toEqual([[931, 'CJ', 7001]]);
      expect((await presence(repo))._unsafeUnwrap()?.count).toBe(1);
    }));
  it('entity bridge supports counties with no SIRUTA and national context', () =>
    inInsFixture(database(), async (_trx, repo) => {
      const county = {
        ...anchor,
        level: 'county',
        kind: 'county',
        territorialSirutaCode: null,
        sirutaCode: null,
        territoryKey: null,
      };
      expect((await presence(repo, county))._unsafeUnwrap()?.attrs).toEqual({
        territoryCode: 'CJ',
        territoryName: 'Cluj',
        territoryLevel: 'NUTS3',
      });
      const country = {
        ...county,
        level: 'country',
        kind: 'country',
        nutsCode: 'RO',
        territoryKey: 'nuts:RO',
      };
      expect((await presence(repo, country))._unsafeUnwrap()?.count).toBe(2);
    }));
  it('entity bridge rejects duplicate reverse links and conflicting forward links', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.territory_nodes set core_territory_id=7001 where territory_id in (931,56)`.execute(
        trx
      );
      expect((await repo.territoriesByCoreId(7001))._unsafeUnwrap()).toHaveLength(2);
      expect((await presence(repo))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      await sql`update ins.territory_nodes set core_territory_id=null;
      update ins.territory_nodes set core_territory_id=9999 where territory_id=931`.execute(trx);
      expect((await presence(repo))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    }));
  it('entity bridge checks reverse links even when the requested source identity is missing', () =>
    inInsFixture(database(), async (trx, repo) => {
      const missing = {
        ...anchor,
        territorialSirutaCode: '999999',
        sirutaCode: '999999',
        territoryKey: 'siruta:999999',
      };
      expect((await presence(repo, missing))._unsafeUnwrap()).toBeNull();
      await sql`update ins.territory_nodes set core_territory_id=7001 where territory_id=931`.execute(
        trx
      );
      expect((await presence(repo, missing))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    }));
  it('entity bridge does not advertise qualified-only or uncertified dataset coverage', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set has_modern_facts=false
      where dataset_code='POPTEST' and territory_id=931`.execute(trx);
      expect((await presence(repo))._unsafeUnwrap()).toBeNull();
      await sql`update ins.dataset_geo_tuples set has_modern_facts=true
      where dataset_code='POPTEST' and territory_id=931`.execute(trx);
      await sql`update ins.dataset_geo_tuples set flags=array['includes_sai']
      where dataset_code='POPTEST' and territory_id=931`.execute(trx);
      expect((await presence(repo))._unsafeUnwrap()).toBeNull();
      await sql`update ins.dataset_geo_tuples set flags='{}' where dataset_code='POPTEST';
      update ins.dataset_coverage set geo_contract_version='unsupported' where dataset_code='POPTEST'`.execute(
        trx
      );
      expect((await presence(repo))._unsafeUnwrap()).toBeNull();
    }));
  it('entity presence certifies coverage without pretending default source ambiguity is resolved', () =>
    inInsFixture(database(), async (trx, repo) => {
      await sql`update ins.dataset_geo_tuples set territory_id=931
      where dataset_code='POPTEST' and geo_pairs='[[2,3065],[3,113]]'`.execute(trx);
      expect((await presence(repo))._unsafeUnwrap()?.count).toBe(1);
    }));
};
