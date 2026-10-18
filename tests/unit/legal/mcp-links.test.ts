/**
 * I-23: every MCP link must open a real client page. The tools used to build
 * `/legal/...` URLs (and `/links`, `/timeline`, `/documents/…` subroutes) that the
 * client does not serve; the client's surface is `/legislation/...`, with the
 * act page's `doc`/`nod` parameters and section anchors.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeMonitorulMcpTools } from '@/modules/legal/mo/mcp.js';
import { makeLegalMcpTools } from '@/modules/legal/shell/mcp/tools.js';

import type { LegalActsRepo, LegalGraphRepo } from '@/modules/legal/core/ports.js';
import type { MonitorulRepo } from '@/modules/legal/mo/ports.js';
import type { KernelMcpTool } from '@/modules/shared/index.js';

const BASE = 'https://transparenta.eu';
const ACT = { actId: '66150', displayCitation: 'Legea nr. 227/2015', status: 'modificat' };
const page = ok({ items: [], next: null });

const acts = {
  resolveActRef: async () => ok(ACT),
  findActById: async () => ok(ACT),
  resolveActCandidates: async () => ok([ACT]),
  getStatusEvents: async () => ok([]),
  countActsBy: async () => ok([]),
  listRecentChanges: async () => page,
  countRecentChanges: async () => ok(0),
} as unknown as LegalActsRepo;
const graph = {
  outgoingRefs: async () => page,
  incomingRefs: async () => page,
} as unknown as LegalGraphRepo;

const legalTools = makeLegalMcpTools({
  acts,
  graph,
  outline: {} as never,
  searchDeps: {} as never,
  resolveDeps: {} as never,
  clientBaseUrl: BASE,
});

const moRepo = {
  getPublicationsForAct: async () => ok([]),
  getStatusEventsForAct: async () => ok([]),
  getEdgesForTargetAct: async () => ok([]),
  listIssues: async () => ok({ items: [], total: 0 }),
  countPublicationsByIssuerYear: async () => ok({ rows: [], total: 0 }),
  getIssueYearRange: async () => ok({ min: 1990, max: 2026 }),
} as unknown as MonitorulRepo;
const moTools = makeMonitorulMcpTools({
  repo: moRepo,
  coverage: { yearRange: async () => ok({ min: 1990, max: 2026 }) },
  clientBaseUrl: BASE,
});

const run = async (
  tools: readonly KernelMcpTool[],
  name: string,
  args: Record<string, unknown>
): Promise<{ readonly link?: string; readonly ok: boolean }> => {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return await tool.handler(args);
};

describe('legal MCP links open client pages', () => {
  it('reference links go to the act page anchors, by direction', async () => {
    expect((await run(legalTools, 'get_legal_act_links', { actId: '66150' })).link).toBe(
      `${BASE}/legislation/acts/66150#act-references-in-heading`
    );
    expect(
      (await run(legalTools, 'get_legal_act_links', { actId: '66150', direction: 'out' })).link
    ).toBe(`${BASE}/legislation/acts/66150#act-references-out-heading`);
  });

  it('the timeline link goes to the act page timeline anchor', async () => {
    expect((await run(legalTools, 'get_legal_act_timeline', { actId: '66150' })).link).toBe(
      `${BASE}/legislation/acts/66150#act-timeline-heading`
    );
  });

  it('counts and recent changes go to the directory and the changes feed', async () => {
    expect((await run(legalTools, 'count_legal_acts', { groupBy: 'status' })).link).toBe(
      `${BASE}/legislation/acts`
    );
    expect((await run(legalTools, 'get_legal_recent_changes', {})).link).toBe(
      `${BASE}/legislation/changes`
    );
  });

  it('no legal tool output names a /legal route', async () => {
    for (const [name, args] of [
      ['get_legal_act_links', { actId: '66150' }],
      ['get_legal_act_links', { actId: '66150', direction: 'out' }],
      ['get_legal_act_timeline', { actId: '66150' }],
      ['count_legal_acts', { groupBy: 'status' }],
      ['get_legal_recent_changes', {}],
    ] as const) {
      const out = await run(legalTools, name, args);
      expect(out.link, name).toMatch(/^https:\/\/transparenta\.eu\/legislation(?:[/?#]|$)/);
    }
  });
});

describe('Monitorul MCP links open client pages', () => {
  it('act publication and timeline links go to the act page anchors', async () => {
    const pubs = await run(moTools, 'find_act_publications', { actId: '66150' });
    const timeline = await run(moTools, 'get_act_gazette_timeline', { actId: '66150' });
    expect(pubs.link).toBe(`${BASE}/legislation/acts/66150#act-publication-heading`);
    expect(timeline.link).toBe(`${BASE}/legislation/acts/66150#act-timeline-heading`);
  });

  it('gazette browse and count links go to the gazette page for that year', async () => {
    const issues = await run(moTools, 'browse_mo_issues', { year: 2026 });
    const counts = await run(moTools, 'count_mo_publications_by_issuer', {
      year: 2026,
      groupBy: 'issuer',
    });
    expect(issues.link).toBe(`${BASE}/legislation/gazette?year=2026`);
    expect(counts.link).toBe(`${BASE}/legislation/gazette?year=2026`);
  });
});
