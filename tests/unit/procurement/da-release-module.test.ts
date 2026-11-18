/**
 * Direct acquisitions release 1 — module wiring: the SDL and REST plugin are
 * always present beside the legacy surface; MCP tools only when enabled; the
 * legacy direct-acquisition query is still served.
 */
import { describe, expect, it } from 'vitest';

import { makeProcurementModule } from '@/modules/procurement/index.js';
import { baseTypeDefs, mergeGraphqlSlices } from '@/modules/shared/index.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

const DA_TOOLS = [
  'list_procurement_da_purchases',
  'get_procurement_da_purchase',
  'aggregate_procurement_da_totals',
];

const build = (daV3Enabled?: boolean) =>
  makeProcurementModule({
    db: makeCapturingDb([]),
    warmCache: false,
    ...(daV3Enabled !== undefined && { daV3Enabled }),
  });

describe('procurement module with the DA release', () => {
  it('is off by default: SDL and resolvers present, no MCP tools', () => {
    const module = build();
    expect(module.graphqlSlice.typeDefs).toContain('procurementDaRelease: ProcurementDaRelease!');
    expect(module.graphqlSlice.typeDefs).toContain('procurementDirectAcquisition(id: ID!)');
    const query = module.graphqlResolvers['Query'] as Record<string, unknown>;
    for (const name of [
      'procurementDaRelease',
      'procurementDaPurchases',
      'procurementDaPurchase',
      'procurementDaTotals',
      'procurementDirectAcquisitions',
    ])
      expect(typeof query[name]).toBe('function');
    expect(module.mcpTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([DA_TOOLS[0]])
    );
    expect(typeof module.daRestPlugin).toBe('function');
  });

  it('merges with the kernel base without a type-name collision against the legacy SDL', () => {
    expect(() => mergeGraphqlSlices(baseTypeDefs, [build().graphqlSlice])).not.toThrow();
  });

  it('registers the three MCP tools when enabled', () => {
    const names = build(true).mcpTools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([...DA_TOOLS, 'search_procurement_direct_acquisitions'])
    );
  });
});
