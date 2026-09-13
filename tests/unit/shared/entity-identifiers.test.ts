import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { databaseError } from '@/modules/shared/core/errors.js';
import { makeEntity360 } from '@/modules/shared/core/usecases/entity-360.js';
import {
  makeKernelResolvers,
  type KernelResolverDeps,
} from '@/modules/shared/shell/graphql/resolvers.js';

import type { Organization } from '@/modules/shared/core/types.js';

const org: Organization = {
  orgId: '1',
  cui: '4305857',
  name: 'Public entity',
  normalizedName: null,
  registrationNumber: null,
  kind: 'public_entity',
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'budget',
  attrs: {},
};
const identifiers = [{ scheme: 'CUI', value: '4305857', source: 'budget' }];
const schema = buildSchema(`
  type Query { entity(cui: String!): Entity, joined(cui: String!): Entity }
  type Entity { cui: String!, identifiers: [Identifier!]! }
  type Identifier { scheme: String!, value: String!, source: String! }
`);

function fixture(
  options: { missing?: boolean; identifierError?: boolean; identityError?: boolean } = {}
) {
  const calls = { identity: 0, identifiers: 0 };
  const identityRepo = {
    findByCui: async () => {
      calls.identity++;
      return options.identityError === true
        ? err(databaseError('identity unavailable'))
        : ok(options.missing === true ? null : org);
    },
    getIdentifiers: async () => {
      calls.identifiers++;
      return options.identifierError === true
        ? err(databaseError('identifiers unavailable'))
        : ok(identifiers);
    },
    findManyByCui: async () => ok(new Map()),
    findByOrgId: async () => ok(null),
    searchByName: async () => ok([]),
    resolve: async () => ok(null),
    territoryForCui: async () => ok(null),
  };
  const flow = {
    direction: 'in' as const,
    count: 0,
    totalAmountRon: '0',
    minYear: null,
    maxYear: null,
    byFlowType: [],
    byYear: [],
  };
  const entity360Deps = {
    identityRepo,
    flowsRepo: {
      getFlowSummary: async () => ok(flow),
    } as unknown as KernelResolverDeps['flowsRepo'],
    searchRepo: { countByCui: async () => ok(0) } as KernelResolverDeps['searchRepo'],
    registry: { list: () => [], get: () => undefined, register: () => undefined },
  };
  const deps = { ...entity360Deps, entity360Deps } as unknown as KernelResolverDeps;
  const resolvers = makeKernelResolvers(deps) as Record<
    string,
    Record<string, typeof defaultFieldResolver>
  >;
  const run = (source: string) =>
    graphql({
      schema,
      source,
      fieldResolver: (parent, args, context, info) => {
        if (info.parentType.name === 'Query' && info.fieldName === 'joined')
          return { cui: args.cui };
        return (resolvers[info.parentType.name]?.[info.fieldName] ?? defaultFieldResolver)(
          parent,
          args,
          context,
          info
        );
      },
    });
  return { calls, run, entity360Deps };
}

describe('lazy entity identifiers', () => {
  it('omitted identifiers do not query the repository, even during an identifier outage', async () => {
    const f = fixture({ identifierError: true });
    const result = await f.run('{ entity(cui: "4305857") { cui } }');
    expect(result.errors).toBeUndefined();
    expect(result.data?.['entity']).toEqual({ cui: '4305857' });
    expect(f.calls).toEqual({ identity: 1, identifiers: 0 });
  });
  it.each(['entity', 'joined'])(
    'resolves selected identifiers through %s, including fragments and aliases',
    async (field) => {
      const f = fixture();
      const result = await f.run(
        `{ ${field}(cui: "4305857") { ...Ids } } fragment Ids on Entity { ids: identifiers { scheme value source } }`
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.[field]).toEqual({ ids: identifiers });
      expect(f.calls.identifiers).toBe(1);
    }
  );
  it.each(['entity', 'joined'])(
    'returns no identifiers for an absent or privacy-filtered organization through %s',
    async (field) => {
      const f = fixture({ missing: true });
      const result = await f.run(`{ ${field}(cui: "4305857") { cui identifiers { value } } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data?.[field]).toEqual({ cui: '4305857', identifiers: [] });
      expect(f.calls.identifiers).toBe(0);
    }
  );
  it.each(['entity', 'joined'])(
    'refuses withheld identifiers before any repository access through %s',
    async (field) => {
      const f = fixture();
      const result = await f.run(`{ ${field}(cui: "9999999999999") { identifiers { value } } }`);
      expect(result.data?.[field]).toBeNull();
      expect(f.calls).toEqual({ identity: 0, identifiers: 0 });
    }
  );
  it.each([{ identifierError: true }, { identityError: true }])(
    'preserves selected-field failures: %j',
    async (options) => {
      const f = fixture(options);
      const result = await f.run('{ joined(cui: "4305857") { identifiers { value } } }');
      expect(result.errors?.length).toBe(1);
      expect(result.data?.['joined']).toBeNull();
    }
  );
  it('keeps full entity-360 assembly eager', async () => {
    const f = fixture();
    const result = await makeEntity360(f.entity360Deps, '4305857');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.identifiers).toEqual(identifiers);
    expect(f.calls.identifiers).toBe(1);
  });
});
