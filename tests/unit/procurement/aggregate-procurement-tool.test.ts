/**
 * The retained `aggregate_procurement` MCP tool: same executors as GraphQL,
 * envelopes ride in `meta`, the summary ALWAYS says "awarded value, not
 * payments" when money appears, and matrix rejections surface verbatim.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';

import { fakeAnalysisRepo, verdict } from './analysis-fakes.js';

import type { AnalysisRepo, ProcurementRepo } from '@/modules/procurement/core/ports.js';
import type { KernelMcpTool } from '@/modules/shared/index.js';

// The analysis tools never touch the entity/aggregate repos — inert stubs suffice.
const unusedRepo = {} as unknown as ProcurementRepo;

const toolsWith = (analysis: AnalysisRepo): readonly KernelMcpTool[] =>
  makeProcurementMcpTools({
    repo: unusedRepo,
    analysis,
    clientBaseUrl: 'https://transparenta.eu',
  });

const toolNamed = (tools: readonly KernelMcpTool[], name: string): KernelMcpTool => {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
};

describe('tool registry', () => {
  it('exposes only the retained procurement tools', () => {
    const names = toolsWith(fakeAnalysisRepo().repo).map((t) => t.name);
    expect(names).toEqual([
      'resolve_procurement_filter',
      'search_procurement_contracts',
      'search_procurement_direct_acquisitions',
      'aggregate_procurement',
    ]);
  });
});

describe('aggregate_procurement', () => {
  it('is strict at both the top level and nested scope', () => {
    const tool = toolNamed(toolsWith(fakeAnalysisRepo().repo), 'aggregate_procurement');
    expect(tool.strictInput).toBe(true);
    const schema = z.object(tool.inputShape).strict();
    expect(schema.safeParse({ shape: 'stats', authorityCUI: '4267117' }).success).toBe(false);
    expect(schema.safeParse({ shape: 'stats', scope: { authorityCUI: '4267117' } }).success).toBe(
      false
    );
    expect(schema.safeParse({ shape: 'stats' }).success).toBe(true);
  });
  it('stats: items are the per-grain blocks, envelopes ride in meta, money is flagged as awarded', async () => {
    const { repo } = fakeAnalysisRepo();
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    const out = await tool.handler({ shape: 'stats', scope: { authorityCui: '4267117' } });
    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(3);
    const envelopes = (out.meta as { envelopes: readonly { policyKey: string }[] }).envelopes;
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0]?.policyKey).toContain('valueAwardedSum');
    // DA money is served → the summary must say awarded, not payments.
    expect(out.summary).toContain('awarded value, not payments');
  });

  it('omits the awarded-value note when NO money appears (all spend abstains)', async () => {
    const { repo } = fakeAnalysisRepo({
      // Estimated is its own basis now — abstain it too (no coverage rows) so
      // truly NO money appears in any block.
      basisCoverage: [],
      quality: {
        procedure: verdict({ spend: 'abstain' }),
        contract: verdict({ spend: 'abstain' }),
        direct_acquisition: verdict({ spend: 'abstain' }),
      },
    });
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    const out = await tool.handler({ shape: 'stats' });
    expect(out.ok).toBe(true);
    expect(out.summary).not.toContain('awarded value, not payments');
    expect(out.summary).toContain('spend answers abstain'); // the caveat is surfaced
  });

  it('semantically invalid combinations return the named rejection verbatim', async () => {
    const { repo } = fakeAnalysisRepo();
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    // A breakdown over a dimension the scope already fixes is a single bucket —
    // a backend-independent semantic rejection (not a rollup-capability gap).
    const out = await tool.handler({
      shape: 'breakdown',
      dimension: 'authority',
      scope: { authorityCui: '4267117' },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('breakdown(authority)');
    expect(out.error).toContain('single-bucket');
  });

  it('series requires a measure; breakdown requires a dimension', async () => {
    const { repo } = fakeAnalysisRepo();
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    expect((await tool.handler({ shape: 'series' })).error).toContain('requires a measure');
    expect((await tool.handler({ shape: 'breakdown' })).error).toContain('requires a dimension');
  });

  it('an unpublished package surfaces the clean error, not an empty answer', async () => {
    const { repo } = fakeAnalysisRepo({ generation: null });
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    const out = await tool.handler({ shape: 'stats' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('procurement analysis package not published');
  });
});
