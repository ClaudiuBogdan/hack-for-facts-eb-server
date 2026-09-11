import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { resolveInsTerritoryInputs } from '@/modules/ins-native/core/territory-inputs.js';
import { listTerritories, resolveTerritoryNodes } from '@/modules/ins-native/core/usecases.js';
import { toGqlTerritory } from '@/modules/ins-native/shell/graphql/legacy/resolvers.js';

import { AB, CJ, CLUJ_NAPOCA, makeFakeRepo } from '../../fixtures/ins-native/fake-repo.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';

const aliased = (): InsRepo => {
  const repo: InsRepo = {
    ...makeFakeRepo(),
    countyAliases: async () =>
      ok([
        { sirutaCode: '127', node: CJ },
        { sirutaCode: '10', node: AB },
      ]),
    withSnapshot: async (fn) => fn(repo),
  };
  return repo;
};
describe('canonical county inputs with legacy aliases', () => {
  it.each(['code', 'siruta'] as const)(
    'resolves %s inputs to the same county node',
    async (mode) => {
      for (const codes of [['127'], ['CJ'], ['127', 'CJ']]) {
        expect((await resolveInsTerritoryInputs(aliased(), codes, mode))._unsafeUnwrap()).toEqual({
          nodes: [CJ],
          unresolvedCodes: [],
        });
      }
    }
  );
  it('preserves mixed counties/UATs and intersects independent filters by node', async () => {
    const repo = aliased();
    expect(
      (await resolveInsTerritoryInputs(repo, ['127', '54975'], 'siruta'))._unsafeUnwrap().nodes
    ).toEqual([CJ, CLUJ_NAPOCA]);
    expect(
      (
        await resolveTerritoryNodes(repo, { territoryCodes: ['CJ'], sirutaCodes: ['127'] })
      )._unsafeUnwrap()
    ).toEqual([CJ]);
    expect(
      (
        await resolveTerritoryNodes(repo, { territoryCodes: ['CJ'], sirutaCodes: ['10'] })
      )._unsafeUnwrap()
    ).toEqual([]);
    expect(
      (
        await resolveTerritoryNodes(repo, { sirutaCodes: ['127'], territoryLevels: ['LAU'] })
      )._unsafeUnwrap()
    ).toEqual([]);
  });
  it('does not guess prefix or missing Bucharest identities', async () => {
    const codes = ['RO-VL', 'siruta:127', '0127', '403', '179132', '179141', 'unknown'];
    const result = (
      await resolveInsTerritoryInputs(aliased(), codes, 'code', ['NUTS3'])
    )._unsafeUnwrap();
    expect(result.nodes).toEqual([]);
    expect(result.unresolvedCodes).toHaveLength(codes.length);
  });
  it('preserves error results', async () => {
    const repo = aliased();
    const error = { type: 'Timeout' as const, message: 'test' };
    repo.countyAliases = async () => err(error);
    expect((await resolveInsTerritoryInputs(repo, ['127'], 'siruta'))._unsafeUnwrapErr()).toBe(
      error
    );
  });
  it('rejects a numeric alias colliding with a different source node', async () => {
    const repo = aliased();
    repo.territoriesBySiruta = async () => ok([{ ...CLUJ_NAPOCA, sirutaCode: '127' }]);
    expect((await resolveInsTerritoryInputs(repo, ['127'], 'siruta'))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
  });
  it('catalog resolves filters before pagination and adds a separate canonical field', async () => {
    const page = (
      await listTerritories(aliased(), { sirutaCodes: ['127', '10'] }, 1, 1)
    )._unsafeUnwrap();
    expect(page.totalCount).toBe(2);
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]?.canonicalSirutaCode).toBe('10');
    const county = (await listTerritories(aliased(), { sirutaCodes: ['127'] }))._unsafeUnwrap()
      .nodes[0];
    expect(county).toBeDefined();
    if (county === undefined) return;
    expect(toGqlTerritory(county)).toMatchObject({
      code: 'CJ',
      siruta_code: null,
      canonical_siruta_code: '127',
      parent_code: 'RO11',
    });
    expect(
      (await listTerritories(aliased(), { sirutaCodes: ['999'] }))._unsafeUnwrap().nodes
    ).toEqual([]);
  });
  it('intersects internal node filters, including empty IDs, with aliases', async () => {
    for (const territoryIds of [[], [AB.territoryId]]) {
      expect(
        (await listTerritories(aliased(), { sirutaCodes: ['127'], territoryIds }))._unsafeUnwrap()
          .nodes
      ).toEqual([]);
    }
    expect(
      (
        await listTerritories(aliased(), { sirutaCodes: ['127'], territoryIds: [CJ.territoryId] })
      )._unsafeUnwrap().nodes[0]?.code
    ).toBe('CJ');
  });
  it('preserves an empty parent filter as an omitted constraint', async () => {
    const repo = aliased();
    const result = (await listTerritories(repo, { parentCode: '' }))._unsafeUnwrap();
    expect(result).toEqual((await listTerritories(repo, {}))._unsafeUnwrap());
    expect(result.nodes.length).toBeGreaterThan(0);
  });
  it('keeps catalog aliases and rows in the caller snapshot', async () => {
    const snapshot = aliased();
    const outer = aliased();
    outer.withSnapshot = async (fn) => fn(snapshot);
    outer.countyAliases = async () => err({ type: 'Timeout', message: 'outside snapshot' });
    expect((await listTerritories(outer, { sirutaCodes: ['127'] })).isOk()).toBe(true);
  });
});
