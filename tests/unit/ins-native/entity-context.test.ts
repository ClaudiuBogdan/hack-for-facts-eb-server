import { buildSchema, graphql, isObjectType, type GraphQLFieldResolver } from 'graphql';
import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { budgetLegacyTypeDefs } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { resolveInsEntityContext } from '@/modules/ins-native/core/entity-context.js';
import { makeInsNativeModule } from '@/modules/ins-native/index.js';
import { makeInsContributor } from '@/modules/ins-native/shell/contributor.js';
import { makeInsLegacyResolvers } from '@/modules/ins-native/shell/graphql/legacy/resolvers.js';
import { baseTypeDefs, type ApiError, type Territory } from '@/modules/shared/index.js';

import { CLUJ_NAPOCA, makeFakeRepo } from './fake-repo.js';

import type { InsRepo } from '@/modules/ins-native/core/ports.js';
import type { InsTerritoryNode } from '@/modules/ins-native/core/types.js';

const anchor = (fields: Partial<Territory> = {}): Territory => ({
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
  ...fields,
});
const identity = (value: Territory | null = anchor()) => ({
  territoryForCui: vi.fn(async () => ok(value)),
});
const repository = (node: InsTerritoryNode | null = CLUJ_NAPOCA) => {
  const repo: InsRepo = {
    ...makeFakeRepo(),
    territoriesByCodes: vi.fn(async () => ok(node === null ? [] : [node])),
    territoriesByCoreId: vi.fn(async () => ok([])),
    datasetsForTerritory: vi.fn(async () => ok(['POPTEST'])),
  };
  repo.withSnapshot = (fn) => fn(repo);
  vi.spyOn(repo, 'withSnapshot');
  return repo;
};
const error: ApiError = { type: 'ServiceUnavailable', message: 'Unavailable' };

describe('native entity INS context', () => {
  it('normalizes CUI and uses the same snapshot for bridge and certified coverage', async () => {
    const scoped = repository();
    const outer = repository(null);
    outer.withSnapshot = (fn) => fn(scoped);
    const deps = identity();
    const result = (await resolveInsEntityContext(outer, deps, ' RO 123 '))._unsafeUnwrap();
    expect(result).toEqual({
      territoryCode: '54975',
      territoryLevel: 'LAU',
      territoryName: CLUJ_NAPOCA.nameRo,
      sirutaCode: '54975',
      datasetCount: 1,
    });
    expect(deps.territoryForCui).toHaveBeenCalledExactlyOnceWith('123');
    expect(outer.territoriesByCodes).not.toHaveBeenCalled();
    expect(scoped.territoriesByCoreId).toHaveBeenCalledExactlyOnceWith(7001);
    expect(scoped.datasetsForTerritory).toHaveBeenCalledExactlyOnceWith(CLUJ_NAPOCA.territoryId);
  });
  it('retains zero coverage in profile but omits the presence badge', async () => {
    const repo = repository();
    repo.datasetsForTerritory = async () => ok([]);
    const contributor = makeInsContributor(repo, identity());
    expect((await contributor.presenceFor('123'))._unsafeUnwrap()).toBeNull();
    expect((await contributor.profileSlice('123'))._unsafeUnwrap()).toMatchObject({
      source: 'ins',
      kind: 'territory-context',
      data: { territoryCode: '54975', datasetCount: 0 },
    });
  });
  it('rejects unwired explicit context without changing optional presence', async () => {
    const repo = repository();
    const contributor = makeInsContributor(repo);
    expect((await contributor.presenceFor('123'))._unsafeUnwrap()).toBeNull();
    expect((await contributor.profileSlice('123'))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    expect(repo.withSnapshot).not.toHaveBeenCalled();
  });
  it.each(['12345678901', 'RO 1234567890123'])(
    'withholds direct profile reads before any dependency access: %s',
    async (cui) => {
      const repo = repository();
      const deps = identity();
      expect((await makeInsContributor(repo, deps).profileSlice(cui))._unsafeUnwrap()).toBeNull();
      expect(deps.territoryForCui).not.toHaveBeenCalled();
      expect(repo.withSnapshot).not.toHaveBeenCalled();
    }
  );
  it.each(['', 'RO', '12345678901234'])(
    'rejects invalid identity before dependency access: %s',
    async (cui) => {
      const deps = identity();
      expect((await resolveInsEntityContext(repository(), deps, cui))._unsafeUnwrapErr().type).toBe(
        'InvalidInput'
      );
      expect(deps.territoryForCui).not.toHaveBeenCalled();
    }
  );
  it('distinguishes missing anchor, unsupported anchor and no source node from failed reads', async () => {
    expect(
      (await resolveInsEntityContext(repository(), identity(null), '123'))._unsafeUnwrap()
    ).toBeNull();
    expect(
      (
        await resolveInsEntityContext(repository(), identity(anchor({ kind: 'future' })), '123')
      )._unsafeUnwrap()
    ).toBeNull();
    expect(
      (await resolveInsEntityContext(repository(null), identity(), '123'))._unsafeUnwrap()
    ).toBeNull();
    expect(
      (
        await resolveInsEntityContext(
          repository(),
          { territoryForCui: async () => err(error) },
          '123'
        )
      )._unsafeUnwrapErr()
    ).toEqual(error);
  });
  it.each(['territoriesByCodes', 'territoriesByCoreId', 'datasetsForTerritory'] as const)(
    'propagates %s failures',
    async (method) => {
      const repo = repository();
      repo[method] = async () => err<never, ApiError>(error);
      expect(
        (await makeInsContributor(repo, identity()).profileSlice('123'))._unsafeUnwrapErr()
      ).toEqual(error);
    }
  );
  it('fails reverse-only bridge and duplicate coverage instead of returning absence/count', async () => {
    const reverseOnly = repository(null);
    reverseOnly.territoriesByCoreId = async () => ok([{ ...CLUJ_NAPOCA, coreTerritoryId: 7001 }]);
    expect(
      (await resolveInsEntityContext(reverseOnly, identity(), '123'))._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
    const duplicate = repository();
    duplicate.datasetsForTerritory = async () => ok(['POPTEST', 'POPTEST']);
    expect(
      (await resolveInsEntityContext(duplicate, identity(), '123'))._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
  });
  it.each([
    ['179132', 'uat', 'municipality', 'LAU'],
    ...['179141', '179150', '179169', '179178', '179187', '179196'].map((code) => [
      code,
      'locality',
      'sector',
      'LAU',
    ]),
    ['B', 'county', 'county', 'NUTS3'],
    ['RO1', 'macroregion', 'macroregion', 'NUTS1'],
    ['RO11', 'region', 'development_region', 'NUTS2'],
  ])(
    'keeps canonical %s context without fiscal type inference',
    async (code, level, kind, insLevel) => {
      const siruta = insLevel === 'LAU' ? code : null;
      const node = {
        ...CLUJ_NAPOCA,
        code,
        sirutaCode: siruta,
        level: insLevel as InsTerritoryNode['level'],
      };
      const territory = anchor({
        level,
        kind,
        territoryKey: siruta === null ? null : `siruta:${siruta}`,
        territorialSirutaCode: siruta,
        sirutaCode: siruta,
        countySirutaCode: null,
        countyCode: 'B',
        nutsCode: insLevel === 'NUTS1' || insLevel === 'NUTS2' ? code : null,
      });
      expect(
        (
          await resolveInsEntityContext(repository(node), identity(territory), '123')
        )._unsafeUnwrap()
      ).toMatchObject({ territoryCode: code, territoryLevel: insLevel });
    }
  );
});

async function executeContextQuery(repo: InsRepo, lookup = identity().territoryForCui) {
  const module = makeInsNativeModule({
    db: {} as never,
    registry: { register: () => undefined, list: () => [], get: () => undefined },
    repo,
    territoryForCui: lookup,
  });
  const schema = buildSchema(
    [
      baseTypeDefs,
      budgetLegacyTypeDefs,
      'extend type PageInfo { totalCount: Int hasPreviousPage: Boolean startCursor: String }',
      module.graphqlSlice.typeDefs,
    ].join('\n')
  );
  const operation = { requestId: 'one-operation' };
  const selected = vi.fn(async (context: unknown) => {
    expect(context).toBe(operation);
    return repo;
  });
  const unbound = new Proxy({} as InsRepo, {
    get: () => {
      throw new Error('Unbound repository used');
    },
  });
  const resolvers = makeInsLegacyResolvers({
    repo: unbound,
    repoForContext: selected,
    territoryForCui: lookup,
  });
  const maps = {
    ...resolvers,
    Query: { ...(resolvers['Query'] as object), entity: () => ({ cui: '123' }) },
  };
  for (const [typeName, fields] of Object.entries(maps)) {
    const type = schema.getType(typeName);
    if (!isObjectType(type)) continue;
    for (const [fieldName, resolver] of Object.entries(fields as object)) {
      const field = type.getFields()[fieldName];
      if (field !== undefined && typeof resolver === 'function')
        field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
    }
  }
  const result = await graphql({
    schema,
    source:
      '{ entity(cui:"123") { a: ins { territoryCode territoryLevel datasetCount } b: ins { territoryCode } } insDataset(code:"POPTEST") { code } }',
    contextValue: operation,
  });
  return { result, selected, module };
}

describe('native entity INS GraphQL projection', () => {
  it('shares the request repo across aliases and native sibling fields', async () => {
    const { result, selected, module } = await executeContextQuery(repository());
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      entity: {
        a: { territoryCode: '54975', territoryLevel: 'LAU', datasetCount: 1 },
        b: { territoryCode: '54975' },
      },
      insDataset: { code: 'POPTEST' },
    });
    expect(selected).toHaveBeenCalledTimes(3);
    expect((await module.contributor.profileSlice?.('123'))?._unsafeUnwrap()).toMatchObject({
      data: { territoryCode: '54975', datasetCount: 1 },
    });
  });
  it('surfaces a bridge failure as a field error while preserving unrelated native data', async () => {
    const repo = repository();
    repo.territoriesByCoreId = async () => err(error);
    const { result } = await executeContextQuery(repo);
    expect(result.errors).toHaveLength(2);
    expect(result.errors?.[0]?.extensions['code']).toBe('SERVICE_UNAVAILABLE');
    expect(result.data).toEqual({ entity: { a: null, b: null }, insDataset: { code: 'POPTEST' } });
  });
});
