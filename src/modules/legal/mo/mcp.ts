/**
 * Monitorul-Oficial (`mo/` area, plan 06) — MCP tools (§8). Each tool calls the
 * SAME usecase the GraphQL resolver calls (tri-surface equivalence, §14.7); output
 * is the kernel `{ ok, kind, query?, link?, item|items?, summary? }` object. The
 * `coverage` block rides under `item` (the kernel `McpToolOutput` has no top-level
 * coverage field — Codex #5).
 *
 * Two families (§6.3): discovery (`resolve_mo_filter`) + query (`find_act_publications`,
 * `get_act_gazette_timeline`, `browse_mo_issues`, `count_mo_publications_by_issuer`).
 * Count tools attach `denominator` + `coverage` + `confidence:'deterministic'`
 * (catalog Aggregate Accuracy Gate).
 */

import { z } from 'zod';

import {
  actLifecycle,
  browseIssues,
  issuerYearBreakdown,
  wherePublished,
  type MoCoverageDeps,
} from './usecases.js';

import type { MonitorulRepo, MoAggGroupBy } from './ports.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface MonitorulMcpDeps {
  readonly repo: MonitorulRepo;
  readonly coverage: MoCoverageDeps;
  readonly clientBaseUrl: string;
}

export const MO_MCP_KINDS = {
  resolve: 'mo_resolution',
  publications: 'mo_publications',
  timeline: 'mo_timeline',
  issues: 'mo_issues',
  aggregate: 'mo_aggregate',
} as const;

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};
const strArr = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const v = args[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
};
const errorOut = (kind: string, message: string): McpToolOutput => ({ ok: false, kind, error: message });
const num = (x: number): string => String(x);

export const makeMonitorulMcpTools = (deps: MonitorulMcpDeps): readonly KernelMcpTool[] => {
  const { repo, coverage, clientBaseUrl } = deps;
  const actGazetteLink = (actId: string, frag: string): string => `${clientBaseUrl}/legal/acts/${actId}#${frag}`;

  const resolveMoFilter: KernelMcpTool = {
    name: 'resolve_mo_filter',
    description:
      'Resolve a free-text Monitorul Oficial dimension to a filter value: mo_issuer (issuer name → issuer_slug) or mo_act_type (label → act_type). Use before the other MO tools.',
    inputShape: {
      dim: z.enum(['mo_issuer', 'mo_act_type']).describe('Dimension to resolve.'),
      q: z.string().describe('The free-text query (issuer name or act-type label).'),
      limit: z.number().int().min(1).max(20).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = str(args, 'dim');
      if (dim === undefined) return errorOut(MO_MCP_KINDS.resolve, 'dim is required');
      const q = str(args, 'q') ?? '';
      const limit = intArg(args, 'limit', 10);
      const res = dim === 'mo_act_type' ? await repo.resolveActType(q, limit) : await repo.resolveIssuer(q, limit);
      if (res.isErr()) return errorOut(MO_MCP_KINDS.resolve, res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: MO_MCP_KINDS.resolve,
        query: { dim, q },
        items: res.value,
        summary:
          `«${q}» → ${num(res.value.length)} match(es) as ${dim}` +
          (top !== undefined ? `; top: ${top.label} (${num(top.count ?? 0)} publications).` : '.'),
      };
    },
  };

  const findActPublications: KernelMcpTool = {
    name: 'find_act_publications',
    description:
      'MO-4: where/when a legal act was published in Monitorul Oficial. Resolve the act name → actId via the legal discovery tool first. Returns publication events + coverage.',
    inputShape: {
      actId: z.string().describe('The numeric legal.acts id (bigint as string).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const actId = str(args, 'actId');
      if (actId === undefined) return errorOut(MO_MCP_KINDS.publications, 'actId is required');
      const res = await wherePublished(repo, coverage, actId);
      if (res.isErr()) return errorOut(MO_MCP_KINDS.publications, res.error.message);
      const { publications, coverage: cov } = res.value;
      const first = publications[publications.length - 1];
      return {
        ok: true,
        kind: MO_MCP_KINDS.publications,
        query: { actId },
        link: actGazetteLink(actId, 'gazette'),
        items: publications,
        item: { publications, coverage: cov, confidence: 'deterministic' },
        summary:
          `Act ${actId} published ${num(publications.length)}× in MO` +
          (first?.actDate != null ? `; e.g. ${first.actDate}.` : '.'),
      };
    },
  };

  const getActGazetteTimeline: KernelMcpTool = {
    name: 'get_act_gazette_timeline',
    description:
      'LG-2/MO-3 (MO slice): the gazette-grounded lifecycle of an act — MO status events (promulgare/aprobare) + in-edges (respinge/rectifica/republica). Returns counts + coverage.',
    inputShape: {
      actId: z.string().describe('The numeric legal.acts id (bigint as string).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const actId = str(args, 'actId');
      if (actId === undefined) return errorOut(MO_MCP_KINDS.timeline, 'actId is required');
      const res = await actLifecycle(repo, coverage, actId);
      if (res.isErr()) return errorOut(MO_MCP_KINDS.timeline, res.error.message);
      const { statusEvents, inEdges, coverage: cov } = res.value;
      // §8.3: promulgare/aprobare from STATUS EVENTS; respinge/rectifica/republica from EDGES.
      const nPromulg = statusEvents.filter((e) => e.eventKind === 'promulgare').length;
      const nApprove = statusEvents.filter((e) => e.eventKind.startsWith('aprobare')).length;
      const nReject = inEdges.filter((e) => e.relation === 'respinge').length;
      const nRect = inEdges.filter((e) => e.relation === 'rectifica').length;
      return {
        ok: true,
        kind: MO_MCP_KINDS.timeline,
        query: { actId },
        link: actGazetteLink(actId, 'timeline'),
        item: { statusEvents, inEdges, coverage: cov, confidence: 'deterministic' },
        summary:
          `Act ${actId}: ${num(nPromulg)} promulgation + ${num(nApprove)} approval status event(s); ` +
          `${num(nReject)} rejection + ${num(nRect)} rectification edge(s) grounded in MO.`,
      };
    },
  };

  const browseMoIssues: KernelMcpTool = {
    name: 'browse_mo_issues',
    description:
      'Browse Monitorul Oficial gazette issues for a year (required). Optionally filter by part code and a publication-date range. Returns issues + coverage.',
    inputShape: {
      year: z.number().int().describe('Gazette year (required; bounds the scan).'),
      partCode: z.array(z.string()).optional().describe('Part codes: PI, PII, PIM, …'),
      dateFrom: z.string().optional().describe('Publication date from (YYYY-MM-DD).'),
      dateTo: z.string().optional().describe('Publication date to (YYYY-MM-DD).'),
      page: z.number().int().min(1).optional().describe('Page (default 1).'),
      pageSize: z.number().int().min(1).max(50).optional().describe('Page size (default 20, max 50).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const year = args['year'];
      if (typeof year !== 'number' || !Number.isFinite(year)) {
        return errorOut(MO_MCP_KINDS.issues, 'year is required');
      }
      const parts = strArr(args, 'partCode');
      const from = str(args, 'dateFrom');
      const to = str(args, 'dateTo');
      const filter: FilterInput = {
        year: { eq: Math.floor(year) },
        ...(parts !== undefined && parts.length > 0 && { partCode: { in: parts } }),
        ...((from !== undefined || to !== undefined) && {
          issueDate: { between: { ...(from !== undefined && { from }), ...(to !== undefined && { to }) } },
        }),
      };
      const res = await browseIssues(repo, coverage, filter, {
        page: intArg(args, 'page', 1),
        pageSize: Math.min(intArg(args, 'pageSize', 20), 50),
      }, 'issue_date_desc');
      if (res.isErr()) return errorOut(MO_MCP_KINDS.issues, res.error.message);
      return {
        ok: true,
        kind: MO_MCP_KINDS.issues,
        query: { year: Math.floor(year), partCode: parts },
        link: `${clientBaseUrl}/legal/mo-issues?year=${String(Math.floor(year))}`,
        items: res.value.items,
        item: { items: res.value.items, total: res.value.total, coverage: res.value.coverage },
        summary: `${num(res.value.total)} gazette issue(s) in ${String(Math.floor(year))}.`,
      };
    },
  };

  const countMoPublicationsByIssuer: KernelMcpTool = {
    name: 'count_mo_publications_by_issuer',
    description:
      'MO-1: deterministic count of gazette publications for a year, grouped by issuer / act_type / year. Returns counts + denominator + coverage (confidence: deterministic).',
    inputShape: {
      year: z.number().int().describe('Year (required; bounds the scan).'),
      issuerSlug: z.string().optional().describe('Restrict to one issuer slug.'),
      actType: z.array(z.string()).optional().describe('Restrict to act type(s).'),
      groupBy: z.enum(['issuer', 'act_type', 'year']).optional().describe('Grouping dimension (default issuer).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const year = args['year'];
      if (typeof year !== 'number' || !Number.isFinite(year)) {
        return errorOut(MO_MCP_KINDS.aggregate, 'year is required');
      }
      const issuerSlug = str(args, 'issuerSlug');
      const actType = strArr(args, 'actType');
      const groupBy = (str(args, 'groupBy') ?? 'issuer') as MoAggGroupBy;
      const res = await issuerYearBreakdown(repo, coverage, {
        year: Math.floor(year),
        ...(issuerSlug !== undefined && { issuerSlug }),
        ...(actType !== undefined && { actType }),
        groupBy,
      });
      if (res.isErr()) return errorOut(MO_MCP_KINDS.aggregate, res.error.message);
      const { items, denominator, coverage: cov } = res.value;
      const top = items[0];
      return {
        ok: true,
        kind: MO_MCP_KINDS.aggregate,
        query: { year: Math.floor(year), issuerSlug, groupBy },
        link: `${clientBaseUrl}/legal/mo-publications?year=${String(Math.floor(year))}`,
        items,
        item: { items, denominator, coverage: cov, confidence: 'deterministic' },
        summary:
          `${num(denominator)} publication(s) in ${String(Math.floor(year))} (${groupBy})` +
          (top !== undefined ? `; top: ${top.issuerSlug ?? top.actType ?? String(top.year)} (${num(top.count)}).` : '.'),
      };
    },
  };

  return [resolveMoFilter, findActPublications, getActGazetteTimeline, browseMoIssues, countMoPublicationsByIssuer];
};
