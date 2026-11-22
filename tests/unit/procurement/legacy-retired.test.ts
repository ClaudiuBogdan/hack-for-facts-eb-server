/**
 * PROCUREMENT_LEGACY_ENABLED=false (SEC-GRANTS-PROC-2211): every legacy read
 * answers ServiceUnavailable WITHOUT a query (the public-only grant covers no
 * legacy relation), while the CPV reference, DA release 1 and totals v2 stay;
 * only the CPV MCP tool (and the analysis tool while the DA v3 grain answers)
 * is registered; entity-360 presence is an error, never "absent". On (the
 * default) nothing changes.
 */
import fastifyLib from 'fastify';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeProcurementModule } from '@/modules/procurement/index.js';
import {
  LEGACY_RETIRED_MESSAGE,
  makeRetiredAnalysisRepo,
  retireLegacyRecords,
} from '@/modules/procurement/shell/repo/legacy-retired.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';

import type { ProcurementRepo } from '@/modules/procurement/core/ports.js';

const CPV_METHODS = ['listCpvDivisions', 'listCpvCodeLabels', 'resolveCpv'];

/** A repo that records every call by name and answers an empty ok. */
const recordingRepo = (calls: string[]): ProcurementRepo =>
  new Proxy({} as ProcurementRepo, {
    get: (_target, name) => () => {
      calls.push(String(name));
      return Promise.resolve(ok([]));
    },
  });

type AnyMethod = (...args: unknown[]) => Promise<{
  isErr: () => boolean;
  _unsafeUnwrapErr: () => { type: string; message: string };
}>;

describe('retired legacy records', () => {
  it('answers every record read ServiceUnavailable without calling the repo; CPV delegates', async () => {
    const calls: string[] = [];
    const retired = retireLegacyRecords(recordingRepo(calls));
    const methods = Object.keys(retired);
    expect(methods.length).toBeGreaterThan(20);
    for (const name of methods.filter((method) => !CPV_METHODS.includes(method))) {
      const result = await (retired[name as keyof ProcurementRepo] as unknown as AnyMethod)();
      expect(result.isErr(), name).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: 'ServiceUnavailable',
        message: LEGACY_RETIRED_MESSAGE,
      });
    }
    expect(calls).toEqual([]);
    await retired.listCpvDivisions();
    await retired.listCpvCodeLabels(['44']);
    await retired.resolveCpv('beton', 5);
    expect(calls).toEqual(CPV_METHODS);
  });

  it('retires every legacy analysis read', async () => {
    const analysis = makeRetiredAnalysisRepo();
    for (const [name, method] of Object.entries(analysis)) {
      const result = await (method as AnyMethod)();
      expect(result._unsafeUnwrapErr().type, name).toBe('ServiceUnavailable');
    }
  });
});

const build = (captured: CapturedQuery[], options: { legacy?: boolean; v3?: boolean } = {}) =>
  makeProcurementModule({
    db: makeCapturingDb(captured, {
      respond: (text) =>
        text.includes('cpv_divisions')
          ? [{ division_code: '44', label_en: 'Construction structures', label_ro: null }]
          : [],
    }),
    warmCache: true,
    ...(options.legacy !== undefined && { legacyEnabled: options.legacy }),
    ...(options.v3 !== undefined && { daV3Enabled: options.v3 }),
  });

const graphql = async (
  module: ReturnType<typeof makeProcurementModule>,
  query: string
): Promise<{ data?: Record<string, unknown> | null; errors?: { extensions?: unknown }[] }> => {
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
      payload: JSON.stringify({ query }),
    });
    const body: Awaited<ReturnType<typeof graphql>> = res.json();
    return body;
  } finally {
    await app.close();
  }
};

describe('the module with legacy off', () => {
  it('registers only the CPV tool, plus the analysis tool while the DA v3 grain answers', () => {
    expect(build([], { legacy: false }).mcpTools.map((tool) => tool.name)).toEqual([
      'resolve_procurement_filter',
    ]);
    const v3 = build([], { legacy: false, v3: true }).mcpTools.map((tool) => tool.name);
    expect(v3).toEqual(
      expect.arrayContaining(['resolve_procurement_filter', 'aggregate_procurement'])
    );
    expect(v3).not.toEqual(expect.arrayContaining(['search_procurement_contracts']));
    expect(v3).not.toEqual(expect.arrayContaining(['search_procurement_direct_acquisitions']));
  });

  it('keeps every tool with legacy on (the default)', () => {
    expect(build([]).mcpTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'resolve_procurement_filter',
        'search_procurement_contracts',
        'search_procurement_direct_acquisitions',
        'aggregate_procurement',
      ])
    );
  });

  it('answers legacy GraphQL reads ServiceUnavailable and runs no query; CPV is served', async () => {
    const captured: CapturedQuery[] = [];
    const module = build(captured, { legacy: false });
    // No cache warm and no legacy read at construction.
    expect(captured).toEqual([]);
    const legacy = await graphql(
      module,
      '{ procurementContract(id: "1") { __typename } procurementStats { blocks { __typename } } }'
    );
    expect(legacy.errors?.length).toBe(2);
    for (const error of legacy.errors ?? [])
      expect(error.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(captured).toEqual([]);

    const cpv = await graphql(module, '{ procurementCpvDivisions { divisionCode labelEn } }');
    expect(cpv.errors).toBeUndefined();
    expect(cpv.data?.['procurementCpvDivisions']).toEqual([
      { divisionCode: '44', labelEn: 'Construction structures' },
    ]);
    expect(captured.every((query) => query.sql.includes('cpv_divisions'))).toBe(true);
  });

  it('with DA v3 on, a legacy grain abstains as unavailable and reads only procurement_v3', async () => {
    const captured: CapturedQuery[] = [];
    const module = makeProcurementModule({
      db: makeCapturingDb(captured, {
        respond: (text) => {
          if (text.includes('as build_id'))
            return [
              { build_id: '1763435400123456', as_of: '2026-11-18T03:10:00.000000Z', privacy: true },
            ];
          // The approved grants make the pinned buyer geography table-readable.
          if (text.includes('from unnest')) return [{ name: 'da_buyer_geography' }];
          if (text.includes('has_table_privilege')) return [{ present: true }];
          return [];
        },
      }),
      warmCache: true,
      legacyEnabled: false,
      daV3Enabled: true,
    });
    const answer = await graphql(
      module,
      '{ procurementStats(scope: { grain: contract }) { blocks { grain recordCount meta { caveats } } } }'
    );
    expect(answer.errors).toBeUndefined();
    const blocks = (answer.data?.['procurementStats'] as { blocks: unknown[] }).blocks;
    expect(blocks).toEqual([
      {
        grain: 'contract',
        recordCount: null,
        meta: {
          caveats: expect.arrayContaining([
            'this grain is unavailable: the analytics build could not be read',
          ]) as unknown,
        },
      },
    ]);
    // Only the DA generation was read: every relation named is procurement_v3 (or the catalog).
    const relations = captured.flatMap((query) =>
      [...query.sql.matchAll(/(?:from|join)\s+"?([a-z_0-9]+)"?\."?([a-z_0-9]+)"?/gu)].map(
        (match) => `${match[1] ?? ''}.${match[2] ?? ''}`
      )
    );
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) expect(relation).toMatch(/^procurement_v3\./u);
    expect(captured.map((query) => query.sql).join('\n')).not.toMatch(
      /\b(?:core|etl|procurement)\.[a-z_]+/u
    );
  });

  it('reports entity-360 presence as unavailable, never as absent, with no query', async () => {
    const captured: CapturedQuery[] = [];
    const module = build(captured, { legacy: false });
    const presence = await module.contributor.presenceFor('4305857');
    expect(presence._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    expect(captured).toEqual([]);
  });
});
