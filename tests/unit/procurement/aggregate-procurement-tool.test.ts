/**
 * The `aggregate_procurement` MCP tool + the re-plumbed
 * `get_procurement_concentration`: same executors as GraphQL, envelopes ride in
 * `meta`, the summary ALWAYS says "awarded value, not payments" when money
 * appears, and matrix rejections surface verbatim. Tool NAMES stay stable.
 */

import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';

import { fakeAnalysisRepo, verdict } from './analysis-fakes.js';

import type {
  AnalysisRepo,
  ProcurementAggregateRepo,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type { KernelMcpTool } from '@/modules/shared/index.js';

// The analysis tools never touch the entity/aggregate repos — inert stubs suffice.
const unusedRepo = {} as unknown as ProcurementRepo;
const unusedAggregate = {} as unknown as ProcurementAggregateRepo;

const toolsWith = (analysis: AnalysisRepo): readonly KernelMcpTool[] =>
  makeProcurementMcpTools({
    repo: unusedRepo,
    aggregate: unusedAggregate,
    analysis,
    clientBaseUrl: 'https://transparenta.eu',
  });

const toolNamed = (tools: readonly KernelMcpTool[], name: string): KernelMcpTool => {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
};

describe('tool registry', () => {
  it('keeps the 9 stable names and adds exactly aggregate_procurement', () => {
    const names = toolsWith(fakeAnalysisRepo().repo).map((t) => t.name);
    expect(names).toEqual([
      'resolve_procurement_filter',
      'search_procurement_contracts',
      'search_procurement_direct_acquisitions',
      'rank_procurement_suppliers',
      'rank_procurement_authorities',
      'get_procurement_concentration',
      'get_procurement_authority_cpv_spend',
      'find_same_day_da_candidates',
      'get_procurement_grain_quality',
      'aggregate_procurement',
    ]);
  });
});

describe('aggregate_procurement', () => {
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

  it('unsupported combinations return the matrix rejection verbatim', async () => {
    const { repo } = fakeAnalysisRepo();
    const tool = toolNamed(toolsWith(repo), 'aggregate_procurement');
    const out = await tool.handler({
      shape: 'breakdown',
      dimension: 'procedureType',
      scope: { supplierCui: '11805367' },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('breakdown(procedureType)');
    expect(out.error).toContain('not built');
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

describe('get_procurement_concentration stays on the UNTOUCHED legacy MV path (S6)', () => {
  const legacyGate = {
    grain: 'direct_acquisition' as const,
    rowsCount: '1000',
    authorityCuiCoverageRate: 1,
    supplierCuiCoverageRate: 1,
    amountCoverageRate: 1,
    cpvCoverageRate: 1,
    dateCoverageRate: 1,
    authorityTerritoryCoverageRate: 0,
    filterAnswersAllowed: true,
    spendRankingsAllowed: true,
    supplierRegionFiltersAllowed: false,
    blockers: [],
    refreshedAt: '2026-06-29T07:26:59Z',
    projectionVersion: 'test-v1',
  };
  const legacyConcentration = {
    authorityCui: '4267117',
    grain: 'direct_acquisition' as const,
    supplierCount: 3,
    basis: 'value' as const,
    top1Share: 0.6,
    top5Share: 1,
    hhi: 0.52,
    totalRon: '1000',
    caveats: [],
  };
  const legacyCalls: unknown[][] = [];
  const legacyAggregate = {
    grainQuality: () => Promise.resolve(ok([legacyGate])),
    supplierConcentration: (...args: unknown[]) => {
      legacyCalls.push(args);
      return Promise.resolve(ok(legacyConcentration));
    },
  } as unknown as ProcurementAggregateRepo;

  it('serves the pre-analysis output shape from the MV usecase — no envelope, no analysis read', async () => {
    const analysis = fakeAnalysisRepo();
    const tools = makeProcurementMcpTools({
      repo: unusedRepo,
      aggregate: legacyAggregate,
      analysis: analysis.repo,
      clientBaseUrl: 'https://transparenta.eu',
    });
    const out = await toolNamed(tools, 'get_procurement_concentration').handler({
      authorityCui: '4267117',
    });
    expect(out.ok).toBe(true);
    expect(out.item).toEqual(legacyConcentration); // byte-identical legacy view model
    expect(out.meta).toBeUndefined(); // the legacy tool carries no analysis envelope
    expect(legacyCalls).toHaveLength(1);
    expect(analysis.calls).toHaveLength(0); // never touches the analysis rollups
  });

  it('requires authorityCui, exactly as before', async () => {
    const tools = makeProcurementMcpTools({
      repo: unusedRepo,
      aggregate: legacyAggregate,
      analysis: fakeAnalysisRepo().repo,
      clientBaseUrl: 'https://transparenta.eu',
    });
    const out = await toolNamed(tools, 'get_procurement_concentration').handler({});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('authorityCui is required');
  });
});
