import { GraphQLError } from 'graphql';
import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeProcurementResolvers } from '@/modules/procurement/shell/graphql/resolvers.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';
import { createMcpHttpDispatcher, timeoutError } from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import { fakeAnalysisRepo, statsRead } from './analysis-fakes.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';

const unusedRepo = {} as unknown as ProcurementRepo;

interface AnalysisQueryResolvers {
  procurementStats(
    root: unknown,
    args: { scope?: Readonly<Record<string, unknown>> }
  ): Promise<{ readonly blocks: readonly unknown[] }>;
  procurementBreakdown(
    root: unknown,
    args: {
      scope?: Readonly<Record<string, unknown>>;
      dimension: 'supplier';
      topN?: number;
    }
  ): Promise<unknown>;
  procurementSeries(
    root: unknown,
    args: {
      scope?: Readonly<Record<string, unknown>>;
      bucket: 'month';
      measure: 'recordCount';
    }
  ): Promise<readonly unknown[]>;
  procurementConcentration(
    root: unknown,
    args: { scope?: Readonly<Record<string, unknown>>; basis?: 'count' }
  ): Promise<readonly unknown[]>;
}

const surfaces = (analysis: AnalysisRepo) => {
  const resolvers = makeProcurementResolvers({ repo: unusedRepo, analysis }) as {
    readonly Query: AnalysisQueryResolvers;
  };
  const tool = makeProcurementMcpTools({
    repo: unusedRepo,
    analysis,
    clientBaseUrl: 'https://transparenta.eu',
  }).find((candidate) => candidate.name === 'aggregate_procurement');
  if (tool === undefined) throw new Error('aggregate_procurement is not registered');
  return { query: resolvers.Query, tool };
};

describe('GraphQL/MCP analysis parity', () => {
  it('returns the same valid stats blocks and envelopes', async () => {
    const { query, tool } = surfaces(fakeAnalysisRepo().repo);
    const scope = { authorityCui: '4267117' };

    const graphql = await query.procurementStats(undefined, { scope });
    const mcp = await tool.handler({ shape: 'stats', scope });

    expect(mcp.ok).toBe(true);
    expect(mcp.items).toEqual(graphql.blocks);
    expect(mcp.meta?.['envelopes']).toEqual(
      graphql.blocks.map((block) => (block as { readonly meta: unknown }).meta)
    );
  });

  it('returns identical series blocks and envelopes', async () => {
    const { query, tool } = surfaces(fakeAnalysisRepo({ series: [] }).repo);
    const scope = { authorityCui: '4267117', grain: 'direct_acquisition' };

    const graphql = await query.procurementSeries(undefined, {
      scope,
      bucket: 'month',
      measure: 'recordCount',
    });
    const mcp = await tool.handler({
      shape: 'series',
      scope,
      bucket: 'month',
      measure: 'recordCount',
    });

    expect(mcp.ok).toBe(true);
    expect(mcp.items).toEqual(graphql);
  });

  it('returns identical breakdown blocks and envelopes', async () => {
    const { query, tool } = surfaces(
      fakeAnalysisRepo({
        breakdown: {
          buckets: [],
          totals: statsRead({
            rows: '0',
            withValue: '0',
            valueAwardedSum: '0',
            undatedCount: '0',
          }),
        },
      }).repo
    );
    const scope = { authorityCui: '4267117', grain: 'direct_acquisition' };

    const graphql = await query.procurementBreakdown(undefined, {
      scope,
      dimension: 'supplier',
      topN: 5,
    });
    const mcp = await tool.handler({ shape: 'breakdown', scope, dimension: 'supplier', topN: 5 });

    expect(mcp.ok).toBe(true);
    expect(mcp.items).toEqual(graphql);
  });

  it('returns identical concentration blocks and envelopes', async () => {
    const { query, tool } = surfaces(fakeAnalysisRepo().repo);
    const scope = { authorityCui: '4267117', grain: 'direct_acquisition' };

    const graphql = await query.procurementConcentration(undefined, { scope, basis: 'count' });
    const mcp = await tool.handler({ shape: 'concentration', scope, basis: 'count' });

    expect(mcp.ok).toBe(true);
    expect(mcp.items).toEqual(graphql);
  });

  it('returns the same InvalidInput message for an explicit out-of-range topN', async () => {
    const { query, tool } = surfaces(fakeAnalysisRepo().repo);
    const args = { dimension: 'supplier' as const, topN: 51 };

    let graphqlError: GraphQLError | undefined;
    try {
      await query.procurementBreakdown(undefined, args);
    } catch (error: unknown) {
      if (error instanceof GraphQLError) graphqlError = error;
    }
    const mcp = await tool.handler({ shape: 'breakdown', ...args });

    expect(graphqlError?.extensions['type']).toBe('InvalidInput');
    expect(mcp.ok).toBe(false);
    expect(mcp).toMatchObject({ errorType: 'InvalidInput', errorCode: 'INVALID_INPUT' });
    expect(mcp.error).toBe(graphqlError?.message);
  });

  it('routes out-of-range topN through core on the real MCP wire', async () => {
    const { query, tool } = surfaces(fakeAnalysisRepo().repo);
    let graphqlError: GraphQLError | undefined;
    try {
      await query.procurementBreakdown(undefined, { dimension: 'supplier', topN: 51 });
    } catch (error: unknown) {
      if (error instanceof GraphQLError) graphqlError = error;
    }

    const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer([tool]));
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'aggregate_procurement',
        arguments: { shape: 'breakdown', dimension: 'supplier', topN: 51 },
      },
    });
    const wire = JSON.stringify(response);
    expect(wire).toContain(graphqlError?.message ?? 'topN');
    expect(wire).toContain('"errorType":"InvalidInput"');
    expect(wire).toContain('"errorCode":"INVALID_INPUT"');
    expect(wire).not.toContain('MCP error -32602');
    await dispatcher.close();
  });

  it.each([
    {
      label: 'calendar month',
      args: { shape: 'stats', scope: { from: '2025-13', grain: 'contract' } },
    },
    {
      label: 'unsupported series measure',
      args: {
        shape: 'series',
        scope: { grain: 'contract' },
        measure: 'avgValueAwarded',
        bucket: 'month',
      },
    },
    {
      label: 'matrix rejection',
      args: {
        shape: 'series',
        scope: { grain: 'direct_acquisition' },
        measure: 'distinctSuppliers',
        bucket: 'month',
      },
    },
  ])('preserves InvalidInput metadata on the real MCP wire: $label', async ({ args }) => {
    const { tool } = surfaces(fakeAnalysisRepo().repo);
    const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer([tool]));
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aggregate_procurement', arguments: args },
    });
    expect(JSON.stringify(response)).toContain('"errorType":"InvalidInput"');
    expect(JSON.stringify(response)).toContain('"errorCode":"INVALID_INPUT"');
    await dispatcher.close();
  });

  it('maps an analysis timeout to typed GraphQL and MCP responses', async () => {
    const base = fakeAnalysisRepo().repo;
    const message = 'procurement stats timed out';
    const analysis: AnalysisRepo = {
      ...base,
      statsFor: () => Promise.resolve(err(timeoutError(message))),
    };
    const { query, tool } = surfaces(analysis);

    let graphqlError: GraphQLError | undefined;
    try {
      await query.procurementStats(undefined, {});
    } catch (error: unknown) {
      if (error instanceof GraphQLError) graphqlError = error;
    }
    const mcp = await tool.handler({ shape: 'stats' });

    expect(graphqlError?.extensions).toMatchObject({
      code: 'GATEWAY_TIMEOUT',
      type: 'Timeout',
    });
    expect(graphqlError?.message).toBe(message);
    expect(mcp).toMatchObject({
      ok: false,
      kind: 'timeout',
      errorType: 'Timeout',
      errorCode: 'GATEWAY_TIMEOUT',
      error: message,
    });
  });
});
