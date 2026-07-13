// eslint-disable-next-line import-x/no-unresolved -- wildcard exports in SDK package.json are not supported by the resolver
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import-x/no-unresolved -- wildcard exports in SDK package.json are not supported by the resolver
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMcpServer,
  type CreateMcpServerDeps,
} from '@/modules/mcp/shell/server/mcp-server.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';

import { fakeAnalysisRepo } from '../procurement/analysis-fakes.js';

import type { ProcurementRepo } from '@/modules/procurement/core/ports.js';

const REMOVED_PROCUREMENT_TOOLS = [
  'query_procurement_filters',
  'get_procurement_aggregate_gate',
  'get_top_procurement_suppliers',
  'get_procurement_cpv_breakdown',
  'get_procurement_same_day_candidates',
  'get_procurement_geographic_breakdown',
  'get_procurement_time_series',
] as const;

const LEGACY_BUDGET_TOOLS = [
  'get_entity_snapshot',
  'discover_filters',
  'rank_entities',
  'query_timeseries_data',
  'analyze_entity_budget',
  'explore_budget_breakdown',
] as const;

describe('procurement MCP inventory across both registries', () => {
  const close: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map(async (fn) => fn()));
  });

  it('keeps the legacy /mcp registry budget-only', async () => {
    // Listing tools does not execute dependencies; inert values make this an
    // in-memory protocol inventory test without mocking libraries or I/O.
    const server = createMcpServer({} as CreateMcpServerDeps);
    const client = new Client({ name: 'procurement-inventory-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(
      async () => client.close(),
      async () => server.close()
    );

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(LEGACY_BUDGET_TOOLS);
    for (const removed of REMOVED_PROCUREMENT_TOOLS) expect(names).not.toContain(removed);
  });

  it('keeps the redesigned /api/v1/mcp registry on the retained procurement contract', () => {
    const names = makeProcurementMcpTools({
      repo: {} as ProcurementRepo,
      analysis: fakeAnalysisRepo().repo,
      clientBaseUrl: 'https://transparenta.eu',
    }).map((tool) => tool.name);

    expect(names).toEqual([
      'resolve_procurement_filter',
      'search_procurement_contracts',
      'search_procurement_direct_acquisitions',
      'aggregate_procurement',
    ]);
    for (const removed of REMOVED_PROCUREMENT_TOOLS) expect(names).not.toContain(removed);
  });
});
