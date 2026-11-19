/**
 * Direct acquisitions release 1 — module wiring: the SDL and REST plugin are
 * always present beside the legacy surface; MCP tools only when enabled; the
 * legacy direct-acquisition query is still served.
 */
import fastifyLib from 'fastify';
import { describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementModule } from '@/modules/procurement/index.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

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

describe('the module serves release meta over GraphQL (its own resolver wiring)', () => {
  it('a release page carries meta.disclosureKey through makeProcurementModule', async () => {
    const AS_OF = '2026-11-19T03:10:00.000000Z';
    const module = makeProcurementModule({
      db: makeCapturingDb([], {
        respond: (text) => {
          if (text.includes('as privacy')) return [{ as_of: AS_OF, privacy: true }];
          if (text.includes('has_table_privilege')) return [{ present: true }];
          if (text.includes('as data_as_of')) return [{ data_as_of: AS_OF }];
          if (text.includes('as as_of')) return [{ as_of: AS_OF }];
          if (text.includes('as total')) return [{ total: '0' }];
          return [];
        },
      }),
      warmCache: false,
      daV3Enabled: true,
    });
    const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [module.graphqlSlice]);
    const app = fastifyLib({ logger: false });
    try {
      await app.register(
        makeGraphQLPlugin({
          schema: [typeDefs],
          resolvers: [{ ...scalarResolvers, ...module.graphqlResolvers }],
          isProduction: false,
          enableGraphiQL: false,
        })
      );
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query: '{ procurementDaPurchases(pageSize: 1) { dataAsOf meta { disclosureKey } } }',
        }),
      });
      const body = res.json<{ data?: Record<string, unknown>; errors?: unknown }>();
      expect(body.errors, res.body).toBeUndefined();
      expect(body.data?.['procurementDaPurchases']).toEqual({
        dataAsOf: AS_OF,
        meta: { disclosureKey: AS_OF },
      });
    } finally {
      await app.close();
    }
  });
});
