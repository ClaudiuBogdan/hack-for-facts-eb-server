/**
 * Kernel GraphQL conflict gate (§14.8) + contributor registry / entity-360
 * fan-out (§4.4) with mocked ports.
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeEntity360, type Entity360Deps } from '@/modules/shared/core/usecases/entity-360.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';
import { mergeGraphqlSlices } from '@/modules/shared/shell/graphql/merge.js';
import { baseTypeDefs } from '@/modules/shared/shell/graphql/typedefs.js';

import type { ApiError } from '@/modules/shared/core/errors.js';
import type { FlowSummary, Organization, SourcePresence } from '@/modules/shared/core/types.js';

describe('mergeGraphqlSlices conflict gate', () => {
  it('accepts legit extends', () => {
    const result = mergeGraphqlSlices(baseTypeDefs, [
      {
        source: 'pnrr',
        typeDefs: 'extend type Entity { pnrr: PnrrSummary }\ntype PnrrSummary { total: Money }',
      },
      { source: 'budget', typeDefs: 'extend type Query { budgetReport(cui: CUI!): String }' },
    ]);
    expect(result.typeDefs).toContain('PnrrSummary');
  });

  it('rejects a module re-declaring a kernel base type', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'rogue', typeDefs: 'type Entity { hacked: String }' },
      ])
    ).toThrow(/kernel base type/u);
  });

  it('rejects two modules defining the same type name', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'a', typeDefs: 'type Shared { x: Int }' },
        { source: 'b', typeDefs: 'type Shared { y: Int }' },
      ])
    ).toThrow(/defined by both/u);
  });

  it('rejects two modules adding the same Entity field', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'a', typeDefs: 'extend type Entity { dup: String }' },
        { source: 'b', typeDefs: 'extend type Entity { dup: Int }' },
      ])
    ).toThrow(/added by both/u);
  });

  it('rejects invalid SDL with a clear error', () => {
    expect(() => mergeGraphqlSlices(baseTypeDefs, [{ source: 'bad', typeDefs: 'type {' }])).toThrow(
      /not valid SDL/u
    );
  });

  it('rejects a module re-adding a kernel-owned Query field (B5)', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'rogue', typeDefs: 'extend type Query { health: String }' },
      ])
    ).toThrow(/added by both/u);
  });

  it('rejects a module re-adding a kernel-owned Entity field (B5)', () => {
    expect(() =>
      mergeGraphqlSlices(baseTypeDefs, [
        { source: 'rogue', typeDefs: 'extend type Entity { cui: String }' },
      ])
    ).toThrow(/added by both/u);
  });
});

const org: Organization = {
  orgId: '423219',
  cui: '16054368',
  registrationNumber: null,
  kind: 'company',
  name: 'CNAIR',
  normalizedName: 'cnair',
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'anaf',
  attrs: {},
};

const emptySummary = (direction: 'in' | 'out'): FlowSummary => ({
  direction,
  count: 0,
  totalAmountRon: '0',
  minYear: null,
  maxYear: null,
  byFlowType: [],
  byYear: [],
});

const makeDeps = (presences: (SourcePresence | null)[]): Entity360Deps => {
  const registry = createContributorRegistry();
  presences.forEach((p, i) => {
    registry.register({
      source: `src${String(i)}`,
      presenceFor: (): Promise<Result<SourcePresence | null, ApiError>> => Promise.resolve(ok(p)),
    });
  });
  return {
    identityRepo: {
      findByCui: () => Promise.resolve(ok(org)),
      findManyByCui: () => Promise.resolve(ok(new Map([[org.cui ?? '', org]]))),
      findByOrgId: () => Promise.resolve(ok(org)),
      getIdentifiers: () =>
        Promise.resolve(ok([{ scheme: 'cui', value: '16054368', source: 'anaf' }])),
      searchByName: () => Promise.resolve(ok([])),
      resolve: () => Promise.resolve(ok({ org, confidence: 1 })),
      territoryForCui: () => Promise.resolve(ok(null)),
    },
    flowsRepo: {
      getFlowSummary: (_cui, direction) => Promise.resolve(ok(emptySummary(direction))),
      getTopCounterparties: () => Promise.resolve(ok([])),
      listFlows: () => Promise.resolve(ok({ items: [], next: null })),
      getCounterpartyNetwork: () =>
        Promise.resolve(ok({ rootCui: '', depth: 1, nodes: [], edges: [] })),
      aggregateFlows: () => Promise.resolve(ok([])),
    },
    searchRepo: {
      countByCui: () => Promise.resolve(ok(7)),
      fallbackTextSearch: () => Promise.resolve(ok([])),
      searchEntities: () => Promise.resolve(ok([])),
    },
    registry,
  };
};

describe('makeEntity360 over the contributor registry', () => {
  it('assembles identity + flow summaries + present contributors', async () => {
    const present: SourcePresence = { source: 'src0', present: true, label: 'PNRR', count: 3 };
    const deps = makeDeps([present, null]);
    const result = await makeEntity360(deps, 'RO 16054368');
    expect(result.isOk()).toBe(true);
    const e = result._unsafeUnwrap();
    expect(e.cui).toBe('16054368');
    expect(e.organization?.name).toBe('CNAIR');
    expect(e.documentCount).toBe(7);
    expect(e.identifiers).toHaveLength(1);
    // null presences are dropped.
    expect(e.presence).toHaveLength(1);
    expect(e.presence[0]?.label).toBe('PNRR');
  });

  it('rejects an invalid CUI', async () => {
    const deps = makeDeps([]);
    const result = await makeEntity360(deps, 'not-a-cui');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
  });
});
