/**
 * Kernel MCP — `resolve_entity` + `get_entity_snapshot` handlers (foundation
 * §6.3, §7.4). These ship alongside `search_entities` (covered separately) and
 * must remain present + unchanged; this exercises their handler bodies so the
 * shared MCP tool surface stays under the coverage gate.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { databaseError } from '@/modules/shared/core/errors.js';
import { makeKernelMcpTools, type KernelMcpDeps } from '@/modules/shared/shell/mcp/tools.js';

import type {
  FlowSummary,
  Organization,
  SourcePresence,
  Territory,
} from '@/modules/shared/core/types.js';
import type { Entity360Deps } from '@/modules/shared/core/usecases/entity-360.js';
import type { KernelMcpTool } from '@/modules/shared/shell/mcp/types.js';

const ORG: Organization = {
  orgId: '500',
  cui: '4305857',
  registrationNumber: null,
  kind: 'public_entity',
  name: 'Municipiul Cluj-Napoca',
  normalizedName: 'municipiul cluj napoca',
  countyName: 'Cluj',
  localityName: 'Cluj-Napoca',
  sirutaCode: '54975',
  firstSeenSource: 'mfin',
  attrs: {},
};

const TERRITORY: Territory = {
  id: 1,
  territorialSirutaCode: '54975',
  sirutaCode: '54975',
  countySirutaCode: '54932',
  uatCode: null,
  name: 'Cluj-Napoca',
  countyCode: 'CJ',
  countyName: 'Cluj',
  region: 'Nord-Vest',
  population: 320000,
};

const flow = (direction: 'in' | 'out', count: number): FlowSummary => ({
  direction,
  count,
  totalAmountRon: '1000',
  minYear: 2020,
  maxYear: 2024,
  byFlowType: [],
  byYear: [],
});

const presence = (source: string): SourcePresence => ({ source, present: true, label: source });

const tool = (tools: readonly KernelMcpTool[], name: string): KernelMcpTool => {
  const t = tools.find((x) => x.name === name);
  expect(t).toBeDefined();
  return t!;
};

/** Build kernel MCP tools with controllable identity + entity-360 fakes. */
const build = (opts: {
  resolve?: Parameters<typeof ok>[0] | 'err' | 'null';
  territory?: Territory | null;
  entityOrg?: Organization | null;
}): readonly KernelMcpTool[] => {
  const resolve = vi.fn(async () => {
    if (opts.resolve === 'err') return err(databaseError('identity down'));
    if (opts.resolve === 'null') return ok(null);
    return ok({ org: ORG, confidence: 0.92 });
  });
  const territoryForCui = vi.fn(async () => ok(opts.territory ?? TERRITORY));
  const findByCui = vi.fn(async () => ok(opts.entityOrg === undefined ? ORG : opts.entityOrg));
  const getIdentifiers = vi.fn(async () => ok([]));
  const getFlowSummary = vi.fn(async (_cui: string, dir: 'in' | 'out') =>
    ok(flow(dir, dir === 'in' ? 3 : 1))
  );
  const countByCui = vi.fn(async () => ok(7));
  const registry = { list: () => [{ source: 'budget', presenceFor: async () => ok(presence('budget')) }] };

  const identityRepo = { resolve, territoryForCui, findByCui, getIdentifiers } as never;
  const entity360Deps = {
    identityRepo,
    flowsRepo: { getFlowSummary } as never,
    searchRepo: { countByCui } as never,
    registry,
  } as unknown as Entity360Deps;

  const deps: KernelMcpDeps = {
    identityRepo,
    entity360Deps,
    globalSearchDeps: {} as never,
    clientBaseUrl: 'https://transparenta.eu',
  };
  return makeKernelMcpTools(deps);
};

describe('resolve_entity', () => {
  it('resolves a name to org + territory with a client deep-link', async () => {
    const res = await tool(build({}), 'resolve_entity').handler({ query: 'Cluj-Napoca' });

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('entity_resolution');
    expect(res.link).toBe('https://transparenta.eu/entitati/4305857');
    const item = res.item as Record<string, unknown>;
    expect(item['cui']).toBe('4305857');
    expect(item['name']).toBe('Municipiul Cluj-Napoca');
    expect(item['territory']).toMatchObject({ name: 'Cluj-Napoca' });
    expect(res.summary).toContain('Municipiul Cluj-Napoca');
  });

  it('returns a friendly no-match (ok, no item) when nothing resolves', async () => {
    const res = await tool(build({ resolve: 'null' }), 'resolve_entity').handler({ query: 'zzz' });
    expect(res.ok).toBe(true);
    expect(res.item).toBeUndefined();
    expect(res.summary).toContain('No entity matched');
  });

  it('reports an identity-repo error as { ok:false }', async () => {
    const res = await tool(build({ resolve: 'err' }), 'resolve_entity').handler({ query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});

describe('get_entity_snapshot', () => {
  it('returns a cross-source snapshot with flow + presence summary', async () => {
    const res = await tool(build({}), 'get_entity_snapshot').handler({ cui: '4305857' });

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('entity_snapshot');
    expect(res.link).toBe('https://transparenta.eu/entitati/4305857');
    const item = res.item as Record<string, unknown>;
    expect(item['cui']).toBe('4305857');
    expect(item['documentCount']).toBe(7);
    expect(res.summary).toContain('Municipiul Cluj-Napoca');
    expect(res.summary).toContain('inbound');
  });

  it('summarizes a CUI with no organization record', async () => {
    const res = await tool(build({ entityOrg: null }), 'get_entity_snapshot').handler({
      cui: '9999999',
    });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('no organization record');
  });
});
